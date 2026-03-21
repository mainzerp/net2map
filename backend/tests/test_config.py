"""Tests for global config export/import endpoints."""
import json

from database import AppSetting, Credential, SnmpProfile

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
