"""Tests for scan_engine/db_helpers.py utility functions."""
import sys

# Remove scan_engine mock so we can import the real module
sys.modules.pop("scan_engine", None)
import scan_engine.db_helpers as _dbh  # noqa: E402

_safe_json_list = _dbh._safe_json_list
_canonical_link_key = _dbh._canonical_link_key
_persist_scan_run = _dbh._persist_scan_run
_read_discovery_ranges = _dbh._read_discovery_ranges
_expand_ranges_to_ips = _dbh._expand_ranges_to_ips

from database import AppSetting, ScanRange, ScanRun, ScanRunSwitchMetric  # noqa: E402
from schemas import ScanResult, ScanSwitchMetric  # noqa: E402

# -- _safe_json_list ----------------------------------------------------------

def test_safe_json_list_valid():
    assert _safe_json_list('["a", "b", "c"]') == ["a", "b", "c"]


def test_safe_json_list_empty_string():
    assert _safe_json_list("") == []


def test_safe_json_list_none():
    assert _safe_json_list(None) == []


def test_safe_json_list_invalid_json():
    assert _safe_json_list("{not json}") == []


def test_safe_json_list_non_list_json():
    assert _safe_json_list('"just a string"') == []


# -- _canonical_link_key -------------------------------------------------------

def test_canonical_link_key():
    result = _canonical_link_key("10.0.0.1", "Gi0/1", "10.0.0.2", "Gi0/2")
    assert result == "10.0.0.1|Gi0/1|10.0.0.2|Gi0/2"


# -- _expand_ranges_to_ips ----------------------------------------------------

def test_expand_ranges_single_ip():
    result = _expand_ranges_to_ips(["192.168.1.1"])
    assert result == ["192.168.1.1"]


def test_expand_ranges_cidr():
    result = _expand_ranges_to_ips(["192.168.1.0/30"])
    assert sorted(result) == ["192.168.1.1", "192.168.1.2"]


def test_expand_ranges_skips_oversized():
    result = _expand_ranges_to_ips(["10.0.0.0/8"])
    assert result == []


def test_expand_ranges_invalid_entry():
    result = _expand_ranges_to_ips(["not-an-ip"])
    assert result == []


# -- _read_discovery_ranges ---------------------------------------------------

def test_read_discovery_ranges_returns_enabled_range_cidrs(db):
    db.add_all([
        ScanRange(cidr="192.168.1.0/24"),
        ScanRange(cidr="10.0.0.0/24"),
        ScanRange(cidr="172.16.0.0/24", enabled=False),
    ])
    db.commit()
    result = _read_discovery_ranges(db)
    assert result == ["10.0.0.0/24", "192.168.1.0/24"]


def test_read_discovery_ranges_ignores_legacy_setting(db):
    db.add(AppSetting(key="discovery_scan_ranges", value='["10.0.0.0/24"]'))
    db.commit()
    assert _read_discovery_ranges(db) == []


def test_read_discovery_ranges_missing(db):
    result = _read_discovery_ranges(db)
    assert result == []


# -- _persist_scan_run ---------------------------------------------------------

def test_persist_scan_run(db):
    sr = ScanResult(
        scanned=5,
        found=3,
        links=2,
        errors=[],
        max_workers=4,
        total_duration_ms=1200,
        switch_metrics=[
            ScanSwitchMetric(ip="10.0.0.1", label="sw1", duration_ms=100, success=True),
        ],
        status="finished",
    )
    run_id = _persist_scan_run(db, sr, ["10.0.0.1", "10.0.0.2"], ["link1"], scan_type="macs")
    assert isinstance(run_id, int)

    run = db.query(ScanRun).filter(ScanRun.id == run_id).one()
    assert run.scan_type == "macs"
    assert run.scanned == 5
    assert run.found == 3
    assert run.status == "finished"

    metrics = db.query(ScanRunSwitchMetric).filter(ScanRunSwitchMetric.scan_run_id == run_id).all()
    assert len(metrics) == 1
    assert metrics[0].ip == "10.0.0.1"
