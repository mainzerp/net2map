"""API tests for discovery scan ranges (/scan-ranges), the legacy
/discovery-ranges endpoints, probe scan settings and config export/import."""
import json
from datetime import datetime, timedelta

import pytest

import routers.scan as scan_router
import routers.scan_ranges as scan_ranges_router
from database import AppSetting, ScanRange, SnmpProfile

BASE = "/api/v1/scan-ranges"


@pytest.fixture(autouse=True)
def _reset_limits():
    scan_ranges_router.limiter.reset()
    scan_router.limiter.reset()
    yield
    scan_ranges_router.limiter.reset()
    scan_router.limiter.reset()


@pytest.fixture()
def started_jobs(monkeypatch):
    calls = []

    def fake_start_job(dry_run=False, scan_type="full"):
        calls.append({"dry_run": dry_run, "scan_type": scan_type})
        return {"job_id": "job-%d" % len(calls), "status": "running"}

    monkeypatch.setattr(scan_ranges_router, "_start_job", fake_start_job)
    monkeypatch.setattr(scan_router, "_start_job", fake_start_job)
    return calls


def _error_code(resp):
    return resp.json()["error"]["code"]


# -- CRUD ---------------------------------------------------------------------

def test_create_and_list_scan_ranges(client, auth_headers):
    r = client.post(BASE, json={"cidr": "10.0.0.5/24", "label": "office"}, headers=auth_headers)
    assert r.status_code == 201
    body = r.json()
    assert body["cidr"] == "10.0.0.0/24"
    assert body["label"] == "office"
    assert body["enabled"] is True
    assert body["interval_sec"] is None
    assert body["profile_ids"] == []
    assert body["last_scan_at"] is None
    assert body["next_scan_at"] is None
    assert body["host_count"] == 254

    r = client.post(BASE, json={"cidr": "10.0.0.7/32"}, headers=auth_headers)
    assert r.status_code == 201
    assert r.json()["cidr"] == "10.0.0.7"
    assert r.json()["host_count"] == 1

    r = client.post(BASE, json={"cidr": "2001:db8::1/128"}, headers=auth_headers)
    assert r.json()["cidr"] == "2001:db8::1"

    listed = client.get(BASE, headers=auth_headers).json()
    assert [row["cidr"] for row in listed] == sorted(["10.0.0.0/24", "10.0.0.7", "2001:db8::1"])


def test_create_validation_errors(client, auth_headers, db):
    r = client.post(BASE, json={"cidr": "not-an-ip"}, headers=auth_headers)
    assert r.status_code == 400
    assert _error_code(r) == "INVALID_IP_RANGE"
    assert r.json()["error"]["field"] == "cidr"

    r = client.post(BASE, json={"cidr": "10.0.0.0/8"}, headers=auth_headers)
    assert r.status_code == 400
    assert _error_code(r) == "RANGE_TOO_LARGE"

    assert client.post(BASE, json={"cidr": "10.1.0.0/16"}, headers=auth_headers).status_code == 201
    r = client.post(BASE, json={"cidr": "10.1.2.3/16"}, headers=auth_headers)
    assert r.status_code == 409
    assert _error_code(r) == "RANGE_EXISTS"

    r = client.post(BASE, json={"cidr": "10.2.0.0/24", "profile_ids": [999]}, headers=auth_headers)
    assert r.status_code == 400
    assert _error_code(r) == "UNKNOWN_PROFILE"

    r = client.post(BASE, json={"cidr": "10.2.0.0/24", "interval_sec": 30}, headers=auth_headers)
    assert r.status_code == 422


def test_create_with_profiles_and_interval(client, auth_headers, db):
    prof = SnmpProfile(label="p1", snmp_version="v2c", community="c")
    db.add(prof)
    db.commit()
    r = client.post(BASE, json={"cidr": "10.3.0.0/24", "interval_sec": 600, "profile_ids": [prof.id, prof.id]},
                    headers=auth_headers)
    assert r.status_code == 201
    assert r.json()["profile_ids"] == [prof.id]
    assert r.json()["interval_sec"] == 600


def test_viewer_cannot_create(client, viewer_jwt_headers):
    r = client.post(BASE, json={"cidr": "10.0.0.0/24"}, headers=viewer_jwt_headers)
    assert r.status_code == 403


def test_patch_scan_range(client, auth_headers, db):
    rid = client.post(BASE, json={"cidr": "10.4.0.0/24"}, headers=auth_headers).json()["id"]
    client.post(BASE, json={"cidr": "10.5.0.0/24"}, headers=auth_headers)

    r = client.patch(f"{BASE}/{rid}", json={"interval_sec": 900, "label": "lab", "enabled": False},
                     headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["interval_sec"] == 900
    assert r.json()["label"] == "lab"
    assert r.json()["enabled"] is False

    # Omitted interval keeps the value, explicit null resets to the default.
    r = client.patch(f"{BASE}/{rid}", json={"label": "lab2"}, headers=auth_headers)
    assert r.json()["interval_sec"] == 900
    r = client.patch(f"{BASE}/{rid}", json={"interval_sec": None}, headers=auth_headers)
    assert r.json()["interval_sec"] is None

    r = client.patch(f"{BASE}/{rid}", json={"cidr": "10.5.0.9/24"}, headers=auth_headers)
    assert r.status_code == 409
    r = client.patch(f"{BASE}/{rid}", json={"cidr": "bad"}, headers=auth_headers)
    assert _error_code(r) == "INVALID_IP_RANGE"
    r = client.patch(f"{BASE}/{rid}", json={"profile_ids": [12345]}, headers=auth_headers)
    assert _error_code(r) == "UNKNOWN_PROFILE"
    r = client.patch(f"{BASE}/{rid}", json={"cidr": "10.6.0.1/24"}, headers=auth_headers)
    assert r.json()["cidr"] == "10.6.0.0/24"

    r = client.patch(f"{BASE}/99999", json={"label": "x"}, headers=auth_headers)
    assert r.status_code == 404
    assert _error_code(r) == "SCAN_RANGE_NOT_FOUND"


def test_delete_scan_range(client, auth_headers, db):
    rid = client.post(BASE, json={"cidr": "10.7.0.0/24"}, headers=auth_headers).json()["id"]
    r = client.delete(f"{BASE}/{rid}", headers=auth_headers)
    assert r.status_code == 204
    assert db.query(ScanRange).count() == 0
    r = client.delete(f"{BASE}/{rid}", headers=auth_headers)
    assert r.status_code == 404
    assert _error_code(r) == "SCAN_RANGE_NOT_FOUND"


def test_next_scan_at_uses_effective_interval(client, auth_headers, db):
    last = datetime(2026, 1, 1, 12, 0, 0)
    setting = db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").first()
    if setting is None:
        db.add(AppSetting(key="discovery_interval_sec", value="1200"))
    else:
        setting.value = "1200"
    db.add_all([
        ScanRange(cidr="10.8.0.0/24", last_scan_at=last),
        ScanRange(cidr="10.9.0.0/24", last_scan_at=last, interval_sec=60),
        ScanRange(cidr="10.10.0.0/24", last_scan_at=last, enabled=False),
    ])
    db.commit()
    rows = {r["cidr"]: r for r in client.get(BASE, headers=auth_headers).json()}
    assert rows["10.8.0.0/24"]["next_scan_at"].startswith((last + timedelta(seconds=1200)).isoformat())
    assert rows["10.9.0.0/24"]["next_scan_at"].startswith((last + timedelta(seconds=60)).isoformat())
    assert rows["10.10.0.0/24"]["next_scan_at"] is None


def test_create_writes_audit_entry(client, auth_headers, db):
    from database import AuditLog

    client.post(BASE, json={"cidr": "10.11.0.0/24"}, headers=auth_headers)
    assert db.query(AuditLog).filter(AuditLog.resource == "scan_range", AuditLog.action == "create").count() == 1


# -- Manual scans ---------------------------------------------------------------

def test_scan_all_ranges_starts_ranges_all_job(client, auth_headers, started_jobs):
    r = client.post(f"{BASE}/scan", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"job_id": "job-1", "status": "running"}
    assert started_jobs == [{"dry_run": False, "scan_type": "ranges_all"}]


def test_scan_one_range_resets_last_scan_and_starts_ranges_job(client, auth_headers, db, started_jobs):
    row = ScanRange(cidr="10.12.0.0/24", last_scan_at=datetime(2026, 1, 1))
    db.add(row)
    db.commit()
    r = client.post(f"{BASE}/{row.id}/scan", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["job_id"] == "job-1"
    db.refresh(row)
    assert row.last_scan_at is None
    assert started_jobs == [{"dry_run": False, "scan_type": "ranges"}]

    r = client.post(f"{BASE}/99999/scan", headers=auth_headers)
    assert r.status_code == 404


def test_dry_run_job_uses_ranges_all(client, auth_headers, started_jobs):
    r = client.post("/api/v1/scan/dry-run/jobs", headers=auth_headers)
    assert r.status_code == 200
    assert started_jobs == [{"dry_run": True, "scan_type": "ranges_all"}]


def test_scan_endpoints_require_operator(client, viewer_jwt_headers, started_jobs):
    assert client.post(f"{BASE}/scan", headers=viewer_jwt_headers).status_code == 403
    assert started_jobs == []


# -- Legacy /discovery-ranges -----------------------------------------------------

def test_legacy_discovery_ranges_sync_with_table(client, auth_headers, db):
    keep = ScanRange(cidr="10.20.0.0/24", label="keep", interval_sec=600, enabled=False)
    drop = ScanRange(cidr="10.21.0.0/24")
    db.add_all([keep, drop])
    db.commit()

    r = client.get("/api/v1/discovery-ranges", headers=auth_headers)
    assert r.json() == {"ranges": ["10.20.0.0/24", "10.21.0.0/24"]}

    r = client.put("/api/v1/discovery-ranges", json={"ranges": ["10.20.0.9/24", "192.168.5.5", " "]},
                   headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"ranges": ["10.20.0.0/24", "192.168.5.5"]}
    db.expire_all()
    rows = {r.cidr: r for r in db.query(ScanRange).all()}
    assert set(rows) == {"10.20.0.0/24", "192.168.5.5"}
    assert rows["10.20.0.0/24"].label == "keep"
    assert rows["10.20.0.0/24"].interval_sec == 600
    assert rows["10.20.0.0/24"].enabled is False
    assert rows["192.168.5.5"].enabled is True

    r = client.put("/api/v1/discovery-ranges", json={"ranges": ["nope"]}, headers=auth_headers)
    assert r.status_code == 400
    assert _error_code(r) == "INVALID_IP_RANGE"


def test_legacy_settings_key_no_longer_writable(client, auth_headers):
    r = client.put("/api/v1/settings/discovery_scan_ranges", json={"value": "[]"}, headers=auth_headers)
    assert r.status_code == 400
    assert _error_code(r) == "UNKNOWN_SETTING_KEY"
    r = client.put("/api/v1/settings/scan_probe_workers", json={"value": "32"}, headers=auth_headers)
    assert r.status_code == 200
    r = client.put("/api/v1/settings/scan_probe_skip_hours", json={"value": "500"}, headers=auth_headers)
    assert r.status_code == 400


# -- Scan settings probe fields ------------------------------------------------------

def test_scan_settings_probe_fields(client, auth_headers):
    body = client.get("/api/v1/scan-settings", headers=auth_headers).json()
    assert body["probe_workers"] == 64
    assert body["probe_skip_hours"] == 6

    r = client.put("/api/v1/scan-settings", json={"probe_workers": 1000, "probe_skip_hours": 0},
                   headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["probe_workers"] == 256
    assert r.json()["probe_skip_hours"] == 0

    # Omitting the fields keeps the stored values.
    r = client.put("/api/v1/scan-settings", json={"max_workers": 5}, headers=auth_headers)
    assert r.json()["probe_workers"] == 256
    assert r.json()["probe_skip_hours"] == 0

    r = client.put("/api/v1/scan-settings", json={"probe_workers": 0, "probe_skip_hours": 999}, headers=auth_headers)
    assert r.json()["probe_workers"] == 1
    assert r.json()["probe_skip_hours"] == 168
    rows = {s["key"]: s["value"] for s in client.get("/api/v1/settings", headers=auth_headers).json()}
    assert rows["scan_probe_workers"] == "1"
    assert rows["scan_probe_skip_hours"] == "168"


# -- Config export / import -------------------------------------------------------------

def test_config_export_includes_scan_ranges(client, auth_headers, db):
    prof = SnmpProfile(label="core", snmp_version="v2c", community="c")
    db.add(prof)
    db.commit()
    db.add_all([
        ScanRange(cidr="10.30.0.0/24", label="a", interval_sec=600, profile_ids=[prof.id, 4242]),
        ScanRange(cidr="10.31.0.0/24", enabled=False),
    ])
    db.commit()
    payload = json.loads(client.get("/api/v1/config/export", headers=auth_headers).json()["data"])
    assert payload["scan_ranges"] == [
        {"cidr": "10.30.0.0/24", "label": "a", "enabled": True, "interval_sec": 600, "profile_labels": ["core"]},
        {"cidr": "10.31.0.0/24", "label": "", "enabled": False, "interval_sec": None, "profile_labels": []},
    ]


def _import(client, headers, payload, dry_run=False):
    return client.post("/api/v1/config/import", json={"data": json.dumps(payload), "dry_run": dry_run},
                       headers=headers)


def test_config_import_upserts_scan_ranges(client, auth_headers, db):
    db.add(ScanRange(cidr="10.40.0.0/24", label="old", interval_sec=600))
    db.commit()
    payload = {
        "profiles": [{"label": "newprof", "snmp_version": "v2c", "community": "x"}],
        "scan_ranges": [
            {"cidr": "10.40.0.1/24", "label": "updated", "enabled": False, "interval_sec": None,
             "profile_labels": ["newprof", "missing"]},
            {"cidr": "10.41.0.0/24", "label": "fresh", "interval_sec": 300},
        ],
    }
    r = _import(client, auth_headers, payload)
    assert r.status_code == 200
    body = r.json()
    assert body["errors"] == []
    assert body["totals"]["scan_ranges"] == 2
    assert body["inserted"]["scan_ranges"] == 1
    assert body["updated"]["scan_ranges"] == 1
    db.expire_all()
    prof_id = db.query(SnmpProfile).filter(SnmpProfile.label == "newprof").one().id
    rows = {r.cidr: r for r in db.query(ScanRange).all()}
    assert rows["10.40.0.0/24"].label == "updated"
    assert rows["10.40.0.0/24"].enabled is False
    assert rows["10.40.0.0/24"].interval_sec is None
    assert rows["10.40.0.0/24"].profile_ids == [prof_id]
    assert rows["10.41.0.0/24"].interval_sec == 300
    assert rows["10.41.0.0/24"].profile_ids == []


def test_config_import_reports_invalid_scan_ranges(client, auth_headers, db):
    r = _import(client, auth_headers, {"scan_ranges": [{"cidr": "bogus"}, {"cidr": "10.0.0.0/8"}]})
    errors = r.json()["errors"]
    assert [e["section"] for e in errors] == ["scan_ranges", "scan_ranges"]
    assert [e["row"] for e in errors] == [1, 2]
    assert db.query(ScanRange).count() == 0

    r = _import(client, auth_headers, {"scan_ranges": {"cidr": "10.0.0.0/24"}})
    assert r.status_code == 400


def test_config_import_converts_legacy_discovery_ranges_setting(client, auth_headers, db):
    db.add(ScanRange(cidr="10.50.0.0/24", label="existing", interval_sec=600))
    db.commit()
    payload = {"settings": [
        {"key": "discovery_scan_ranges", "value": json.dumps(["10.50.0.0/24", "10.51.0.7", "junk"])},
        {"key": "dns_servers", "value": "[]"},
    ]}
    r = _import(client, auth_headers, payload)
    body = r.json()
    assert body["errors"] == []
    assert body["inserted"]["scan_ranges"] == 1
    db.expire_all()
    assert db.query(AppSetting).filter(AppSetting.key == "discovery_scan_ranges").first() is None
    rows = {r.cidr: r for r in db.query(ScanRange).all()}
    assert set(rows) == {"10.50.0.0/24", "10.51.0.7"}
    assert rows["10.50.0.0/24"].label == "existing"
    assert rows["10.50.0.0/24"].interval_sec == 600


def test_config_import_dry_run_counts_scan_ranges(client, auth_headers, db):
    r = _import(client, auth_headers, {"scan_ranges": [{"cidr": "10.60.0.0/24"}]}, dry_run=True)
    assert r.json()["totals"]["scan_ranges"] == 1
    assert db.query(ScanRange).count() == 0
