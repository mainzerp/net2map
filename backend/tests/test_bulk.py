"""Tests for bulk import/export endpoints."""
import json

from database import Credential, SnmpProfile

# -- Bulk export tests ---------------------------------------------------------

def test_bulk_export_credentials_masks_passwords(client, auth_headers, db):
    """Exported credentials have passwords masked with '********'."""
    cred = Credential(
        label="SW1", ip="10.0.0.1",
        community="secret_community",
        v3_auth_password="auth_secret",
        v3_priv_password="priv_secret",
    )
    db.add(cred)
    db.commit()

    r = client.get("/api/bulk-export/credentials?fmt=json", headers=auth_headers)
    assert r.status_code == 200
    rows = json.loads(r.json()["data"])
    assert len(rows) == 1
    assert rows[0]["v3_auth_password"] == "********"
    assert rows[0]["v3_priv_password"] == "********"
    assert rows[0]["community"] == "********"


def test_bulk_export_profiles_masks_passwords(client, auth_headers, db):
    """Exported profiles have passwords masked."""
    profile = SnmpProfile(
        label="Prof1", snmp_version="v3",
        community="comm_secret",
        v3_auth_password="auth_pwd",
        v3_priv_password="priv_pwd",
    )
    db.add(profile)
    db.commit()

    r = client.get("/api/bulk-export/profiles?fmt=json", headers=auth_headers)
    assert r.status_code == 200
    rows = json.loads(r.json()["data"])
    assert len(rows) == 1
    assert rows[0]["v3_auth_password"] == "********"
    assert rows[0]["v3_priv_password"] == "********"
    assert rows[0]["community"] == "********"


def test_bulk_export_empty_passwords_not_masked(client, auth_headers, db):
    """Empty password fields export as empty strings, not masks."""
    cred = Credential(
        label="SW2", ip="10.0.0.2",
        community="", v3_auth_password="", v3_priv_password="",
    )
    db.add(cred)
    db.commit()

    r = client.get("/api/bulk-export/credentials?fmt=json", headers=auth_headers)
    rows = json.loads(r.json()["data"])
    assert rows[0]["v3_auth_password"] == ""
    assert rows[0]["v3_priv_password"] == ""
    assert rows[0]["community"] == ""


def test_community_strings_masked_in_credential_export(client, auth_headers, db):
    """Community strings are masked in bulk credential export."""
    cred = Credential(label="SW3", ip="10.0.0.3", community="private_community")
    db.add(cred)
    db.commit()

    r = client.get("/api/bulk-export/credentials?fmt=json", headers=auth_headers)
    rows = json.loads(r.json()["data"])
    assert rows[0]["community"] == "********"


# -- Bulk import tests ---------------------------------------------------------

def test_bulk_import_credentials_stored(client, auth_headers, db):
    """Bulk importing credentials inserts them into the database."""
    import_data = json.dumps([
        {"label": "Imported1", "ip": "10.1.0.1", "community": "public"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    result = r.json()
    assert result["inserted"] == 1

    cred = db.query(Credential).filter(Credential.ip == "10.1.0.1").first()
    assert cred is not None
    assert cred.label == "Imported1"


def test_bulk_import_dry_run_does_not_modify_db(client, auth_headers, db):
    """Bulk import with dry_run=True does not insert any rows."""
    import_data = json.dumps([
        {"label": "DryRun1", "ip": "10.2.0.1"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": True,
    }, headers=auth_headers)
    assert r.status_code == 200
    result = r.json()
    assert result["dry_run"] is True
    assert result["inserted"] == 0

    cred = db.query(Credential).filter(Credential.ip == "10.2.0.1").first()
    assert cred is None


def test_bulk_import_updates_existing_by_ip(client, auth_headers, db):
    """Bulk import updates existing credentials matched by IP."""
    existing = Credential(label="Old", ip="10.3.0.1", community="public")
    db.add(existing)
    db.commit()

    import_data = json.dumps([
        {"label": "Updated", "ip": "10.3.0.1", "community": "newcommunity"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    db.expire_all()
    cred = db.query(Credential).filter(Credential.ip == "10.3.0.1").first()
    assert cred.label == "Updated"


def test_bulk_import_invalid_rows_returns_errors(client, auth_headers):
    """Bulk import with invalid data returns row-level errors."""
    import_data = json.dumps([
        {"label": "NoIP"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": True,
    }, headers=auth_headers)
    assert r.status_code == 200
    result = r.json()
    assert len(result["errors"]) > 0
    assert result["valid_rows"] == 0


def test_bulk_import_profiles_stored(client, auth_headers, db):
    """Bulk importing profiles inserts them into the database."""
    import_data = json.dumps([
        {"label": "ProfImport1", "snmp_version": "v2c", "community": "public"},
    ])
    r = client.post("/api/bulk-import/profiles", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"] == 1

    prof = db.query(SnmpProfile).filter(SnmpProfile.label == "ProfImport1").first()
    assert prof is not None
