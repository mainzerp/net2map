"""Tests for the SNMP profiles CRUD endpoints, focused on secret masking."""
from database import SnmpProfile


def test_create_and_list_snmp_profiles(client, auth_headers):
    r = client.post("/api/snmp-profiles", json={"label": "Prof-A"}, headers=auth_headers)
    assert r.status_code == 201
    r = client.get("/api/snmp-profiles", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 1
    assert r.json()[0]["label"] == "Prof-A"


def test_snmp_profiles_mask_secrets_in_response(client, auth_headers):
    """Community and v3 passwords are masked with '***' in API responses."""
    r = client.post("/api/snmp-profiles", json={
        "label": "MaskProf", "community": "topsecret",
        "v3_auth_password": "authpw", "v3_priv_password": "privpw",
    }, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["community"] == "***"
    assert data["v3_auth_password"] == "***"
    assert data["v3_priv_password"] == "***"

    r = client.get("/api/snmp-profiles", headers=auth_headers)
    row = [p for p in r.json() if p["label"] == "MaskProf"][0]
    assert row["community"] == "***"
    assert row["v3_auth_password"] == "***"
    assert row["v3_priv_password"] == "***"


def test_update_snmp_profile_mask_sentinels_keep_stored_values(client, auth_headers, db):
    """PUT with mask sentinels must not overwrite stored secrets."""
    r = client.post("/api/snmp-profiles", json={
        "label": "KeepProf", "community": "topsecret",
        "v3_auth_password": "authpw", "v3_priv_password": "privpw",
    }, headers=auth_headers)
    profile_id = r.json()["id"]

    r = client.put(f"/api/snmp-profiles/{profile_id}", json={
        "label": "RenamedProf",
        "community": "***",
        "v3_auth_password": "********",
        "v3_priv_password": "***",
    }, headers=auth_headers)
    assert r.status_code == 200

    db.expire_all()
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    assert profile.label == "RenamedProf"
    assert profile.community == "topsecret"
    assert profile.v3_auth_password == "authpw"
    assert profile.v3_priv_password == "privpw"


def test_update_snmp_profile_applies_real_secret_values(client, auth_headers, db):
    """PUT with real values updates the stored secrets."""
    r = client.post("/api/snmp-profiles", json={
        "label": "RealProf", "community": "old",
    }, headers=auth_headers)
    profile_id = r.json()["id"]

    r = client.put(f"/api/snmp-profiles/{profile_id}", json={"community": "newcomm"}, headers=auth_headers)
    assert r.status_code == 200

    db.expire_all()
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    assert profile.community == "newcomm"


def test_create_snmp_profile_normalizes_mask_sentinels(client, auth_headers, db):
    """POST with mask sentinels stores empty strings, never the mask itself."""
    r = client.post("/api/snmp-profiles", json={
        "label": "NormProf",
        "community": "***", "v3_auth_password": "********", "v3_priv_password": "***",
    }, headers=auth_headers)
    assert r.status_code == 201

    profile = db.query(SnmpProfile).filter(SnmpProfile.label == "NormProf").first()
    assert profile.community == ""
    assert profile.v3_auth_password == ""
    assert profile.v3_priv_password == ""


def test_delete_snmp_profile_detaches_credentials(client, auth_headers, db):
    from database import Credential
    r = client.post("/api/snmp-profiles", json={"label": "DelProf"}, headers=auth_headers)
    profile_id = r.json()["id"]
    cred = Credential(label="C", ip="10.9.1.1", profile_id=profile_id)
    db.add(cred)
    db.commit()

    r = client.delete(f"/api/snmp-profiles/{profile_id}", headers=auth_headers)
    assert r.status_code == 204

    db.expire_all()
    assert db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first() is None
    assert db.query(Credential).filter(Credential.ip == "10.9.1.1").first().profile_id is None
