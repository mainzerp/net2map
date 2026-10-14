"""Security review fixes: DB-backed revocation, refresh chain, mandatory secrets,
plaintext secret migration, strict audit, password bounds, pagination, settings
and the FK delete rules of migration 029."""
import importlib.util
import time
import uuid
from pathlib import Path
from unittest.mock import patch

import jwt as pyjwt
import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient
from pydantic import ValidationError

import shared.auth as shared_auth
from database import AuditLog, Base, Credential, Endpoint, SnmpProfile, User
from shared.auth import DUMMY_PASSWORD_HASH, JWT_ALGORITHM, JWT_SECRET, create_token, hash_password

BACKEND = Path(__file__).resolve().parent.parent


class FakeRedis:
    def __init__(self):
        self._store = {}

    def set(self, key, value, ex=None, nx=False, **kwargs):
        self._store[key] = value
        return True

    def get(self, key):
        return self._store.get(key)

    def exists(self, key):
        return 1 if key in self._store else 0


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    import routers.auth as _auth
    import routers.settings as _settings
    _auth.limiter.reset()
    _settings.limiter.reset()
    yield
    _auth.limiter.reset()
    _settings.limiter.reset()


def _user(db, username="alice", role="viewer", password=None):
    user = User(username=username, email="", role=role, is_active=True,
                hashed_pw=hash_password(password) if password else DUMMY_PASSWORD_HASH)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _headers(user):
    return {"Authorization": f"Bearer {create_token(user.id, user.username, user.role)}"}


def _raw_token(user, **claims):
    now = int(time.time())
    payload = {"sub": str(user.id), "username": user.username, "role": user.role,
               "jti": str(uuid.uuid4()), "iat": now, "exp": now + 3600}
    payload.update(claims)
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


# -- DB-backed revocation ------------------------------------------------------

def test_token_issued_right_after_revocation_is_valid(client, db):
    user = _user(db)
    old = _headers(user)
    assert shared_auth.blacklist_all_user_tokens(user.id)
    time.sleep(0.05)  # step past the clock tick (Windows clock granularity is ~16 ms)
    new = _headers(user)  # same second as the revocation
    assert client.get("/api/auth/me", headers=old).status_code == 401
    assert client.get("/api/auth/me", headers=new).status_code == 200


def test_tokens_of_unknown_or_inactive_users_are_rejected(client, db):
    ghost = User(id=999, username="ghost", role="admin")
    assert client.get("/api/auth/me", headers=_headers(ghost)).status_code == 401
    user = _user(db)
    user.is_active = False
    db.commit()
    assert client.get("/api/auth/me", headers=_headers(user)).status_code == 401


def test_revocation_cache_bounds_cross_process_staleness(db):
    """Another process' revocation (direct DB write) is seen once the cache entry expires."""
    user = _user(db)
    iat_ms = shared_auth._now_ms()
    assert shared_auth._is_user_revoked(user.id, iat_ms // 1000, iat_ms, db) is False
    db.query(User).filter(User.id == user.id).update({User.revoked_before_ms: iat_ms + 1})
    db.commit()
    # Still cached within EPOCH_CACHE_TTL_SECONDS ...
    assert shared_auth._is_user_revoked(user.id, iat_ms // 1000, iat_ms, db) is False
    later = time.monotonic() + shared_auth.EPOCH_CACHE_TTL_SECONDS + 1
    with patch("shared.auth.time.monotonic", return_value=later):
        assert shared_auth._is_user_revoked(user.id, iat_ms // 1000, iat_ms, db) is True


def test_legacy_token_without_iat_ms_uses_second_granularity(db):
    user = _user(db)
    now = int(time.time())
    db.query(User).filter(User.id == user.id).update({User.revoked_before_ms: now * 1000 + 500})
    db.commit()
    assert shared_auth._is_user_revoked(user.id, now, None, db) is True
    assert shared_auth._is_user_revoked(user.id, now + 1, None, db) is False


def test_revoke_all_unknown_user_is_404(client, jwt_headers):
    r = client.post("/api/auth/revoke-all", json={"user_id": 4242}, headers=jwt_headers)
    assert r.status_code == 404


# -- Refresh chain -------------------------------------------------------------

def test_refresh_blacklists_consumed_token_and_keeps_auth_time(client, db):
    user = _user(db)
    auth_time = int(time.time()) - 3600
    token = _raw_token(user, auth_time=auth_time)
    fake = FakeRedis()
    with patch("shared.redis_client.get_redis", return_value=fake):
        r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        new_payload = pyjwt.decode(r.json()["access_token"], JWT_SECRET, algorithms=[JWT_ALGORITHM])
        assert new_payload["auth_time"] == auth_time
        again = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert again.status_code == 401
    assert again.json()["error"]["code"] == "AUTH_REVOKED"


def test_refresh_rejected_after_max_session_lifetime(client, db):
    user = _user(db)
    old_login = int(time.time()) - shared_auth.MAX_SESSION_SECONDS - 10
    token = _raw_token(user, auth_time=old_login)
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_SESSION_EXPIRED"


def test_refresh_of_pre_upgrade_token_uses_iat_as_auth_time(client, db):
    user = _user(db)
    iat = int(time.time()) - 100
    token = _raw_token(user, iat=iat)  # no auth_time / iat_ms claims
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    payload = pyjwt.decode(r.json()["access_token"], JWT_SECRET, algorithms=[JWT_ALGORITHM])
    assert payload["auth_time"] == iat

    stale = _raw_token(user, iat=int(time.time()) - shared_auth.MAX_SESSION_SECONDS - 10)
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {stale}"})
    assert r.status_code == 401


# -- Mandatory secrets ---------------------------------------------------------

def _settings(**overrides):
    from config import Settings
    values = {"jwt_secret": "s", "encryption_key": "lwkSAQ_FAqRpXGylt2AyEJxT3o_OUR8hYap9ovksuW4=",
              "default_admin_password": "Strong-Pass-1"}
    values.update(overrides)
    return Settings(**values)


def test_validate_required_settings_accepts_complete_config():
    from config import validate_required_settings
    validate_required_settings(_settings())


@pytest.mark.parametrize("overrides, needle", [
    ({"jwt_secret": ""}, "JWT_SECRET"),
    ({"encryption_key": ""}, "ENCRYPTION_KEY is not set"),
    ({"encryption_key": "not-a-key"}, "not a valid Fernet key"),
    ({"default_admin_password": "changeme"}, "DEFAULT_ADMIN_PASSWORD"),
    ({"default_admin_password": ""}, "DEFAULT_ADMIN_PASSWORD"),
])
def test_validate_required_settings_rejects_insecure_config(overrides, needle):
    from config import validate_required_settings
    with pytest.raises(RuntimeError, match=needle):
        validate_required_settings(_settings(**overrides))


def test_startup_aborts_without_jwt_secret():
    from config import settings
    from main import app
    with patch.object(settings, "jwt_secret", ""):
        with pytest.raises(RuntimeError, match="JWT_SECRET"):
            with TestClient(app):
                pass


# -- Plaintext secret migration -----------------------------------------------

def test_encrypt_plaintext_secrets_is_idempotent(db):
    from shared.crypto import decrypt, encrypt, is_encrypted
    from shared.secrets import encrypt_plaintext_secrets

    already = encrypt("enc-secret")
    db.add(Credential(label="C", ip="10.9.0.1", community="plain-comm", v3_auth_password=already, v3_priv_password=""))
    db.add(SnmpProfile(label="P", community="plain-prof", v3_priv_password="gAAAAAforeign-key-token"))
    db.commit()

    assert encrypt_plaintext_secrets(db) == 2
    cred = db.query(Credential).one()
    prof = db.query(SnmpProfile).one()
    assert is_encrypted(cred.community) and decrypt(cred.community) == "plain-comm"
    assert cred.v3_auth_password == already
    assert cred.v3_priv_password == ""
    assert decrypt(prof.community) == "plain-prof"
    # Looks like a token for another key: never double-encrypted.
    assert prof.v3_priv_password == "gAAAAAforeign-key-token"
    assert encrypt_plaintext_secrets(db) == 0


# -- Strict audit --------------------------------------------------------------

def _failing_client():
    from main import app
    return TestClient(app, raise_server_exceptions=False)


def test_user_update_rolled_back_when_audit_fails(client, db, jwt_headers):
    user = _user(db, "audited")
    with patch("database.AuditLog", side_effect=RuntimeError("audit store down")):
        r = _failing_client().put(f"/api/users/{user.id}", json={"role": "operator"}, headers=jwt_headers)
    assert r.status_code == 500
    db.rollback()  # what get_db's session close does in production
    db.refresh(user)
    assert user.role == "viewer"
    assert user.revoked_before_ms == 0


def test_user_create_rolled_back_when_audit_fails(client, db, jwt_headers):
    with patch("database.AuditLog", side_effect=RuntimeError("audit store down")):
        r = _failing_client().post("/api/users", json={"username": "newbie", "password": "Password123"},
                                   headers=jwt_headers)
    assert r.status_code == 500
    db.rollback()
    assert db.query(User).filter(User.username == "newbie").first() is None


def test_credential_change_and_audit_share_transaction(client, db, auth_headers):
    r = client.post("/api/credentials", json={"label": "SW", "ip": "10.0.0.7"}, headers=auth_headers)
    assert r.status_code == 201
    cred_id = r.json()["id"]
    assert db.query(AuditLog).filter(AuditLog.resource == "credential").count() == 1
    with patch("database.AuditLog", side_effect=RuntimeError("audit store down")):
        r = _failing_client().put(f"/api/credentials/{cred_id}", json={"label": "Changed"}, headers=auth_headers)
    assert r.status_code == 500
    db.rollback()
    assert db.get(Credential, cred_id).label == "SW"


def test_lenient_audit_failure_does_not_fail_request(client, db, auth_headers):
    with patch("database.AuditLog", side_effect=RuntimeError("audit store down")):
        r = client.put("/api/settings/map_opacity", json={"value": "0.5"}, headers=auth_headers)
    assert r.status_code == 200


def test_strict_audit_requires_session():
    from starlette.requests import Request

    from shared.audit import log_audit
    request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})
    with pytest.raises(ValueError):
        log_audit(request, "x", "y", strict=True)


# -- Password length (bcrypt 72-byte limit) -------------------------------------

def test_login_with_overlong_password_is_401(client, db):
    _user(db, "longpw", password="Password123")
    r = client.post("/api/auth/login", json={"username": "longpw", "password": "x" * 100})
    assert r.status_code == 401
    r = client.post("/api/auth/login", json={"username": "nobody", "password": "x" * 100})
    assert r.status_code == 401


def test_login_with_absurd_password_is_422(client):
    r = client.post("/api/auth/login", json={"username": "a", "password": "x" * 5000})
    assert r.status_code == 422


def test_new_passwords_must_fit_bcrypt():
    from schemas import UserCreate, UserUpdate
    with pytest.raises(ValidationError):
        UserCreate(username="u", password="x" * 73)
    with pytest.raises(ValidationError):
        UserUpdate(password="\u00e4" * 37)  # 74 bytes in UTF-8
    assert UserCreate(username="u", password="x" * 72).password == "x" * 72


def test_create_user_with_overlong_password_is_422(client, jwt_headers):
    r = client.post("/api/users", json={"username": "u2", "password": "x" * 80}, headers=jwt_headers)
    assert r.status_code == 422


# -- Import size bounds ----------------------------------------------------------

def test_import_payloads_are_bounded():
    from schemas import IMPORT_DATA_MAX_LENGTH, BulkImportRequest, GlobalConfigImportRequest
    too_big = "x" * (IMPORT_DATA_MAX_LENGTH + 1)
    for model in (BulkImportRequest, GlobalConfigImportRequest):
        with pytest.raises(ValidationError):
            model(data=too_big)
        assert model(data="[]").data == "[]"


# -- Endpoint pagination ---------------------------------------------------------

def test_endpoint_list_pagination_and_etag(client, db, auth_headers):
    for i in range(5):
        db.add(Endpoint(mac=f"aa:bb:cc:dd:ee:0{i}"))
    db.commit()

    full = client.get("/api/endpoints", headers=auth_headers)
    assert [e["mac"] for e in full.json()] == [f"aa:bb:cc:dd:ee:0{i}" for i in range(5)]
    assert "x-total-count" not in full.headers

    page = client.get("/api/endpoints?limit=2&offset=1", headers=auth_headers)
    assert [e["mac"] for e in page.json()] == ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"]
    assert page.headers["x-total-count"] == "5"
    assert page.headers["etag"] != full.headers["etag"]

    other = client.get("/api/endpoints?limit=2&offset=3", headers=auth_headers)
    assert other.headers["etag"] != page.headers["etag"]

    cached = client.get("/api/endpoints?limit=2&offset=1",
                        headers={**auth_headers, "If-None-Match": page.headers["etag"]})
    assert cached.status_code == 304
    mismatch = client.get("/api/endpoints?limit=2&offset=3",
                          headers={**auth_headers, "If-None-Match": page.headers["etag"]})
    assert mismatch.status_code == 200

    assert client.get("/api/endpoints?limit=0", headers=auth_headers).status_code == 422


# -- endpoint_retention_days setting ----------------------------------------------

def test_endpoint_retention_days_setting(client, auth_headers):
    rows = {s["key"]: s["value"] for s in client.get("/api/v1/settings", headers=auth_headers).json()}
    assert rows["endpoint_retention_days"] == "30"
    for value, expected in (("0", "0"), (" 3650 ", "3650"), ("7", "7")):
        r = client.put("/api/v1/settings/endpoint_retention_days", json={"value": value}, headers=auth_headers)
        assert r.status_code == 200
        assert r.json()["value"] == expected
    for bad in ("-1", "3651", "abc", "1.5"):
        r = client.put("/api/v1/settings/endpoint_retention_days", json={"value": bad}, headers=auth_headers)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "INVALID_SETTING_VALUE"
    r = client.put("/api/v1/settings", json={"endpoint_retention_days": "90"}, headers=auth_headers)
    assert r.status_code == 200


# -- FK delete rules / migration 029 ----------------------------------------------

def test_model_fk_delete_rules_match_migration_029():
    def ondelete(table, column):
        (fk,) = Base.metadata.tables[table].c[column].foreign_keys
        return fk.ondelete

    assert ondelete("devices", "rack_id") == "SET NULL"
    assert ondelete("devices", "class_id") == "SET NULL"
    assert ondelete("devices", "model_id") == "SET NULL"
    assert ondelete("credentials", "profile_id") == "SET NULL"
    assert ondelete("ports", "device_id") == "CASCADE"
    assert ondelete("scan_run_switch_metrics", "scan_run_id") == "CASCADE"


def test_migration_029_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location(
        "_mig029", BACKEND / "alembic" / "versions" / "029_fk_set_null_token_revocation.py"
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "029" and mig.down_revision == "028"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR NOT NULL)"))
        conn.execute(sa.text("INSERT INTO users (id, username) VALUES (1, 'admin')"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        cols = {c["name"]: c for c in sa.inspect(conn).get_columns("users")}
        assert cols["revoked_before_ms"]["nullable"] is False
        assert conn.execute(sa.text("SELECT revoked_before_ms FROM users")).scalar() == 0
        mig.downgrade()
        assert "revoked_before_ms" not in {c["name"] for c in sa.inspect(conn).get_columns("users")}


def test_db_level_delete_rules(db):
    """With FK enforcement the database itself nulls / cascades (no ORM help)."""
    from database import Device, Port, Rack

    db.execute(sa.text("PRAGMA foreign_keys = ON"))
    try:
        rack = Rack(label="R1")
        db.add(rack)
        db.flush()
        dev = Device(ip="10.8.0.1", sys_name="sw", rack_id=rack.id)
        db.add(dev)
        db.flush()
        db.add(Port(device_id=dev.id, if_index=1, if_descr="ge1"))
        db.commit()
        dev_id = dev.id
        db.execute(sa.text("DELETE FROM racks"))
        db.commit()
        assert db.execute(sa.text("SELECT rack_id FROM devices WHERE id = :i"), {"i": dev_id}).scalar() is None
        db.execute(sa.text("DELETE FROM devices"))
        db.commit()
        assert db.execute(sa.text("SELECT COUNT(*) FROM ports")).scalar() == 0
    finally:
        db.execute(sa.text("PRAGMA foreign_keys = OFF"))
        db.commit()


# -- endpoint_retention_days via /scan-settings ------------------------------------

def test_scan_settings_expose_endpoint_retention_days(client, auth_headers):
    r = client.get("/api/scan-settings", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["endpoint_retention_days"] == 30

    r = client.put("/api/scan-settings", json={"max_workers": 4, "endpoint_retention_days": 90}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["endpoint_retention_days"] == 90
    rows = {s["key"]: s["value"] for s in client.get("/api/v1/settings", headers=auth_headers).json()}
    assert rows["endpoint_retention_days"] == "90"

    # Omitting the field keeps the stored value; out-of-range values are clamped.
    r = client.put("/api/scan-settings", json={"max_workers": 6}, headers=auth_headers)
    assert r.json()["endpoint_retention_days"] == 90
    r = client.put("/api/scan-settings", json={"endpoint_retention_days": 99999}, headers=auth_headers)
    assert r.json()["endpoint_retention_days"] == 3650

    # A value written through the generic settings API is read back here.
    client.put("/api/v1/settings/endpoint_retention_days", json={"value": "0"}, headers=auth_headers)
    assert client.get("/api/scan-settings", headers=auth_headers).json()["endpoint_retention_days"] == 0
    from shared.file_settings import _read_db_setting
    assert _read_db_setting("endpoint_retention_days", "30") == "0"


# -- WebSocket revocation precision -------------------------------------------------

def test_ws_auth_uses_iat_ms_precision(db):
    """A WebSocket JWT issued right after a revocation (same second) stays valid."""
    from fastapi import WebSocketException

    from routers.ws import _validate_ws_credential

    user = _user(db, "wsuser")
    old = create_token(user.id, user.username, user.role)
    assert shared_auth.blacklist_all_user_tokens(user.id)
    time.sleep(0.05)  # step past the clock tick (Windows clock granularity is ~16 ms)
    new = create_token(user.id, user.username, user.role)
    with patch("shared.redis_client.get_redis", return_value=None):
        _validate_ws_credential(new)
        with pytest.raises(WebSocketException) as exc:
            _validate_ws_credential(old)
    assert exc.value.code == 1008
