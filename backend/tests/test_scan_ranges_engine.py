"""Scan engine tests for discovery scan ranges: due selection, target
building, SNMP pre-check, skip window, last_scan_at bookkeeping, endpoint
DNS hand-off, the scheduler due check and migration 032."""
import asyncio
import importlib
import importlib.util
import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import sqlalchemy as sa

from database import AppSetting, Credential, Device, Endpoint, PingCandidate, ScanRange, ScanRun, SnmpProfile
from schemas import ScanResult
from shared import scan_ranges as sr

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture()
def executor_mod():
    """Import the real scan_engine.executor despite the conftest package mock."""
    saved = {k: v for k, v in sys.modules.items() if k == "scan_engine" or k.startswith("scan_engine.")}
    for k in list(saved):
        sys.modules.pop(k, None)
    mod = importlib.import_module("scan_engine.executor")
    try:
        yield mod
    finally:
        for k in [k for k in sys.modules if k == "scan_engine" or k.startswith("scan_engine.")]:
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class _PingProcess:
    def __init__(self, ok):
        self.returncode = 0 if ok else 1

    async def communicate(self):
        return (b"reply time=2 ms", b"") if self.returncode == 0 else (b"", b"")

    async def wait(self):
        return self.returncode

    def kill(self):
        pass


def _fake_ping(monkeypatch, reachable):
    pinged = []

    async def fake_exec(*cmd, **kwargs):
        ip = next(a for a in cmd if isinstance(a, str) and a.count(".") == 3 and a[0].isdigit())
        pinged.append(ip)
        return _PingProcess(ip in reachable)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return pinged


def _sw(ip, sys_name="sw"):
    return types.SimpleNamespace(
        ip=ip, sys_name=sys_name, sys_descr="d", location="", firmware="", vendor="generic",
        interfaces={}, lldp_neighbors=[], arp_table={}, mac_ifindex={}, engine_id="",
    )


# -- shared.scan_ranges helpers ----------------------------------------------------

def test_normalize_scan_range():
    assert sr.normalize_scan_range("10.0.0.5/24") == "10.0.0.0/24"
    assert sr.normalize_scan_range(" 10.0.0.5 ") == "10.0.0.5"
    assert sr.normalize_scan_range("10.0.0.5/32") == "10.0.0.5"
    assert sr.normalize_scan_range("2001:db8::1/128") == "2001:db8::1"
    assert sr.normalize_scan_range("10.0.0.0/16") == "10.0.0.0/16"
    with pytest.raises(sr.ScanRangeError) as exc:
        sr.normalize_scan_range("10.0.0.0/15")
    assert exc.value.code == "RANGE_TOO_LARGE"
    with pytest.raises(sr.ScanRangeError) as exc:
        sr.normalize_scan_range("x")
    assert exc.value.code == "INVALID_IP_RANGE"
    assert sr.scan_range_host_count("10.0.0.0/30") == 2
    assert sr.range_ips("10.0.0.0/30") == ["10.0.0.1", "10.0.0.2"]
    assert sr.range_ips("10.0.0.9") == ["10.0.0.9"]


def test_range_is_due():
    now = datetime(2026, 1, 1, 12, 0, 0)
    assert sr.range_is_due(None, 600, now)
    assert sr.range_is_due(now - timedelta(seconds=600), 600, now)
    assert not sr.range_is_due(now - timedelta(seconds=599), 600, now)
    aware = (now - timedelta(seconds=700)).replace(tzinfo=timezone.utc)
    assert sr.range_is_due(aware, 600, now)


def test_load_scan_ranges_due_selection(db):
    now = datetime(2026, 1, 1, 12, 0, 0)
    db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").delete()
    db.add(AppSetting(key="discovery_interval_sec", value="1800"))
    db.add_all([
        ScanRange(cidr="10.0.1.0/24"),                                                  # never scanned
        ScanRange(cidr="10.0.2.0/24", last_scan_at=now - timedelta(seconds=1000)),      # global 1800
        ScanRange(cidr="10.0.3.0/24", last_scan_at=now - timedelta(seconds=1000), interval_sec=600),
        ScanRange(cidr="10.0.4.0/24", enabled=False),
        ScanRange(cidr="10.0.5.0/24", last_scan_at=now - timedelta(seconds=2000), profile_ids=[3, 3, "x"]),
    ])
    db.commit()
    due = sr.load_scan_ranges(db, due_only=True, now=now)
    assert [r["cidr"] for r in due] == ["10.0.1.0/24", "10.0.3.0/24", "10.0.5.0/24"]
    assert due[2]["profile_ids"] == [3]
    every = sr.load_scan_ranges(db, due_only=False, now=now)
    assert [r["cidr"] for r in every] == ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24", "10.0.5.0/24"]
    assert sr.any_scan_range_due(db, now=now)
    db.query(ScanRange).update({ScanRange.last_scan_at: now})
    db.commit()
    assert not sr.any_scan_range_due(db, now=now)


# -- target building -----------------------------------------------------------------

def _profiles():
    return [
        {"profile_id": 1, "snmp_version": "v2c", "community": "a"},
        {"profile_id": 2, "snmp_version": "v2c", "community": "b"},
        {"profile_id": 3, "snmp_version": "v2c", "community": "c"},
    ]


def test_range_probe_targets_dedupe_exclusion_and_profile_union(executor_mod):
    ranges = [
        {"cidr": "10.1.0.0/30", "profile_ids": [1]},            # .1 .2
        {"cidr": "10.1.0.2", "profile_ids": [3]},               # overlaps .2
        {"cidr": "10.1.0.4/30", "profile_ids": []},             # .5 .6, all profiles
        {"cidr": "10.1.0.5", "profile_ids": [2]},               # overlaps .5 (already all)
        {"cidr": "10.1.0.9", "profile_ids": [999]},             # stale id -> all profiles
    ]
    targets = executor_mod._range_probe_targets(ranges, {"10.1.0.6"}, _profiles(), 3, 1)
    by_ip = {t["ip"]: [p["profile_id"] for p in t["profiles_to_try"]] for t in targets}
    assert list(by_ip) == ["10.1.0.1", "10.1.0.2", "10.1.0.5", "10.1.0.9"]
    assert by_ip["10.1.0.1"] == [1]
    assert by_ip["10.1.0.2"] == [1, 3]
    assert by_ip["10.1.0.5"] == [1, 2, 3]
    assert by_ip["10.1.0.9"] == [1, 2, 3]
    assert all(t["is_range_probe"] and t["snmp_timeout"] == 3 for t in targets)


def test_build_range_setup_excludes_credentials_and_ignored(db, executor_mod):
    now = _now()
    db.add_all([
        ScanRange(cidr="10.2.0.0/29", last_scan_at=now - timedelta(days=1)),  # .1-.6, due
        ScanRange(cidr="10.3.0.1", last_scan_at=now),                         # not due
        Credential(ip="10.2.0.1", label="known", enabled=False),
        Device(ip="10.2.0.2", ignored=True),
        Device(ip="10.2.0.3", ignored=False),
        PingCandidate(ip="10.2.0.4", snmp_checked_at=now - timedelta(hours=1)),
        PingCandidate(ip="10.2.0.5", snmp_checked_at=now - timedelta(hours=10)),
    ])
    db.commit()
    setup = executor_mod._build_scan_setup(db, "ranges", "corr")
    ips = [t["ip"] for t in setup["scan_targets"]]
    assert ips == ["10.2.0.3", "10.2.0.4", "10.2.0.5", "10.2.0.6"]
    assert setup["credential_count"] == 0
    assert setup["ping_only_targets"] == {}
    assert setup["probe_skip_ips"] == {"10.2.0.4"}
    assert setup["probe_workers"] == 64
    # No SNMP profile: the v2c public fallback is used.
    assert setup["scan_targets"][0]["profiles_to_try"][0]["community"] == "public"
    due_ids = {r.id for r in db.query(ScanRange).filter(ScanRange.cidr == "10.2.0.0/29")}
    assert set(setup["range_ids"]) == due_ids

    setup_all = executor_mod._build_scan_setup(db, "ranges_all", "corr")
    assert "10.3.0.1" in [t["ip"] for t in setup_all["scan_targets"]]
    assert len(setup_all["range_ids"]) == 2
    # "Scan all" is an explicit request: the skip window does not apply.
    assert setup_all["probe_skip_ips"] == set()


def test_scan_now_range_ignores_skip_window(db, executor_mod):
    """A range reset by "Scan now" (or never scanned) re-probes every host;
    other due ranges in the same run keep the skip window."""
    now = _now()
    db.add_all([
        ScanRange(cidr="10.2.1.1", last_scan_at=None),                       # scan now
        ScanRange(cidr="10.2.2.1", last_scan_at=now - timedelta(days=1)),    # scheduled, due
        PingCandidate(ip="10.2.1.1", snmp_checked_at=now - timedelta(hours=1)),
        PingCandidate(ip="10.2.2.1", snmp_checked_at=now - timedelta(hours=1)),
    ])
    db.commit()
    setup = executor_mod._build_scan_setup(db, "ranges", "corr")
    assert sorted(t["ip"] for t in setup["scan_targets"]) == ["10.2.1.1", "10.2.2.1"]
    assert setup["probe_skip_ips"] == {"10.2.2.1"}


def test_full_and_discovery_setup_do_not_probe_ranges(db, executor_mod):
    db.add_all([ScanRange(cidr="10.4.0.0/30"), Credential(ip="10.4.9.9", label="c", enabled=True)])
    db.commit()
    for mode in ("full", "discovery"):
        setup = executor_mod._build_scan_setup(db, mode, "corr")
        assert [t["ip"] for t in setup["scan_targets"]] == ["10.4.9.9"]
        assert setup["range_target_count"] == 0
        assert setup["range_ids"] == []


def test_scan_priorities_include_range_modes():
    import shared.state as st

    assert st.SCAN_PRIORITY["ranges"] == 1
    assert st.SCAN_PRIORITY["ranges_all"] == 1


# -- SNMP pre-check selection -----------------------------------------------------------

def test_precheck_selects_answering_profiles_in_order(executor_mod, monkeypatch):
    prechecked = []

    async def precheck(ip, port, profile, timeout=1, engine=None):
        prechecked.append((profile["profile_id"], timeout))
        if profile["profile_id"] == 2:
            raise RuntimeError("boom")
        return profile["profile_id"] in (1, 3)

    scanned = []

    async def fake_scan(**kwargs):
        scanned.append((kwargs["community"], kwargs["scan_type"], kwargs["snmp_timeout"]))
        return _sw(kwargs["ip"]) if kwargs["community"] == "c" else None

    monkeypatch.setattr(executor_mod, "snmp_probe_profile", precheck)
    monkeypatch.setattr(executor_mod, "scan_switch", fake_scan)
    target = {"snmp_port": 161, "snmp_timeout": 3, "snmp_retries": 1, "profiles_to_try": [
        {**p, "v3_security_level": "", "v3_username": "", "v3_auth_protocol": "", "v3_auth_password": "",
         "v3_priv_protocol": "", "v3_priv_password": ""} for p in _profiles()
    ]}
    data, profile_id = asyncio.run(executor_mod._probe_range_host("10.5.0.1", target))
    # The pre-check uses the configured SNMP timeout of the target.
    assert sorted(prechecked) == [(1, 3), (2, 3), (3, 3)]
    # Profile 2 failed the pre-check: only 1 and 3 get a full discovery scan, in order.
    assert scanned == [("a", "discovery", 3), ("c", "discovery", 3)]
    assert data is not None and profile_id == 3


def test_precheck_no_answer_skips_full_scan(executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "snmp_probe_profile", AsyncMock(return_value=False))
    scan = AsyncMock()
    monkeypatch.setattr(executor_mod, "scan_switch", scan)
    target = {"snmp_port": 161, "snmp_timeout": 3, "snmp_retries": 1, "profiles_to_try": _profiles()}
    assert asyncio.run(executor_mod._probe_range_host("10.5.0.2", target)) == (None, None)
    scan.assert_not_called()


def test_snmp_probe_profile_uses_single_get_without_retries(monkeypatch):
    """The real snmp_scanner helper issues one sysObjectID GET with retries=0."""
    fake_pysnmp = MagicMock()
    for name in ("pysnmp", "pysnmp.hlapi", "pysnmp.hlapi.v3arch", "pysnmp.hlapi.v3arch.asyncio",
                 "pysnmp.proto", "pysnmp.proto.rfc1902", "pysnmp.proto.rfc1905"):
        monkeypatch.setitem(sys.modules, name, fake_pysnmp)
    spec = importlib.util.spec_from_file_location("_real_snmp_scanner_probe", BACKEND / "snmp_scanner.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # pragma: no cover - depends on optional imports
        pytest.skip("snmp_scanner not importable with a pysnmp stub: %s" % exc)
    calls = []

    async def fake_get(ip, port, auth, *oids, timeout=3, retries=1, engine=None, error_sink=None):
        calls.append((ip, port, oids, timeout, retries))
        return {oids[0]: "1.3.6.1.4.1.9"} if ip == "10.6.0.1" else {}

    monkeypatch.setattr(mod, "snmp_get", fake_get)
    monkeypatch.setattr(mod, "build_auth", lambda **kw: object())
    assert asyncio.run(mod.snmp_probe_profile("10.6.0.1", 161, {"snmp_version": "v2c"})) is True
    assert asyncio.run(mod.snmp_probe_profile("10.6.0.2", 161, {"snmp_version": "v2c"}, timeout=2)) is False
    assert calls == [
        ("10.6.0.1", 161, ("1.3.6.1.2.1.1.2.0",), 1, 0),
        ("10.6.0.2", 161, ("1.3.6.1.2.1.1.2.0",), 2, 0),
    ]


# -- full range scan runs ------------------------------------------------------------------

def test_range_scan_skip_window_and_bookkeeping(db, executor_mod, monkeypatch):
    now = _now()
    recent = now - timedelta(hours=1)
    old_seen = now - timedelta(days=1)
    db.add_all([
        ScanRange(cidr="10.7.0.0/29", last_scan_at=now - timedelta(days=1)),  # .1-.6, scheduled re-scan
        PingCandidate(ip="10.7.0.2", snmp_checked_at=recent, last_seen=old_seen, rtt_ms=99),
        PingCandidate(ip="10.7.0.3", snmp_checked_at=now - timedelta(hours=12), last_seen=old_seen),
    ])
    db.commit()
    # .1 answers SNMP, .2 skipped (recent check), .3/.4 ping only, .5/.6 no ping
    _fake_ping(monkeypatch, {"10.7.0.1", "10.7.0.2", "10.7.0.3", "10.7.0.4"})
    prechecked = []

    async def precheck(ip, port, profile, timeout=1, engine=None):
        prechecked.append(ip)
        return ip == "10.7.0.1"

    async def fake_scan(**kwargs):
        return _sw(kwargs["ip"], sys_name="new-switch")

    monkeypatch.setattr(executor_mod, "snmp_probe_profile", precheck)
    monkeypatch.setattr(executor_mod, "scan_switch", fake_scan)
    async def fake_resolve(ips, dns_servers=None, correlation_id="", concurrency=16):
        return {ip: f"host-{ip.rsplit('.', 1)[1]}.lan" for ip in ips if ip != "10.7.0.4"}

    monkeypatch.setattr(executor_mod, "resolve_hosts", fake_resolve)
    monkeypatch.setattr(executor_mod, "extract_model", lambda descr, vendor: "")
    monkeypatch.setattr(executor_mod, "auto_layout", lambda ips: {})

    result = asyncio.run(executor_mod._execute_scan(db, scan_type="ranges"))
    assert result.status == "finished"
    assert result.scanned == 6
    assert result.errors == []
    assert sorted(prechecked) == ["10.7.0.1", "10.7.0.3", "10.7.0.4"]

    db.expire_all()
    assert db.query(Credential).filter(Credential.ip == "10.7.0.1").one().label == "new-switch"
    assert db.query(Device).filter(Device.ip == "10.7.0.1").one().sys_name == "new-switch"
    cands = {c.ip: c for c in db.query(PingCandidate).all()}
    assert set(cands) == {"10.7.0.2", "10.7.0.3", "10.7.0.4"}
    # Skipped host: last_seen/rtt refreshed, snmp_checked_at untouched.
    assert cands["10.7.0.2"].snmp_checked_at == recent
    assert cands["10.7.0.2"].rtt_ms == 2
    assert cands["10.7.0.2"].last_seen.replace(tzinfo=None) > old_seen
    # Probed hosts get a fresh snmp_checked_at (existing and new candidates).
    assert cands["10.7.0.3"].snmp_checked_at >= now - timedelta(seconds=5)
    assert cands["10.7.0.4"].snmp_checked_at >= now - timedelta(seconds=5)
    # Candidates (also SNMP-skipped ones) get their reverse DNS name.
    assert cands["10.7.0.2"].hostname == "host-2.lan"
    assert cands["10.7.0.3"].hostname == "host-3.lan"
    assert cands["10.7.0.4"].hostname is None
    rng = db.query(ScanRange).one()
    assert rng.last_scan_at is not None and rng.last_scan_at >= now - timedelta(seconds=5)
    # The history counts only the SNMP device, not the ping-only hosts.
    assert result.found == 1
    run = db.query(ScanRun).filter(ScanRun.id == result.run_id).one()
    assert run.scan_type == "ranges"
    assert json.loads(run.devices_snapshot_json) == ["10.7.0.1"]


def _result(status="finished", scanned=1, found=1, errors=()):
    return ScanResult(scanned=scanned, found=found, links=0, errors=list(errors), status=status)


def test_full_ranges_runs_ranges_then_full(db, executor_mod, monkeypatch):
    real = executor_mod._execute_scan
    calls = []

    async def fake_execute(db_, cancel_event=None, correlation_id=None, scan_type="full", dry_run=False,
                           lock_token=None):
        if scan_type == "full_ranges":
            return await real(db_, cancel_event, correlation_id, scan_type, dry_run, lock_token)
        calls.append((scan_type, lock_token))
        if scan_type == "ranges_all":
            return _result(scanned=254, found=2, errors=["10.0.0.9: boom"])
        return _result(scanned=48, found=50)

    monkeypatch.setattr(executor_mod, "_execute_scan", fake_execute)
    result = asyncio.run(executor_mod._execute_scan(db, scan_type="full_ranges", lock_token="tok"))
    assert calls == [("ranges_all", "tok"), ("full", "tok")]
    assert (result.scanned, result.found, result.ranges_scanned, result.ranges_found) == (48, 50, 254, 2)
    assert result.errors == ["Range scan: 10.0.0.9: boom"]


def test_full_ranges_stops_after_cancelled_range_scan(db, executor_mod, monkeypatch):
    real = executor_mod._execute_scan
    calls = []

    async def fake_execute(db_, cancel_event=None, correlation_id=None, scan_type="full", dry_run=False,
                           lock_token=None):
        if scan_type == "full_ranges":
            return await real(db_, cancel_event, correlation_id, scan_type, dry_run, lock_token)
        calls.append(scan_type)
        return _result(status="cancelled")

    monkeypatch.setattr(executor_mod, "_execute_scan", fake_execute)
    result = asyncio.run(executor_mod._execute_scan(db, scan_type="full_ranges"))
    assert calls == ["ranges_all"]
    assert result.status == "cancelled"


def test_range_scan_skip_window_disabled(db, executor_mod, monkeypatch):
    db.add_all([
        AppSetting(key="scan_probe_skip_hours", value="0"),
        ScanRange(cidr="10.8.0.1"),
        PingCandidate(ip="10.8.0.1", snmp_checked_at=_now()),
    ])
    db.commit()
    setup = executor_mod._build_scan_setup(db, "ranges_all", "corr")
    assert setup["probe_skip_ips"] == set()


def test_range_scan_zero_targets_marks_ranges_scanned(db, executor_mod, monkeypatch):
    db.add_all([ScanRange(cidr="10.9.0.1"), Credential(ip="10.9.0.1", label="c", enabled=True)])
    db.commit()
    subprocess = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", subprocess)

    dry = asyncio.run(executor_mod._execute_scan(db, scan_type="ranges_all", dry_run=True))
    assert dry.scanned == 0 and dry.errors == []
    db.expire_all()
    assert db.query(ScanRange).one().last_scan_at is None

    result = asyncio.run(executor_mod._execute_scan(db, scan_type="ranges"))
    assert result.status == "finished"
    assert result.scanned == 0
    assert result.errors == []
    subprocess.assert_not_called()
    db.expire_all()
    assert db.query(ScanRange).one().last_scan_at is not None
    # Now nothing is due any more.
    assert not sr.any_scan_range_due(db)


def test_range_scan_without_ranges_is_quiet(db, executor_mod):
    result = asyncio.run(executor_mod._execute_scan(db, scan_type="ranges"))
    assert result.status == "finished"
    assert result.scanned == 0
    assert result.errors == []


def test_cancelled_range_scan_does_not_mark_ranges(db, executor_mod, monkeypatch):
    import threading

    db.add(ScanRange(cidr="10.10.0.1"))
    db.commit()
    cancel = threading.Event()
    cancel.set()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock())
    result = asyncio.run(executor_mod._execute_scan(db, cancel_event=cancel, scan_type="ranges"))
    assert result.status == "cancelled"
    db.expire_all()
    assert db.query(ScanRange).one().last_scan_at is None


def test_range_probes_use_probe_semaphore(db, executor_mod, monkeypatch):
    db.add_all([ScanRange(cidr="10.11.0.0/28"), AppSetting(key="scan_probe_workers", value="3")])
    db.commit()
    active = {"now": 0, "max": 0}

    async def slow_exec(*cmd, **kwargs):
        active["now"] += 1
        active["max"] = max(active["max"], active["now"])
        await asyncio.sleep(0.01)
        active["now"] -= 1
        return _PingProcess(False)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", slow_exec)
    result = asyncio.run(executor_mod._execute_scan(db, scan_type="ranges_all", dry_run=True))
    assert result.scanned == 14
    assert result.max_workers == 3
    assert active["max"] == 3


# -- finalize helpers --------------------------------------------------------------------------

def test_upsert_ping_candidates_sets_snmp_checked_at_only_for_probed(db, executor_mod):
    stamp = datetime(2026, 1, 1)
    db.add(PingCandidate(ip="10.12.0.1", snmp_checked_at=stamp))
    db.commit()
    ping = {"10.12.0.1": (True, 3), "10.12.0.2": (True, 4), "10.12.0.3": (True, 5)}
    executor_mod._upsert_ping_candidates(db, list(ping), ping, {"10.12.0.2"})
    db.commit()
    cands = {c.ip: c for c in db.query(PingCandidate).all()}
    assert cands["10.12.0.1"].snmp_checked_at == stamp
    assert cands["10.12.0.1"].rtt_ms == 3
    assert cands["10.12.0.2"].snmp_checked_at is not None
    assert cands["10.12.0.3"].snmp_checked_at is None


def test_finalize_uses_endpoint_hostnames(db, executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "extract_model", lambda descr, vendor: "")
    monkeypatch.setattr(executor_mod, "auto_layout", lambda ips: {})
    monkeypatch.setattr(executor_mod, "is_virtual", lambda descr, vendor: False)
    iface = types.SimpleNamespace(index=1, descr="1/1/1", alias="", speed_mbps=1000, oper_status=1, vlan=1,
                                  tagged_vlans=[], stp_state=None, stp_role=None, stp_path_cost=None)
    sw = _sw("10.13.0.1")
    sw.interfaces = {1: iface}
    sw.arp_table = {"aa:aa:aa:aa:aa:01": "10.13.0.50", "aa:aa:aa:aa:aa:02": "10.13.0.51"}
    sw.mac_ifindex = {"aa:aa:aa:aa:aa:01": 1, "aa:aa:aa:aa:aa:02": 1}
    executor_mod._finalize_scan_db(
        db, dry_run=False, scan_mode="ports", corr="t", cancel_event=None,
        switch_data={"10.13.0.1": sw}, ping_by_ip={"10.13.0.1": (True, 1)},
        range_found_ips=[], range_matched_profile={}, range_no_profile_ips=[],
        errors=[], status="finished", total_duration_ms=1, scanned=1, workers=1,
        switch_metrics=[], lock_token=None,
        endpoint_hostnames={"10.13.0.50": "pc50.lan"},
    )
    eps = {e.mac: e for e in db.query(Endpoint).all()}
    assert eps["aa:aa:aa:aa:aa:01"].hostname == "pc50.lan"
    assert eps["aa:aa:aa:aa:aa:02"].hostname is None


def test_collect_arp_ips_unique(executor_mod):
    a, b = _sw("1"), _sw("2")
    a.arp_table = {"m1": "10.0.0.1", "m2": "10.0.0.2", "m3": ""}
    b.arp_table = {"m4": "10.0.0.2", "m5": "10.0.0.3"}
    assert executor_mod._collect_arp_ips({"1": a, "2": b}) == ["10.0.0.1", "10.0.0.2", "10.0.0.3"]


def test_port_scan_resolves_endpoint_names_concurrently(db, executor_mod, monkeypatch):
    db.add_all([Credential(ip="10.14.0.1", label="sw", enabled=True), Device(ip="10.14.0.1")])
    db.commit()
    _fake_ping(monkeypatch, {"10.14.0.1"})
    sw = _sw("10.14.0.1")
    sw.arp_table = {"m1": "10.14.0.50", "m2": "10.14.0.51"}

    async def fake_scan(**kwargs):
        return sw

    resolved = []

    async def fake_resolve(ips, dns_servers=None, correlation_id="", concurrency=16):
        resolved.append((list(ips), concurrency))
        return {ip: "h-" + ip for ip in ips}

    captured = {}

    def fake_finalize(db_, **kwargs):
        captured.update(kwargs)
        return ScanResult(scanned=1, found=1, links=0, status="finished"), []

    monkeypatch.setattr(executor_mod, "scan_switch", fake_scan)
    monkeypatch.setattr(executor_mod, "resolve_hosts", fake_resolve)
    monkeypatch.setattr(executor_mod, "_finalize_scan_db", fake_finalize)
    asyncio.run(executor_mod._execute_scan(db, scan_type="ports"))
    assert resolved == [(["10.14.0.50", "10.14.0.51"], 32)]
    assert captured["endpoint_hostnames"] == {"10.14.0.50": "h-10.14.0.50", "10.14.0.51": "h-10.14.0.51"}
    assert captured["scan_range_ids"] == []


# -- scheduler ------------------------------------------------------------------------------------

def test_scheduler_ranges_due_check(db, executor_mod):
    scheduler = importlib.import_module("scan_engine.scheduler")
    assert scheduler._ranges_due() is False
    db.add(ScanRange(cidr="10.15.0.0/24"))
    db.commit()
    assert scheduler._ranges_due() is True


def test_background_scheduler_dispatches_ranges_when_due(executor_mod, monkeypatch):
    import threading

    scheduler = importlib.import_module("scan_engine.scheduler")
    calls = []
    due_checks = []
    ticks = {"n": 0}

    class _Wake:
        def wait(self, timeout=None):
            ticks["n"] += 1
            if ticks["n"] > 3:
                scheduler._shutdown_requested.set()
            return True

        def clear(self):
            pass

    monkeypatch.setattr(scheduler, "_scheduler_wake", _Wake())
    monkeypatch.setattr(scheduler, "_shutdown_requested", threading.Event())
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(scheduler, "_read_scheduler_intervals",
                        lambda db: {"discovery": 0, "links": 0, "macs": 300})
    monkeypatch.setattr(scheduler, "_ranges_due", lambda: due_checks.append(1) or True)
    monkeypatch.setattr(scheduler, "_dispatch_scheduled_scan", lambda kind: calls.append(kind) or True)
    scheduler._background_scheduler()
    # Three ticks within a few seconds: the range due check runs once.
    assert calls == ["macs", "ranges"]
    assert due_checks == [1]


def test_background_scheduler_skips_ranges_when_nothing_due(executor_mod, monkeypatch):
    import threading

    scheduler = importlib.import_module("scan_engine.scheduler")
    calls = []
    ticks = {"n": 0}

    class _Wake:
        def wait(self, timeout=None):
            ticks["n"] += 1
            if ticks["n"] > 1:
                scheduler._shutdown_requested.set()
            return True

        def clear(self):
            pass

    monkeypatch.setattr(scheduler, "_scheduler_wake", _Wake())
    monkeypatch.setattr(scheduler, "_shutdown_requested", threading.Event())
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(scheduler, "_read_scheduler_intervals",
                        lambda db: {"discovery": 0, "links": 0, "macs": 0})
    monkeypatch.setattr(scheduler, "_ranges_due", lambda: False)
    monkeypatch.setattr(scheduler, "_dispatch_scheduled_scan", lambda kind: calls.append(kind) or True)
    scheduler._background_scheduler()
    assert calls == []


def test_scheduler_tick_claims_ranges_only_when_due(executor_mod, monkeypatch):
    tasks = importlib.import_module("tasks")
    scheduler = importlib.import_module("scan_engine.scheduler")
    claims = []
    dispatched = []
    due = {"value": False}
    monkeypatch.setattr(tasks, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(tasks, "_maybe_reap_stale_jobs", lambda: None)
    monkeypatch.setattr(scheduler, "_blocked_kinds", set())
    monkeypatch.setattr(scheduler, "_read_scheduler_intervals",
                        lambda db: {"discovery": 0, "links": 0, "macs": 0})
    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: True)
    monkeypatch.setattr(scheduler, "_ranges_due", lambda: due["value"])
    monkeypatch.setattr(tasks, "claim_scheduled_dispatch_token",
                        lambda kind, interval: claims.append((kind, interval)) or "tok")
    monkeypatch.setattr(scheduler, "_dispatch_scheduled_scan", lambda kind: dispatched.append(kind) or True)

    tasks.scheduler_tick.run()
    assert claims == [] and dispatched == []
    due["value"] = True
    tasks.scheduler_tick.run()
    assert claims == [("ranges", 60)]
    assert dispatched == ["ranges"]


# -- migration 032 -----------------------------------------------------------------------------------

def _load_migration():
    spec = importlib.util.spec_from_file_location("_mig032", BACKEND / "alembic" / "versions" / "032_scan_ranges.py")
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    return mig


def test_migration_032_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mig = _load_migration()
    assert mig.revision == "032" and mig.down_revision == "031"
    eng = sa.create_engine("sqlite://")
    legacy = ["10.0.0.5/24", "10.0.0.0/24", "bogus", "10.1.0.0/8", "192.168.1.1/32", "192.168.1.1"]
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE app_settings (key VARCHAR PRIMARY KEY, value TEXT)"))
        conn.execute(sa.text("CREATE TABLE ping_candidates (id INTEGER PRIMARY KEY, ip VARCHAR)"))
        conn.execute(sa.text("INSERT INTO app_settings (key, value) VALUES ('discovery_scan_ranges', :v)"),
                     {"v": json.dumps(legacy)})
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        insp = sa.inspect(conn)
        assert "snmp_checked_at" in {c["name"] for c in insp.get_columns("ping_candidates")}
        rows = conn.execute(sa.text("SELECT cidr, label, enabled, interval_sec FROM scan_ranges ORDER BY cidr")).fetchall()
        assert [r[0] for r in rows] == ["10.0.0.0/24", "192.168.1.1"]
        assert all(r[1] == "" and r[2] and r[3] is None for r in rows)
        assert conn.execute(sa.text("SELECT COUNT(*) FROM app_settings")).scalar() == 0

        mig.downgrade()
        insp = sa.inspect(conn)
        assert "scan_ranges" not in insp.get_table_names()
        assert {c["name"] for c in insp.get_columns("ping_candidates")} == {"id", "ip"}
        value = conn.execute(sa.text("SELECT value FROM app_settings WHERE key = 'discovery_scan_ranges'")).scalar()
        assert json.loads(value) == ["10.0.0.0/24", "192.168.1.1"]


def test_migration_032_without_legacy_row():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mig = _load_migration()
    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE app_settings (key VARCHAR PRIMARY KEY, value TEXT)"))
        conn.execute(sa.text("CREATE TABLE ping_candidates (id INTEGER PRIMARY KEY, ip VARCHAR)"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        assert conn.execute(sa.text("SELECT COUNT(*) FROM scan_ranges")).scalar() == 0
        mig.downgrade()
        value = conn.execute(sa.text("SELECT value FROM app_settings WHERE key = 'discovery_scan_ranges'")).scalar()
        assert value == "[]"


def test_snmp_profile_model_unchanged_by_ranges(db):
    """Sanity: a range may reference profiles by id (JSON list)."""
    prof = SnmpProfile(label="p", snmp_version="v2c", community="c")
    db.add(prof)
    db.commit()
    db.add(ScanRange(cidr="10.16.0.0/24", profile_ids=[prof.id]))
    db.commit()
    assert db.query(ScanRange).one().profile_ids == [prof.id]
