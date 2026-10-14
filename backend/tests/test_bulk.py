"""Tests for bulk import/export endpoints."""
import json

from database import Credential, Device, SnmpProfile
from shared.crypto import decrypt

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


# -- Role enforcement and mask round-trip --------------------------------------

def test_bulk_export_requires_privileged_role(client, viewer_jwt_headers, db):
    """Viewer role must not access bulk export."""
    r = client.get("/api/bulk-export/credentials?fmt=json", headers=viewer_jwt_headers)
    assert r.status_code == 403


def test_bulk_import_mask_not_stored_on_insert(client, auth_headers, db):
    """Re-importing an export must not store the '********' mask as a real value."""
    import_data = json.dumps([
        {"label": "MaskInsert", "ip": "10.4.0.1",
         "community": "********", "v3_auth_password": "********", "v3_priv_password": "********"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"] == 1

    cred = db.query(Credential).filter(Credential.ip == "10.4.0.1").first()
    assert cred.community == ""
    assert cred.v3_auth_password == ""
    assert cred.v3_priv_password == ""


def test_bulk_import_mask_keeps_values_on_update(client, auth_headers, db):
    """Masked fields in an import leave existing values unchanged on update."""
    existing = Credential(
        label="MaskUpd", ip="10.4.0.2", community="keepme",
        v3_auth_password="keepauth", v3_priv_password="keeppriv",
    )
    db.add(existing)
    db.commit()

    import_data = json.dumps([
        {"label": "MaskUpd", "ip": "10.4.0.2",
         "community": "********", "v3_auth_password": "***", "v3_priv_password": "********"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    db.expire_all()
    cred = db.query(Credential).filter(Credential.ip == "10.4.0.2").first()
    assert decrypt(cred.community) == "keepme"
    assert decrypt(cred.v3_auth_password) == "keepauth"
    assert decrypt(cred.v3_priv_password) == "keeppriv"


def test_bulk_import_profiles_mask_not_stored_on_insert(client, auth_headers, db):
    """Profile inserts from a re-import normalize masked secrets to empty."""
    import_data = json.dumps([
        {"label": "ProfMaskInsert", "community": "********",
         "v3_auth_password": "********", "v3_priv_password": "********"},
    ])
    r = client.post("/api/bulk-import/profiles", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"] == 1

    prof = db.query(SnmpProfile).filter(SnmpProfile.label == "ProfMaskInsert").first()
    assert prof.community == ""
    assert prof.v3_auth_password == ""
    assert prof.v3_priv_password == ""


# -- Priority matching ---------------------------------------------------------

def test_bulk_export_credentials_includes_priority(client, auth_headers, db):
    """Export carries priority so re-import can match on (ip, priority)."""
    db.add(Credential(label="PrioCred", ip="10.5.0.1", priority=3))
    db.commit()

    r = client.get("/api/bulk-export/credentials?fmt=json", headers=auth_headers)
    assert r.status_code == 200
    rows = json.loads(r.json()["data"])
    row = [c for c in rows if c["ip"] == "10.5.0.1"][0]
    assert row["priority"] == 3


def test_bulk_import_matches_credential_by_ip_and_priority(client, auth_headers, db):
    """Credential upsert matches on (ip, priority), not ip alone."""
    db.add_all([
        Credential(label="Prio0", ip="10.5.0.2", priority=0, community="c0"),
        Credential(label="Prio1", ip="10.5.0.2", priority=1, community="c1"),
    ])
    db.commit()

    import_data = json.dumps([
        {"label": "Prio1-Updated", "ip": "10.5.0.2", "priority": 1, "community": "c1-new"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["updated"] == 1
    assert r.json()["inserted"] == 0

    db.expire_all()
    prio0 = db.query(Credential).filter(Credential.ip == "10.5.0.2", Credential.priority == 0).first()
    prio1 = db.query(Credential).filter(Credential.ip == "10.5.0.2", Credential.priority == 1).first()
    assert prio0.label == "Prio0"
    assert decrypt(prio0.community) == "c0"
    assert prio1.label == "Prio1-Updated"
    assert decrypt(prio1.community) == "c1-new"


def test_bulk_import_without_priority_falls_back_to_zero(client, auth_headers, db):
    """Old exports without a priority field still match (ip, priority=0)."""
    db.add(Credential(label="OldPrio", ip="10.5.0.3", priority=0, community="old"))
    db.commit()

    import_data = json.dumps([
        {"label": "OldPrio-Updated", "ip": "10.5.0.3", "community": "new"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["updated"] == 1
    assert r.json()["inserted"] == 0

    db.expire_all()
    cred = db.query(Credential).filter(Credential.ip == "10.5.0.3", Credential.priority == 0).first()
    assert cred.label == "OldPrio-Updated"


def test_bulk_export_import_roundtrip_preserves_priorities(client, auth_headers, db):
    """Export -> re-import updates both credentials of one IP in place."""
    db.add_all([
        Credential(label="RT0", ip="10.5.0.4", priority=0, community="rt0"),
        Credential(label="RT1", ip="10.5.0.4", priority=1, community="rt1"),
    ])
    db.commit()

    r = client.get("/api/bulk-export/credentials?fmt=json", headers=auth_headers)
    export_data = r.json()["data"]

    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": export_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    result = r.json()
    assert result["updated"] >= 2
    assert result["inserted"] == 0

    db.expire_all()
    creds = db.query(Credential).filter(Credential.ip == "10.5.0.4").order_by(Credential.priority).all()
    assert len(creds) == 2
    assert [c.label for c in creds] == ["RT0", "RT1"]


# -- FK reference resolution ---------------------------------------------------

def test_bulk_export_includes_fk_references(client, auth_headers, db):
    """Credential export rows carry profile_label and device_ip."""
    prof = SnmpProfile(label="BkProf", community="pub")
    dev = Device(ip="10.7.0.9", sys_name="sw-bk")
    cred = Credential(label="BkCred", ip="10.7.0.9", profile=prof, device=dev)
    db.add_all([prof, dev, cred])
    db.commit()

    r = client.get("/api/bulk-export/credentials?fmt=json", headers=auth_headers)
    assert r.status_code == 200
    rows = json.loads(r.json()["data"])
    row = [c for c in rows if c["ip"] == "10.7.0.9"][0]
    assert row["profile_label"] == "BkProf"
    assert row["device_ip"] == "10.7.0.9"


def test_bulk_import_resolves_fk_labels(client, auth_headers, db):
    """Bulk credential import resolves profile_label/device_ip to local ids."""
    prof = SnmpProfile(label="BkImpProf", community="pub")
    dev = Device(ip="10.7.1.5", sys_name="sw-bki")
    db.add_all([prof, dev])
    db.commit()

    import_data = json.dumps([
        {"label": "BkImp", "ip": "10.7.1.5",
         "profile_label": "BkImpProf", "device_ip": "10.7.1.5"},
        {"label": "BkImpNoDev", "ip": "10.7.1.6", "profile_label": "Missing"},
    ])
    r = client.post("/api/bulk-import/credentials", json={
        "format": "json", "data": import_data, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"] == 2

    cred = db.query(Credential).filter(Credential.ip == "10.7.1.5").first()
    assert cred.profile_id == prof.id
    assert cred.device_id == dev.id
    cred2 = db.query(Credential).filter(Credential.ip == "10.7.1.6").first()
    assert cred2.profile_id is None
    assert cred2.device_id is None
