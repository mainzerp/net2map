"""Tests for the settings router (GET/PUT /api/settings)."""
from database import AppSetting


def test_list_settings_returns_list(client, auth_headers):
    """GET /api/settings returns a list of settings."""
    r = client.get("/api/settings", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)


def test_list_settings_returns_entries(client, auth_headers, db):
    """GET /api/settings returns seeded settings."""
    db.add(AppSetting(key="theme", value="dark"))
    db.add(AppSetting(key="scan_interval", value="300"))
    db.commit()

    r = client.get("/api/settings", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    keys = [s["key"] for s in data]
    assert "theme" in keys
    assert "scan_interval" in keys


def test_put_setting_creates_new(client, jwt_headers, db):
    """PUT /api/settings/{key} creates a new setting if it does not exist."""
    r = client.put(
        "/api/settings/new_key",
        json={"value": "new_val"},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["key"] == "new_key"
    assert data["value"] == "new_val"


def test_put_setting_updates_existing(client, jwt_headers, db):
    """PUT /api/settings/{key} updates an existing setting."""
    db.add(AppSetting(key="existing", value="old"))
    db.commit()

    r = client.put(
        "/api/settings/existing",
        json={"value": "updated"},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    assert r.json()["value"] == "updated"

    # Verify DB was updated
    db.expire_all()
    setting = db.query(AppSetting).filter(AppSetting.key == "existing").first()
    assert setting.value == "updated"


def test_stats_endpoint(client, auth_headers):
    """GET /api/stats returns expected fields."""
    r = client.get("/api/stats", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert "device_count" in data
    assert "port_count" in data
    assert "port_up_count" in data
    assert "rack_count" in data
    assert "endpoint_count" in data
