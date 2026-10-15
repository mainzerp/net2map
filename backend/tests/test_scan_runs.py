"""Tests for the scan run history endpoint (/api/scan-runs)."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from database import ScanRun, ScanRunSwitchMetric


def _real_safe_json_list(raw):
    """Local stand-in for scan_engine._safe_json_list (module is mocked in conftest)."""
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            return [str(v) for v in value]
    except Exception:
        pass
    return []


@pytest.fixture(autouse=True)
def _patch_safe_json_list(monkeypatch):
    monkeypatch.setattr("routers.scan_runs._safe_json_list", _real_safe_json_list)


def _make_run(db, devices, links=(), age_minutes=0, scan_type=None):
    run = ScanRun(
        status="finished",
        scan_type=scan_type,
        scanned=len(devices),
        found=len(devices),
        links=len(links),
        max_workers=4,
        total_duration_ms=100,
        error_count=0,
        devices_snapshot_json=json.dumps(sorted(devices)),
        links_snapshot_json=json.dumps(sorted(links)),
        created_at=datetime.now(timezone.utc) - timedelta(minutes=age_minutes),
    )
    db.add(run)
    db.commit()
    return run


def test_scan_runs_empty(client, auth_headers):
    r = client.get("/api/scan-runs", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_oldest_run_in_window_diffs_against_real_predecessor(client, auth_headers, db):
    """With limit=N the oldest returned run must diff against run N+1, not an empty snapshot."""
    _make_run(db, ["10.1.0.1"], age_minutes=30)                       # oldest (outside window)
    _make_run(db, ["10.1.0.1", "10.1.0.2"], age_minutes=20)
    newest = _make_run(db, ["10.1.0.2"], age_minutes=10)

    r = client.get("/api/scan-runs?limit=2", headers=auth_headers)
    assert r.status_code == 200
    runs = r.json()
    assert len(runs) == 2

    newest_row = [x for x in runs if x["id"] == newest.id][0]
    assert newest_row["new_devices"] == []
    assert newest_row["removed_devices"] == ["10.1.0.1"]

    # The second row is the oldest in the window; without the extra fetch its
    # diff would have been computed against an empty snapshot.
    middle_row = [x for x in runs if x["id"] != newest.id][0]
    assert middle_row["new_devices"] == ["10.1.0.2"]
    assert middle_row["removed_devices"] == []


def test_runs_diff_only_against_the_same_scan_type(client, auth_headers, db):
    """A range scan between two device scans must not report every device as removed/new."""
    _make_run(db, ["10.4.0.1"], age_minutes=40, scan_type="ranges")              # outside window
    _make_run(db, ["10.4.1.1", "10.4.1.2"], age_minutes=30, scan_type="macs")
    ranges = _make_run(db, ["10.4.0.1", "10.4.0.2"], age_minutes=20, scan_type="ranges")
    macs = _make_run(db, ["10.4.1.1", "10.4.1.2", "10.4.1.3"], age_minutes=10, scan_type="macs")

    r = client.get("/api/scan-runs?limit=3", headers=auth_headers)
    assert r.status_code == 200
    rows = {x["id"]: x for x in r.json()}
    assert rows[macs.id]["scan_type"] == "macs"
    assert rows[macs.id]["new_devices"] == ["10.4.1.3"]
    assert rows[macs.id]["removed_devices"] == []
    # The range run is diffed against the older range run outside the window.
    assert rows[ranges.id]["new_devices"] == ["10.4.0.2"]
    assert rows[ranges.id]["removed_devices"] == []


def test_runs_without_timestamp_sort_after_dated_runs(client, auth_headers, db):
    """Legacy runs stored created_at=NULL; they must not displace the latest dated run."""
    legacy = _make_run(db, ["10.3.0.1"])
    legacy.created_at = None
    db.commit()
    dated = _make_run(db, ["10.3.0.1"], age_minutes=5)

    r = client.get("/api/scan-runs?limit=1", headers=auth_headers)
    assert r.status_code == 200
    assert [x["id"] for x in r.json()] == [dated.id]


def test_run_without_predecessor_has_empty_diff(client, auth_headers, db):
    """The very first run must report an empty diff instead of everything being 'new'."""
    _make_run(db, ["10.2.0.1", "10.2.0.2"], ["10.2.0.1|1|10.2.0.2|1"])

    r = client.get("/api/scan-runs", headers=auth_headers)
    assert r.status_code == 200
    runs = r.json()
    assert len(runs) == 1
    row = runs[0]
    assert row["new_devices"] == []
    assert row["removed_devices"] == []
    assert row["new_links"] == []
    assert row["removed_links"] == []


def test_scan_runs_include_switch_metrics(client, auth_headers, db):
    run = _make_run(db, ["10.3.0.1"])
    db.add(ScanRunSwitchMetric(
        scan_run_id=run.id, ip="10.3.0.1", label="sw1",
        duration_ms=55, success=True, error="",
    ))
    db.commit()

    r = client.get("/api/scan-runs", headers=auth_headers)
    assert r.status_code == 200
    metrics = r.json()[0]["switch_metrics"]
    assert len(metrics) == 1
    assert metrics[0]["ip"] == "10.3.0.1"
    assert metrics[0]["duration_ms"] == 55
    assert metrics[0]["success"] is True


def test_scan_runs_limit_clamped(client, auth_headers, db):
    for i in range(5):
        _make_run(db, [f"10.5.0.{i}"], age_minutes=60 - i)

    r = client.get("/api/scan-runs?limit=3", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 3

    r = client.get("/api/scan-runs?limit=99999", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 5
