"""Tests for global config export/import endpoints."""
import json

from database import AppSetting, Credential, Device, SnmpProfile

# -- Config export tests -------------------------------------------------------

def test_config_export_masks_passwords(client, auth_headers, db):
    """Config export masks all password fields with '********'."""
    profile = SnmpProfile(
        label="ExProf", snmp_version="v3",
        community="secret_comm",
        v3_auth_password="auth_pwd",
        v3_priv_password="priv_pwd",
    )
    cred = Credential(
        label="ExCred", ip="10.0.0.1",
        community="cred_comm",
        v3_auth_password="cred_auth",
        v3_priv_password="cred_priv",
    )
    db.add_all([profile, cred])
    db.commit()

    r = client.get("/api/config/export", headers=auth_headers)
    assert r.status_code == 200
    payload = json.loads(r.json()["data"])

    prof_row = payload["profiles"][0]
    assert prof_row["v3_auth_password"] == "********"
    assert prof_row["v3_priv_password"] == "********"
    assert prof_row["community"] == "********"

    cred_row = payload["credentials"][0]
    assert cred_row["v3_auth_password"] == "********"
    assert cred_row["v3_priv_password"] == "********"
    assert cred_row["community"] == "********"


def test_config_export_includes_expected_sections(client, auth_headers, db):
    """Config export contains settings, profiles, and credentials sections."""
    db.add(AppSetting(key="test_key", value="test_val"))
    db.commit()

    r = client.get("/api/config/export", headers=auth_headers)
    assert r.status_code == 200
    payload = json.loads(r.json()["data"])
    assert "settings" in payload
    assert "profiles" in payload
    assert "credentials" in payload
    assert "version" in payload
    assert "exported_at" in payload


def test_config_export_includes_settings(client, auth_headers, db):
    """Config export contains app settings rows."""
    db.add(AppSetting(key="my_setting", value="my_value"))
    db.commit()

    r = client.get("/api/config/export", headers=auth_headers)
    payload = json.loads(r.json()["data"])
    setting_keys = [s["key"] for s in payload["settings"]]
    assert "my_setting" in setting_keys


# -- Config import tests -------------------------------------------------------

def test_config_import_settings_upserted(client, auth_headers, db):
    """Config import upserts settings correctly."""
    db.add(AppSetting(key="existing_key", value="old_value"))
    db.commit()

    config_payload = json.dumps({
        "settings": [
            {"key": "existing_key", "value": "new_value"},
            {"key": "brand_new_key", "value": "fresh"},
        ],
        "profiles": [],
        "credentials": [],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    result = r.json()
    assert result["inserted"]["settings"] == 1
    assert result["updated"]["settings"] == 1

    db.expire_all()
    existing = db.query(AppSetting).filter(AppSetting.key == "existing_key").first()
    assert existing.value == "new_value"
    new = db.query(AppSetting).filter(AppSetting.key == "brand_new_key").first()
    assert new.value == "fresh"


def test_config_import_dry_run_does_not_modify_db(client, auth_headers, db):
    """Config import with dry_run=True does not modify the database."""
    config_payload = json.dumps({
        "settings": [{"key": "dr_key", "value": "dr_val"}],
        "profiles": [],
        "credentials": [],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": True,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["dry_run"] is True

    setting = db.query(AppSetting).filter(AppSetting.key == "dr_key").first()
    assert setting is None


def test_config_import_invalid_json_returns_error(client, auth_headers):
    """Config import with malformed JSON returns 400."""
    r = client.post("/api/config/import", json={
        "data": "not valid json{{{", "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_JSON"


def test_config_import_credentials(client, auth_headers, db):
    """Config import inserts credentials."""
    config_payload = json.dumps({
        "settings": [],
        "profiles": [],
        "credentials": [
            {"label": "ConfCred", "ip": "10.5.0.1", "community": "public"},
        ],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"]["credentials"] == 1

    cred = db.query(Credential).filter(Credential.ip == "10.5.0.1").first()
    assert cred is not None
    assert cred.label == "ConfCred"


def test_config_import_profiles(client, auth_headers, db):
    """Config import inserts profiles."""
    config_payload = json.dumps({
        "settings": [],
        "profiles": [
            {"label": "ConfProf", "snmp_version": "v2c", "community": "public"},
        ],
        "credentials": [],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"]["profiles"] == 1

    prof = db.query(SnmpProfile).filter(SnmpProfile.label == "ConfProf").first()
    assert prof is not None


# -- Timestamp format, mask round-trip, (ip, priority) matching -----------------

def test_config_export_timestamp_has_no_double_timezone(client, auth_headers):
    """exported_at must be a plain ISO timestamp, not '...+00:00Z'."""
    r = client.get("/api/config/export", headers=auth_headers)
    payload = json.loads(r.json()["data"])
    exported_at = payload["exported_at"]
    assert not exported_at.endswith("Z")
    assert exported_at.endswith("+00:00")


def test_config_export_includes_credential_priority(client, auth_headers, db):
    """Export carries priority so re-import can match on (ip, priority)."""
    db.add(Credential(label="Prio", ip="10.6.0.1", priority=3))
    db.commit()

    r = client.get("/api/config/export", headers=auth_headers)
    payload = json.loads(r.json()["data"])
    cred_row = [c for c in payload["credentials"] if c["ip"] == "10.6.0.1"][0]
    assert cred_row["priority"] == 3


def test_config_import_mask_not_stored_on_insert(client, auth_headers, db):
    """Re-importing an export must not store the '********' mask as a real value."""
    config_payload = json.dumps({
        "settings": [],
        "profiles": [
            {"label": "MaskProf", "community": "********",
             "v3_auth_password": "********", "v3_priv_password": "********"},
        ],
        "credentials": [
            {"label": "MaskCred", "ip": "10.6.0.2", "community": "********",
             "v3_auth_password": "***", "v3_priv_password": "********"},
        ],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"]["profiles"] == 1
    assert r.json()["inserted"]["credentials"] == 1

    prof = db.query(SnmpProfile).filter(SnmpProfile.label == "MaskProf").first()
    assert prof.community == ""
    assert prof.v3_auth_password == ""
    assert prof.v3_priv_password == ""

    cred = db.query(Credential).filter(Credential.ip == "10.6.0.2").first()
    assert cred.community == ""
    assert cred.v3_auth_password == ""
    assert cred.v3_priv_password == ""


def test_config_import_matches_credential_by_ip_and_priority(client, auth_headers, db):
    """Credential upsert matches on the unique key (ip, priority), not ip alone."""
    db.add_all([
        Credential(label="Prio0", ip="10.6.0.3", priority=0, community="c0"),
        Credential(label="Prio1", ip="10.6.0.3", priority=1, community="c1"),
    ])
    db.commit()

    config_payload = json.dumps({
        "settings": [],
        "profiles": [],
        "credentials": [
            {"label": "Prio1-Updated", "ip": "10.6.0.3", "priority": 1, "community": "c1-new"},
        ],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["updated"]["credentials"] == 1
    assert r.json()["inserted"]["credentials"] == 0

    db.expire_all()
    prio0 = db.query(Credential).filter(Credential.ip == "10.6.0.3", Credential.priority == 0).first()
    prio1 = db.query(Credential).filter(Credential.ip == "10.6.0.3", Credential.priority == 1).first()
    assert prio0.label == "Prio0"
    assert prio0.community == "c0"
    assert prio1.label == "Prio1-Updated"
    assert prio1.community == "c1-new"


def test_config_import_mask_keeps_values_on_update(client, auth_headers, db):
    """Masked fields in a config import leave existing values unchanged on update."""
    db.add(Credential(
        label="KeepCred", ip="10.6.0.4", community="keepme",
        v3_auth_password="keepauth", v3_priv_password="keeppriv",
    ))
    db.commit()

    config_payload = json.dumps({
        "settings": [],
        "profiles": [],
        "credentials": [
            {"label": "KeepCred-Renamed", "ip": "10.6.0.4", "community": "********",
             "v3_auth_password": "********", "v3_priv_password": "********"},
        ],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["updated"]["credentials"] == 1

    db.expire_all()
    cred = db.query(Credential).filter(Credential.ip == "10.6.0.4").first()
    assert cred.label == "KeepCred-Renamed"
    assert cred.community == "keepme"
    assert cred.v3_auth_password == "keepauth"
    assert cred.v3_priv_password == "keeppriv"


# -- Role guard and FK reference resolution ------------------------------------

def test_config_export_requires_privileged_role(client, viewer_jwt_headers):
    """Viewer role must not access the global config export."""
    r = client.get("/api/config/export", headers=viewer_jwt_headers)
    assert r.status_code == 403


def test_config_export_includes_fk_references(client, auth_headers, db):
    """Credential export rows carry profile_label and device_ip."""
    prof = SnmpProfile(label="RefProf", community="pub")
    dev = Device(ip="10.8.0.9", sys_name="sw-ref")
    cred = Credential(label="RefCred", ip="10.8.0.9", profile=prof, device=dev)
    db.add_all([prof, dev, cred])
    db.commit()

    r = client.get("/api/config/export", headers=auth_headers)
    assert r.status_code == 200
    payload = json.loads(r.json()["data"])
    row = [c for c in payload["credentials"] if c["ip"] == "10.8.0.9"][0]
    assert row["profile_label"] == "RefProf"
    assert row["device_ip"] == "10.8.0.9"


def test_config_import_resolves_fk_labels_over_raw_ids(client, auth_headers, db):
    """profile_label/device_ip win over raw ids; unknown references -> None."""
    prof = SnmpProfile(label="ImportProf", community="pub")
    dev = Device(ip="10.8.1.5", sys_name="sw-imp")
    db.add_all([prof, dev])
    db.commit()

    config_payload = json.dumps({
        "settings": [],
        "profiles": [],
        "credentials": [
            {"label": "FkCred", "ip": "10.8.1.5",
             "profile_id": 999, "device_id": 999,
             "profile_label": "ImportProf", "device_ip": "10.8.1.5"},
            {"label": "FkCred2", "ip": "10.8.1.6",
             "profile_id": 999, "profile_label": "NoSuchProfile"},
        ],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["inserted"]["credentials"] == 2

    cred = db.query(Credential).filter(Credential.ip == "10.8.1.5").first()
    assert cred.profile_id == prof.id
    assert cred.device_id == dev.id
    # Unknown label resolves to None rather than keeping the stale raw id
    cred2 = db.query(Credential).filter(Credential.ip == "10.8.1.6").first()
    assert cred2.profile_id is None


def test_config_import_autolinks_device_by_ip(client, auth_headers, db):
    """Without device_id/device_ip, import links the credential to the device
    with the same IP, matching create_credential behaviour."""
    db.add(Device(ip="10.8.2.7", sys_name="sw-auto"))
    db.commit()

    config_payload = json.dumps({
        "settings": [],
        "profiles": [],
        "credentials": [{"label": "AutoCred", "ip": "10.8.2.7"}],
    })
    r = client.post("/api/config/import", json={
        "data": config_payload, "dry_run": False,
    }, headers=auth_headers)
    assert r.status_code == 200

    cred = db.query(Credential).filter(Credential.ip == "10.8.2.7").first()
    assert cred.device_id is not None
    assert cred.device.sys_name == "sw-auto"
