"""Tests for review hardening: credential update IP validation, CSV formula
injection neutralization and logout token semantics."""
import csv
import io
import time
from unittest.mock import patch

import jwt as pyjwt
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from database import Credential
from routers.auth import logout_token
from routers.bulk import _csv_escape_cell, _csv_unescape_cell, _serialize_bulk_rows
from shared.auth import JWT_ALGORITHM, JWT_SECRET


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    import routers.credentials as _c
    _c.limiter.reset()
    yield
    _c.limiter.reset()


# -- Credential update IP validation ------------------------------------------

def _create_cred(client, auth_headers, ip="10.0.0.1"):
    r = client.post("/api/credentials", json={"label": "SW", "ip": ip}, headers=auth_headers)
    assert r.status_code == 201
    return r.json()["id"]


@pytest.mark.parametrize("bad_ip", ["", "   ", "10.0.0.1; rm -rf /", "10.0.0.1 10.0.0.2",
                                    "a|b", "a&b", "`id`", "$(id)", None])
def test_update_credential_rejects_invalid_ip(client, auth_headers, bad_ip):
    cred_id = _create_cred(client, auth_headers)
    r = client.put(f"/api/credentials/{cred_id}", json={"ip": bad_ip}, headers=auth_headers)
    assert r.status_code == 422
    r = client.get("/api/credentials", headers=auth_headers)
    assert r.json()[0]["ip"] == "10.0.0.1"


@pytest.mark.parametrize("good_ip", ["10.0.0.9", "10.0.0.0/24", "10.0.0.1-10.0.0.20",
                                     "10.0.0.*", "switch01.example.com"])
def test_update_credential_accepts_same_forms_as_create(client, auth_headers, good_ip):
    cred_id = _create_cred(client, auth_headers)
    r = client.put(f"/api/credentials/{cred_id}", json={"ip": f"  {good_ip} "}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["ip"] == good_ip
    # The create schema accepts the identical form.
    r = client.post("/api/credentials", json={"label": "X", "ip": good_ip, "priority": 5},
                    headers=auth_headers)
    assert r.status_code == 201


def test_update_credential_without_ip_keeps_ip(client, auth_headers):
    cred_id = _create_cred(client, auth_headers, ip="10.0.0.7")
    r = client.put(f"/api/credentials/{cred_id}", json={"label": "Renamed"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["ip"] == "10.0.0.7"
    assert r.json()["label"] == "Renamed"


# -- CSV formula injection ----------------------------------------------------

@pytest.mark.parametrize("value", ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1)",
                                   "\tTAB", "\rCR"])
def test_csv_escape_prefixes_formula_cells(value):
    assert _csv_escape_cell(value) == "'" + value
    assert _csv_unescape_cell(_csv_escape_cell(value)) == value


@pytest.mark.parametrize("value", ["plain", "", "10.0.0.1", "it's", "'quoted", "'=already", "''+x"])
def test_csv_escape_round_trips_strings(value):
    assert _csv_unescape_cell(_csv_escape_cell(value)) == value


@pytest.mark.parametrize("value", [-5, 0, 161, True, False, None])
def test_csv_escape_leaves_non_strings_untouched(value):
    assert _csv_escape_cell(value) is value


def test_serialize_csv_neutralizes_and_keeps_numbers():
    rows = [{"label": "=HYPERLINK(\"http://x\")", "ip": "10.0.0.1", "priority": -1,
             "snmp_port": 161, "enabled": True, "v3_username": "@admin"}]
    out = _serialize_bulk_rows("credentials", rows, "csv")
    parsed = list(csv.DictReader(io.StringIO(out)))[0]
    assert parsed["label"] == "'=HYPERLINK(\"http://x\")"
    assert parsed["v3_username"] == "'@admin"
    assert parsed["priority"] == "-1"
    assert parsed["snmp_port"] == "161"


def test_bulk_csv_export_import_round_trip(client, auth_headers, db):
    db.add(Credential(label="=EVIL()", ip="10.5.0.1", priority=0,
                      v3_username="-user", community="", v3_auth_password="", v3_priv_password=""))
    db.commit()
    r = client.get("/api/bulk-export/credentials?fmt=csv", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()["data"]
    assert "'=EVIL()" in data
    assert "'-user" in data

    db.query(Credential).delete()
    db.commit()
    r = client.post("/api/bulk-import/credentials",
                    json={"format": "csv", "data": data, "dry_run": False},
                    headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["inserted"] == 1
    cred = db.query(Credential).filter(Credential.ip == "10.5.0.1").first()
    assert cred.label == "=EVIL()"
    assert cred.v3_username == "-user"


# -- Logout semantics ---------------------------------------------------------

def _request(token=None):
    headers = []
    if token is not None:
        headers.append((b"authorization", f"Bearer {token}".encode()))
    return Request({"type": "http", "method": "POST", "path": "/api/auth/logout",
                    "headers": headers, "query_string": b""})


def test_logout_garbage_token_returns_401(client):
    r = client.post("/api/auth/logout", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


def test_logout_handler_rejects_malformed_token():
    for token in ("not-a-jwt", "", "a.b.c"):
        with pytest.raises(HTTPException) as exc:
            logout_token(_request(token))
        assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        logout_token(_request(None))
    assert exc.value.status_code == 401


def test_logout_handler_rejects_wrong_signature():
    token = pyjwt.encode({"sub": "1", "jti": "x", "exp": int(time.time()) + 60},
                         "other-secret-other-secret-other-secret", algorithm=JWT_ALGORITHM)
    with pytest.raises(HTTPException) as exc:
        logout_token(_request(token))
    assert exc.value.status_code == 401


def test_logout_handler_expired_token_is_idempotent_success():
    token = pyjwt.encode({"sub": "1", "jti": "old", "exp": int(time.time()) - 10},
                         JWT_SECRET, algorithm=JWT_ALGORITHM)
    with patch("routers.auth.blacklist_token") as mock_bl:
        assert logout_token(_request(token)) == {"status": "ok"}
        mock_bl.assert_not_called()


def test_logout_handler_repeated_logout_is_idempotent():
    token = pyjwt.encode({"sub": "1", "jti": "again", "exp": int(time.time()) + 60},
                         JWT_SECRET, algorithm=JWT_ALGORITHM)
    with patch("routers.auth.blacklist_token", return_value=True) as mock_bl:
        assert logout_token(_request(token)) == {"status": "ok"}
        assert logout_token(_request(token)) == {"status": "ok"}
        assert mock_bl.call_count == 2
