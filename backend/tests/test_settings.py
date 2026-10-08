"""Tests for the settings router (GET/PUT /api/settings)."""
import pytest

from database import AppSetting, AuditLog


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    import routers.settings as _s
    _s.limiter.reset()
    yield
    _s.limiter.reset()


def _value(db, key):
    db.expire_all()
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else None


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
        "/api/settings/link_update_interval_sec",
        json={"value": "60"},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["key"] == "link_update_interval_sec"
    assert data["value"] == "60"


def test_put_setting_updates_existing(client, jwt_headers, db):
    """PUT /api/settings/{key} updates an existing setting."""
    # The key is seeded at app startup (see _seed_default_settings), so
    # upsert instead of plain insert to avoid a UNIQUE collision.
    existing = db.query(AppSetting).filter(AppSetting.key == "mac_update_interval_sec").first()
    if existing:
        existing.value = "300"
    else:
        db.add(AppSetting(key="mac_update_interval_sec", value="300"))
    db.commit()

    r = client.put(
        "/api/settings/mac_update_interval_sec",
        json={"value": "600"},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    assert r.json()["value"] == "600"

    # Verify DB was updated
    db.expire_all()
    setting = db.query(AppSetting).filter(AppSetting.key == "mac_update_interval_sec").first()
    assert setting.value == "600"


def test_put_setting_unknown_key_rejected(client, jwt_headers):
    """PUT /api/settings/{key} rejects keys outside the whitelist."""
    r = client.put(
        "/api/settings/arbitrary_key",
        json={"value": "x"},
        headers=jwt_headers,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "UNKNOWN_SETTING_KEY"


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


def test_scan_settings_bulk_size_roundtrip_and_clamp(client, jwt_headers):
    """PUT /api/scan-settings stores the GETBULK size clamped to 5..100."""
    r = client.put("/api/scan-settings", json={"snmp_bulk_size": 500}, headers=jwt_headers)
    assert r.status_code == 200
    assert r.json()["snmp_bulk_size"] == 100

    r = client.put("/api/scan-settings", json={"snmp_bulk_size": 40}, headers=jwt_headers)
    assert r.json()["snmp_bulk_size"] == 40
    assert client.get("/api/scan-settings", headers=jwt_headers).json()["snmp_bulk_size"] == 40


def test_bulk_put_applies_all_and_returns_list(client, jwt_headers, db):
    """PUT /api/v1/settings applies every key in one call and returns all settings."""
    payload = {"latency_enabled": "FALSE", "latency_interval_sec": "20", "latency_pings": "5",
               "latency_mode": "Selected", "latency_retention_days": "60"}
    r = client.put("/api/v1/settings", json=payload, headers=jwt_headers)
    assert r.status_code == 200
    by_key = {s["key"]: s["value"] for s in r.json()}
    assert by_key["latency_enabled"] == "false" and by_key["latency_mode"] == "selected"
    assert by_key["latency_interval_sec"] == "20" and by_key["latency_retention_days"] == "60"
    assert _value(db, "latency_pings") == "5"
    entries = db.query(AuditLog).filter(AuditLog.resource == "app_setting").all()
    assert len(entries) == 1
    assert entries[0].details["keys"] == sorted(payload)


def test_bulk_put_unknown_key_rejected(client, jwt_headers, db):
    r = client.put("/api/v1/settings", json={"latency_pings": "4", "arbitrary_key": "x"}, headers=jwt_headers)
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "UNKNOWN_SETTING_KEY" and err["field"] == "arbitrary_key"
    assert _value(db, "latency_pings") != "4"


def test_bulk_put_invalid_value_changes_nothing(client, jwt_headers, db):
    before = {k: _value(db, k) for k in ("latency_interval_sec", "latency_pings")}
    r = client.put("/api/v1/settings", json={"latency_interval_sec": "42", "latency_pings": "11"},
                   headers=jwt_headers)
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "INVALID_SETTING_VALUE" and err["field"] == "latency_pings"
    assert {k: _value(db, k) for k in before} == before


def test_bulk_put_viewer_forbidden(client, viewer_jwt_headers, db):
    r = client.put("/api/v1/settings", json={"latency_pings": "4"}, headers=viewer_jwt_headers)
    assert r.status_code == 403
    assert _value(db, "latency_pings") != "4"
