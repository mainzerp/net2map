"""Tests for the credentials CRUD endpoints."""
import pytest


# Disable slowapi rate-limiting during tests by resetting limiter storage
@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    import routers.credentials as _c
    _c.limiter.reset()
    yield
    _c.limiter.reset()


def test_create_credential(client, auth_headers):
    payload = {"label": "Switch-1", "ip": "10.0.0.1", "community": "public"}
    r = client.post("/api/credentials", json=payload, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["label"] == "Switch-1"
    assert data["ip"] == "10.0.0.1"
    assert "id" in data


def test_duplicate_ip_rejected(client, auth_headers):
    payload = {"label": "Switch-1", "ip": "10.0.0.1"}
    client.post("/api/credentials", json=payload, headers=auth_headers)
    r = client.post("/api/credentials", json=payload, headers=auth_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "CREDENTIAL_IP_PRIORITY_EXISTS"


def test_list_credentials(client, auth_headers):
    client.post("/api/credentials", json={"label": "A", "ip": "10.0.0.1"}, headers=auth_headers)
    client.post("/api/credentials", json={"label": "B", "ip": "10.0.0.2"}, headers=auth_headers)
    r = client.get("/api/credentials", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_update_credential(client, auth_headers):
    r = client.post("/api/credentials", json={"label": "Old", "ip": "10.0.0.1"}, headers=auth_headers)
    cred_id = r.json()["id"]
    r = client.put(f"/api/credentials/{cred_id}", json={"label": "New"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["label"] == "New"


def test_delete_credential(client, auth_headers):
    r = client.post("/api/credentials", json={"label": "Del", "ip": "10.0.0.1"}, headers=auth_headers)
    cred_id = r.json()["id"]
    r = client.delete(f"/api/credentials/{cred_id}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get("/api/credentials", headers=auth_headers)
    assert len(r.json()) == 0


def test_update_nonexistent_credential(client, auth_headers):
    r = client.put("/api/credentials/999", json={"label": "Ghost"}, headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "CREDENTIAL_NOT_FOUND"


def test_delete_nonexistent_credential(client, auth_headers):
    r = client.delete("/api/credentials/999", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "CREDENTIAL_NOT_FOUND"


# ---------------------------------------------------------------------------
# Secret masking (mask sentinel "***" in API responses)
# ---------------------------------------------------------------------------

def test_credentials_mask_secrets_in_response(client, auth_headers):
    """Community and v3 passwords are masked with '***' in API responses."""
    r = client.post("/api/credentials", json={
        "label": "Mask", "ip": "10.9.0.1", "community": "topsecret",
        "v3_auth_password": "authpw", "v3_priv_password": "privpw",
    }, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["community"] == "***"
    assert data["v3_auth_password"] == "***"
    assert data["v3_priv_password"] == "***"

    r = client.get("/api/credentials", headers=auth_headers)
    row = [c for c in r.json() if c["ip"] == "10.9.0.1"][0]
    assert row["community"] == "***"
    assert row["v3_auth_password"] == "***"
    assert row["v3_priv_password"] == "***"


def test_update_credential_mask_sentinels_keep_stored_values(client, auth_headers, db):
    """PUT with mask sentinels must not overwrite stored secrets."""
    from database import Credential
    r = client.post("/api/credentials", json={
        "label": "Keep", "ip": "10.9.0.2", "community": "topsecret",
        "v3_auth_password": "authpw", "v3_priv_password": "privpw",
    }, headers=auth_headers)
    cred_id = r.json()["id"]

    r = client.put(f"/api/credentials/{cred_id}", json={
        "label": "Renamed",
        "community": "***",
        "v3_auth_password": "********",
        "v3_priv_password": "***",
    }, headers=auth_headers)
    assert r.status_code == 200

    db.expire_all()
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    assert cred.label == "Renamed"
    assert cred.community == "topsecret"
    assert cred.v3_auth_password == "authpw"
    assert cred.v3_priv_password == "privpw"


def test_update_credential_applies_real_secret_values(client, auth_headers, db):
    """PUT with real values updates the stored secrets."""
    from database import Credential
    r = client.post("/api/credentials", json={
        "label": "Real", "ip": "10.9.0.3", "community": "old",
    }, headers=auth_headers)
    cred_id = r.json()["id"]

    r = client.put(f"/api/credentials/{cred_id}", json={"community": "newcomm"}, headers=auth_headers)
    assert r.status_code == 200

    db.expire_all()
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    assert cred.community == "newcomm"


def test_create_credential_normalizes_mask_sentinels(client, auth_headers, db):
    """POST with mask sentinels stores empty strings, never the mask itself."""
    from database import Credential
    r = client.post("/api/credentials", json={
        "label": "Norm", "ip": "10.9.0.4",
        "community": "***", "v3_auth_password": "********", "v3_priv_password": "***",
    }, headers=auth_headers)
    assert r.status_code == 201

    cred = db.query(Credential).filter(Credential.ip == "10.9.0.4").first()
    assert cred.community == ""
    assert cred.v3_auth_password == ""
    assert cred.v3_priv_password == ""
