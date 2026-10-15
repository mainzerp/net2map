"""Scan engine hardening: non-blocking Redis/DB access on the scan loop, stale
job reaping, LLDP local port mapping, endpoint expiry, bounded DNS lookups,
MAC decoding, scheduler/lock state handling and scanner registry defaults."""
import asyncio
import importlib
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

import shared.redis_client
import shared.state as _st
from database import Device, Endpoint, EndpointPortAssociation, Port
from scanners.parsing import _hex_to_mac, mac_from_octets, map_lldp_local_ports
from tests.test_stp_vlan import _finalize, _iface, _install_fakes, _sw, executor_mod, scanner  # noqa: F401

# ---------------------------------------------------------------------------
# 1. Cancel event / broadcasts / lease renewal off the event loop
# ---------------------------------------------------------------------------


def _tasks_module():
    return importlib.import_module("tasks")


def test_redis_cancel_event_is_set_reads_cached_flag(executor_mod, monkeypatch):  # noqa: F811
    tasks = _tasks_module()
    calls = []
    flag = {"value": False}

    def fake_is_cancel_requested(job_id):
        calls.append(threading.get_ident())
        return flag["value"]

    monkeypatch.setattr(tasks, "is_cancel_requested", fake_is_cancel_requested)
    event = tasks._RedisCancelEvent("job-1", poll_interval=0.01).start()
    try:
        polled = len(calls)
        for _ in range(100):
            assert event.is_set() is False
        # is_set() itself never polls Redis
        assert len(calls) - polled < 100
        flag["value"] = True
        deadline = time.time() + 2
        while not event.is_set() and time.time() < deadline:
            time.sleep(0.01)
        assert event.is_set() is True
        # The poller runs on its own thread, not the caller's
        assert any(ident != threading.get_ident() for ident in calls)
    finally:
        event.stop()
    # Once observed, a cancellation stays set
    flag["value"] = False
    assert event.is_set() is True


def test_redis_cancel_event_initial_poll_and_set(executor_mod, monkeypatch):  # noqa: F811
    tasks = _tasks_module()
    monkeypatch.setattr(tasks, "is_cancel_requested", lambda job_id: True)
    event = tasks._RedisCancelEvent("job-2", poll_interval=10).start()
    assert event.is_set() is True
    event.stop()

    requested = []
    monkeypatch.setattr(tasks, "is_cancel_requested", lambda job_id: False)
    monkeypatch.setattr(_st, "request_scan_cancel", requested.append)
    other = tasks._RedisCancelEvent("job-3", poll_interval=10).start()
    try:
        assert other.is_set() is False
        other.set()
        assert other.is_set() is True and requested == ["job-3"]
    finally:
        other.stop()


def test_broadcast_nowait_runs_off_caller_thread_in_order(executor_mod):  # noqa: F811
    broadcast = importlib.import_module("scan_engine.broadcast")
    seen = []
    done = threading.Event()

    def record(i):
        seen.append((i, threading.get_ident()))
        if i == 9:
            done.set()

    for i in range(10):
        broadcast.broadcast_nowait(record, i)
    assert done.wait(2)
    assert [i for i, _ in seen] == list(range(10))
    assert all(ident != threading.get_ident() for _, ident in seen)


def test_lease_renewal_runs_off_event_loop(db, executor_mod, monkeypatch):  # noqa: F811
    loop_threads = set()
    renew_threads = []

    def renewal(token):
        renew_threads.append(threading.get_ident())
        return True

    monkeypatch.setattr(executor_mod, "renew_scan_lock", renewal)
    monkeypatch.setattr(executor_mod, "_LOCK_RENEW_INTERVAL_SEC", 0.001)

    async def slow_scan(*args):
        loop_threads.add(threading.get_ident())
        while len(renew_threads) < 3:
            await asyncio.sleep(0.005)
        from schemas import ScanResult
        return ScanResult(scanned=0, found=0, links=0, errors=[], status="finished")

    monkeypatch.setattr(executor_mod, "_execute_scan_body", slow_scan)
    asyncio.run(executor_mod._execute_scan(db, lock_token="owner"))
    assert renew_threads and not (set(renew_threads) & loop_threads)


# ---------------------------------------------------------------------------
# 2. Setup phase runs in a worker thread with its own session
# ---------------------------------------------------------------------------


def test_scan_setup_runs_in_worker_thread(db, executor_mod, monkeypatch):  # noqa: F811
    from database import Credential

    db.add(Credential(ip="10.8.8.8", label="sw", enabled=True, snmp_enabled=False))
    db.commit()
    threads = {}
    original = executor_mod._build_scan_setup

    def recording(session, scan_mode, corr):
        threads["setup"] = threading.get_ident()
        threads["session"] = session
        return original(session, scan_mode, corr)

    monkeypatch.setattr(executor_mod, "_build_scan_setup", recording)
    cancel = threading.Event()
    cancel.set()

    async def run():
        threads["loop"] = threading.get_ident()
        return await executor_mod._execute_scan(db, cancel_event=cancel, dry_run=True)

    result = asyncio.run(run())
    assert threads["setup"] != threads["loop"]
    assert threads["session"] is not db
    assert result.scanned == 1


# ---------------------------------------------------------------------------
# 3. Stale queued/retrying job reaper
# ---------------------------------------------------------------------------


@pytest.fixture()
def memory_jobs(monkeypatch):
    monkeypatch.setattr(_st, "get_redis", lambda: None)
    created = []
    yield created
    for job_id in created:
        _st.delete_scan_job(job_id)


def test_reaper_fails_stale_queued_and_retrying_jobs(memory_jobs, executor_mod):  # noqa: F811
    jobs = importlib.import_module("scan_engine.jobs")
    now = datetime.now(timezone.utc)
    old = (now - timedelta(minutes=20)).isoformat()
    fresh = (now - timedelta(minutes=2)).isoformat()
    specs = {
        "test-reap-queued": {"status": "queued", "started_at": old},
        "test-reap-retrying": {"status": "retrying", "started_at": old, "status_at": old},
        "test-keep-fresh-queued": {"status": "queued", "started_at": fresh},
        # Long scan that just failed into "retrying": age counts from status_at
        "test-keep-fresh-retrying": {"status": "retrying", "started_at": old, "status_at": fresh},
        "test-keep-running": {"status": "running", "started_at": old},
    }
    for job_id, data in specs.items():
        memory_jobs.append(job_id)
        _st.set_scan_job(job_id, {"id": job_id, **data})

    reaped = jobs.reap_stale_queued_jobs(now=now)

    assert sorted(reaped) == ["test-reap-queued", "test-reap-retrying"]
    job = _st.get_scan_job("test-reap-queued")
    assert job["status"] == "failed" and job["finished_at"] and job["reaped"] is True
    assert "Celery worker" in job["result"]["errors"][0]
    for job_id in ("test-keep-fresh-queued", "test-keep-fresh-retrying", "test-keep-running"):
        assert _st.get_scan_job(job_id)["status"] == specs[job_id]["status"]


def test_reaper_does_not_overwrite_job_picked_up_concurrently(memory_jobs, executor_mod, monkeypatch):  # noqa: F811
    jobs = importlib.import_module("scan_engine.jobs")
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    memory_jobs.append("test-race")
    _st.set_scan_job("test-race", {"id": "test-race", "status": "queued", "started_at": old})
    snapshot = _st.list_scan_jobs()
    # A worker picks the job up after the reaper listed it
    _st.update_scan_job("test-race", {"status": "running"})
    monkeypatch.setattr(jobs, "list_scan_jobs", lambda: snapshot)
    assert jobs.reap_stale_queued_jobs() == []
    assert _st.get_scan_job("test-race")["status"] == "running"


def test_scheduler_tick_runs_throttled_reaper(executor_mod, monkeypatch):  # noqa: F811
    tasks = _tasks_module()
    jobs = importlib.import_module("scan_engine.jobs")
    scheduler = importlib.import_module("scan_engine.scheduler")
    reaps = []
    monkeypatch.setattr(jobs, "reap_stale_queued_jobs", lambda: reaps.append(1))
    monkeypatch.setattr(tasks, "_last_reap", 0.0)
    monkeypatch.setattr(tasks, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(scheduler, "_read_scheduler_intervals",
                        lambda db: {"discovery": 0, "links": 0, "macs": 0})
    tasks.scheduler_tick.run()
    tasks.scheduler_tick.run()
    assert reaps == [1]


def test_reaped_job_is_not_resurrected_by_late_task(memory_jobs, executor_mod, monkeypatch):  # noqa: F811
    tasks = _tasks_module()
    memory_jobs.append("test-late")
    _st.set_scan_job("test-late", {"id": "test-late", "status": "failed", "reaped": True})
    acquire = MagicMock()
    monkeypatch.setattr(tasks, "acquire_scan_lock", acquire)
    tasks.run_scan_task.run("test-late")
    acquire.assert_not_called()
    assert _st.get_scan_job("test-late")["status"] == "failed"


# ---------------------------------------------------------------------------
# 4. LLDP local port mapping
# ---------------------------------------------------------------------------

_LOC = "1.0.8802.1.1.2.1.3.7.1"


def test_map_lldp_local_ports_resolution_order():
    if_descr = {1001: "GigabitEthernet1/0/1", 1002: "GigabitEthernet1/0/2", 1003: "Te1/1/1", 7: "dup", 8: "dup"}
    if_name = {1001: "Gi1/0/1", 1002: "Gi1/0/2"}
    if_alias = {1003: "uplink"}
    subtypes = [(f"{_LOC}.2.1", "5"), (f"{_LOC}.2.2", "3"), (f"{_LOC}.2.3", "7"),
                (f"{_LOC}.2.4", "1"), (f"{_LOC}.2.5", "7"), (f"{_LOC}.2.6", "5")]
    ids = [(f"{_LOC}.3.1", "Gi1/0/1"), (f"{_LOC}.3.2", "aa:bb:cc:dd:ee:ff"), (f"{_LOC}.3.3", "1003"),
           (f"{_LOC}.3.4", "uplink"), (f"{_LOC}.3.5", "999"), (f"{_LOC}.3.6", "dup")]
    descs = [(f"{_LOC}.4.2", "GigabitEthernet1/0/2")]
    result = map_lldp_local_ports(subtypes, ids, descs, if_descr, if_name, if_alias)
    assert result == {1: 1001, 2: 1002, 3: 1003, 4: 1003}
    # 5: local subtype with an unknown number, 6: ambiguous name -> no mapping


def test_map_lldp_local_ports_empty_tables():
    assert map_lldp_local_ports([], [], [], {1: "1/1/1"}) == {}


def _lldp_walks(scanner):  # noqa: F811
    rem = "1.0.8802.1.1.2.1.4.1.1"
    return {
        scanner.OID_IF_DESCR: [(f"{scanner.OID_IF_DESCR}.1001", "1/1/1"),
                               (f"{scanner.OID_IF_DESCR}.1002", "1/1/2")],
        scanner.OID_IF_NAME: [(f"{scanner.OID_IF_NAME}.1001", "1/1/1"),
                              (f"{scanner.OID_IF_NAME}.1002", "1/1/2")],
        scanner.OID_LLDP_REM_SYS_NAME: [(f"{rem}.9.0.1.1", "core"), (f"{rem}.9.0.2.1", "edge"),
                                        (f"{rem}.9.0.9.1", "unknown-port")],
        scanner.OID_LLDP_REM_PORT_ID: [(f"{rem}.7.0.1.1", "49"), (f"{rem}.7.0.2.1", "50"),
                                       (f"{rem}.7.0.9.1", "51")],
        # No lldpRemPortDesc row for local port 2
        scanner.OID_LLDP_REM_PORT_DESC: [(f"{rem}.8.0.1.1", "1/1/49")],
        scanner.OID_LLDP_LOC_PORT_ID_SUBTYPE: [(f"{_LOC}.2.1", "5"), (f"{_LOC}.2.2", "5"),
                                               (f"{_LOC}.2.9", "5")],
        scanner.OID_LLDP_LOC_PORT_ID: [(f"{_LOC}.3.1", "1/1/1"), (f"{_LOC}.3.2", "1/1/2"),
                                       (f"{_LOC}.3.9", "mgmt")],
        scanner.OID_LLDP_LOC_PORT_DESC: [(f"{_LOC}.4.9", "Management port")],
    }


def test_scan_maps_lldp_local_port_num_to_ifindex(scanner, monkeypatch):  # noqa: F811
    _install_fakes(scanner, monkeypatch, walks=_lldp_walks(scanner))
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="links"))
    by_sys = {n.remote_sys: n for n in sw.lldp_neighbors}
    assert by_sys["core"].local_port_idx == 1001 and by_sys["core"].local_port_desc == "1/1/1"
    assert by_sys["core"].remote_port == "1/1/49"
    # local_port_desc is filled even without a lldpRemPortDesc row
    assert by_sys["edge"].local_port_idx == 1002 and by_sys["edge"].local_port_desc == "1/1/2"
    # Unmapped local port: legacy 1:1 index, name from lldpLocPortDesc
    assert by_sys["unknown-port"].local_port_idx == 9
    assert by_sys["unknown-port"].local_port_desc == "Management port"


def test_scan_without_local_port_table_keeps_legacy_index(scanner, monkeypatch):  # noqa: F811
    walks = _lldp_walks(scanner)
    for oid in (scanner.OID_LLDP_LOC_PORT_ID_SUBTYPE, scanner.OID_LLDP_LOC_PORT_ID,
                scanner.OID_LLDP_LOC_PORT_DESC):
        walks.pop(oid)
    walks[scanner.OID_IF_DESCR] = [(f"{scanner.OID_IF_DESCR}.1", "1/1/1"), (f"{scanner.OID_IF_DESCR}.2", "1/1/2")]
    walks.pop(scanner.OID_IF_NAME)
    _install_fakes(scanner, monkeypatch, walks=walks)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="links"))
    by_sys = {n.remote_sys: n for n in sw.lldp_neighbors}
    assert by_sys["core"].local_port_idx == 1 and by_sys["core"].local_port_desc == "1/1/1"
    assert by_sys["edge"].local_port_idx == 2 and by_sys["edge"].local_port_desc == "1/1/2"
    assert by_sys["unknown-port"].local_port_desc == ""


# ---------------------------------------------------------------------------
# 5. Endpoint expiry after successful full scans
# ---------------------------------------------------------------------------


def _endpoint_fixture(db, now):
    dev = Device(ip="10.9.0.1", sys_name="sw")
    db.add(dev)
    db.flush()
    port = Port(device_id=dev.id, if_index=99, if_descr="old")
    db.add(port)
    db.flush()
    stale = Endpoint(mac="aa:aa:aa:aa:aa:01", last_seen=now - timedelta(days=40))
    recent = Endpoint(mac="aa:aa:aa:aa:aa:02", last_seen=now - timedelta(days=5))
    ignored = Endpoint(mac="aa:aa:aa:aa:aa:03", last_seen=now - timedelta(days=40), ignored=True)
    noted = Endpoint(mac="aa:aa:aa:aa:aa:04", last_seen=now - timedelta(days=40), notes="printer")
    db.add_all([stale, recent, ignored, noted])
    db.flush()
    db.add(EndpointPortAssociation(endpoint_id=stale.id, port_id=port.id))
    db.commit()
    return dev


def _full_finalize(executor_mod, db, status="finished", cancel_event=None):  # noqa: F811
    sw = _sw("10.9.0.1", interfaces={1: _iface(1, "1/1/1")})
    return executor_mod._finalize_scan_db(
        db, dry_run=False, scan_mode="full", corr="test", cancel_event=cancel_event,
        switch_data={"10.9.0.1": sw}, ping_by_ip={"10.9.0.1": (True, 1)},
        range_found_ips=[], range_matched_profile={}, range_no_profile_ips=[],
        errors=[], status=status, total_duration_ms=1, scanned=1,
        workers=1, switch_metrics=[], lock_token=None,
    )


def _macs(db):
    db.expire_all()
    return {e.mac for e in db.query(Endpoint).all()}


def test_full_scan_expires_stale_endpoints(db, executor_mod, monkeypatch):  # noqa: F811
    monkeypatch.setattr(executor_mod, "_read_db_setting", lambda key, default: default)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _endpoint_fixture(db, now)
    _full_finalize(executor_mod, db)
    assert _macs(db) == {"aa:aa:aa:aa:aa:02", "aa:aa:aa:aa:aa:03", "aa:aa:aa:aa:aa:04"}
    assert db.query(EndpointPortAssociation).count() == 0


@pytest.mark.parametrize("setting", ["0", "garbage-not-int"])
def test_endpoint_retention_disabled_or_invalid(db, executor_mod, monkeypatch, setting):  # noqa: F811
    monkeypatch.setattr(executor_mod, "_read_db_setting", lambda key, default: setting)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _endpoint_fixture(db, now)
    _full_finalize(executor_mod, db)
    expected = {"aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02", "aa:aa:aa:aa:aa:03", "aa:aa:aa:aa:aa:04"}
    if setting != "0":
        # Invalid values fall back to the 30 day default
        expected.discard("aa:aa:aa:aa:aa:01")
    assert _macs(db) == expected


def test_retention_days_clamped(executor_mod, monkeypatch):  # noqa: F811
    for raw, expected in (("-5", 0), ("99999", 3650), ("7", 7)):
        monkeypatch.setattr(executor_mod, "_read_db_setting", lambda key, default, raw=raw: raw)
        assert executor_mod._read_endpoint_retention_days() == expected


def test_cancelled_or_partial_scans_never_expire_endpoints(db, executor_mod, monkeypatch):  # noqa: F811
    monkeypatch.setattr(executor_mod, "_read_db_setting", lambda key, default: default)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _endpoint_fixture(db, now)
    cancel = threading.Event()
    cancel.set()
    _full_finalize(executor_mod, db, status="cancelled", cancel_event=cancel)
    assert "aa:aa:aa:aa:aa:01" in _macs(db)
    # Non-full scan types never prune either
    _finalize(executor_mod, db, {"10.9.0.1": _sw("10.9.0.1", interfaces={1: _iface(1, "1/1/1")})}, "macs")
    assert "aa:aa:aa:aa:aa:01" in _macs(db)


# ---------------------------------------------------------------------------
# 6. Bounded DNS lookups
# ---------------------------------------------------------------------------


def test_reverse_dns_lookup_is_bounded(executor_mod, monkeypatch):  # noqa: F811
    dns = importlib.import_module("scan_engine.dns")
    release = threading.Event()

    def hanging(ip):
        release.wait(5)
        return ("late.example", [], [])

    monkeypatch.setattr(dns.socket, "gethostbyaddr", hanging)
    monkeypatch.setattr(dns, "_SYSTEM_DNS_TIMEOUT_SEC", 0.05)
    started = time.perf_counter()
    try:
        assert dns._resolve_host("10.1.1.1", {}) == ""
        assert dns._resolve_ip("not-in-batch", {}) == ""
    finally:
        release.set()
    assert time.perf_counter() - started < 2


def test_dns_lookup_success_still_works(executor_mod, monkeypatch):  # noqa: F811
    dns = importlib.import_module("scan_engine.dns")
    monkeypatch.setattr(dns.socket, "gethostbyname", lambda name: "10.2.2.2")
    assert dns._resolve_ip("host", {}) == "10.2.2.2"


# ---------------------------------------------------------------------------
# 7. MAC decoding
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value, expected", [
    ("00:1A:2b:3c:4d:5e", "00:1a:2b:3c:4d:5e"),
    ("0x001a2b3c4d5e", "00:1a:2b:3c:4d:5e"),
    ("00-1a-2b-3c-4d-5e", "00:1a:2b:3c:4d:5e"),
    ("001a.2b3c.4d5e", "00:1a:2b:3c:4d:5e"),
    ("00 1a 2b 3c 4d 5e", "00:1a:2b:3c:4d:5e"),
    ("ABCDEF", ""),            # printable pseudo-MAC text
    ("+<M^", ""),
    ("00:1a:2b:3c:4d", ""),
    ("zz:1a:2b:3c:4d:5e", ""),
    ("", ""),
    (None, ""),
])
def test_hex_to_mac_validates(value, expected):
    assert _hex_to_mac(value) == expected


@pytest.mark.parametrize("value, expected", [
    (b"ABCDEF", "41:42:43:44:45:46"),           # all printable bytes
    (b"\x00\x1a+<M^", "00:1a:2b:3c:4d:5e"),
    (b"00:1a:2b:3c:4d:5e", "00:1a:2b:3c:4d:5e"),  # textual rendering
    (b"", ""),
    (b"\x01\x02\x03", ""),
    ("aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"),
    (None, ""),
])
def test_mac_from_octets(value, expected):
    assert mac_from_octets(value) == expected


def test_arp_walk_decodes_printable_mac_bytes(scanner, monkeypatch):  # noqa: F811
    walks = {
        scanner.OID_IF_DESCR: [(f"{scanner.OID_IF_DESCR}.1", "1/1/1")],
        scanner.OID_ARP_IP: [(f"{scanner.OID_ARP_IP}.1.10.0.0.5", "10.0.0.5"),
                             (f"{scanner.OID_ARP_IP}.1.10.0.0.6", "10.0.0.6")],
    }
    raw = {
        scanner.OID_ARP_MAC: [(f"{scanner.OID_ARP_MAC}.1.10.0.0.5", b"ABCDEF"),
                              (f"{scanner.OID_ARP_MAC}.1.10.0.0.6", b"")],
    }
    _install_fakes(scanner, monkeypatch, walks=walks)

    async def fake_walk_raw(ip, port, auth, oid, **kw):
        return list(raw.get(oid, []))

    monkeypatch.setattr(scanner, "snmp_bulk_walk_raw", fake_walk_raw)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs", collect_vlan=False, collect_stp=False))
    assert sw.arp_table == {"41:42:43:44:45:46": "10.0.0.5"}


# ---------------------------------------------------------------------------
# 9. Waiting set with unique, expiring members
# ---------------------------------------------------------------------------


class _ZsetRedis:
    """Redis stand-in for the scan lock: sorted set plus the lock scripts."""

    def __init__(self, hold_lock=False):
        self.zset = {}
        self.data = {}
        self.hold_lock = hold_lock
        self.added = []

    def zadd(self, key, mapping):
        self.added.extend(mapping)
        self.zset.update(mapping)

    def zrem(self, key, *members):
        for m in members:
            self.zset.pop(m, None)

    def zrange(self, key, start, end, withscores=False):
        return sorted(self.zset.items(), key=lambda kv: kv[1])

    def get(self, key):
        return self.data.get(key)

    def eval(self, script, numkeys, *args):
        keys, argv = args[:numkeys], args[numkeys:]
        if script is _st._ACQUIRE_LOCK_LUA:
            if self.hold_lock or keys[0] in self.data:
                return None
            token = "%s:1" % argv[0]
            self.data[keys[0]] = token
            self.data[keys[1]] = argv[1]
            return token
        if script is _st._RELEASE_LOCK_LUA:
            if self.data.get(keys[0]) == argv[0]:
                self.data.pop(keys[0], None)
                self.data.pop(keys[1], None)
                return 1
            return 0
        raise AssertionError("unexpected script")


@pytest.fixture()
def zset_redis(monkeypatch):
    fake = _ZsetRedis()
    monkeypatch.setattr(_st, "get_redis", lambda: fake)
    monkeypatch.setattr(_st.time, "sleep", lambda seconds: None)
    return fake


def test_waiting_members_are_unique_per_waiter(zset_redis):
    zset_redis.hold_lock = True
    assert _st.acquire_scan_lock("macs", timeout=0.01) is None
    assert _st.acquire_scan_lock("macs", timeout=0.01) is None
    first, second = zset_redis.added[:2]
    assert first != second
    assert _st._parse_waiting_member(first)[0] == "macs"
    # Both waiters removed their own registration
    assert zset_redis.zset == {}


def test_same_type_waiter_does_not_remove_other_registration(zset_redis):
    other = _st._waiting_member("full", "other-owner", time.time())
    zset_redis.zset[other] = _st.SCAN_PRIORITY["full"]
    token = _st.acquire_scan_lock("full", timeout=1)
    assert token
    _st.release_scan_lock(token, "full")
    assert other in zset_redis.zset


def test_stale_and_legacy_waiters_are_pruned(zset_redis):
    stale = _st._waiting_member("full", "crashed", time.time() - _st._WAITING_STALE_SEC - 1)
    zset_redis.zset[stale] = 3
    zset_redis.zset["macs"] = 3  # legacy member without timestamp
    assert _st.can_dispatch_scan("discovery") is True
    assert zset_redis.zset == {}


def test_live_higher_priority_waiter_blocks_dispatch_and_acquire(zset_redis):
    zset_redis.zset[_st._waiting_member("macs", "live", time.time())] = 3
    assert _st.can_dispatch_scan("discovery") is False
    assert _st.can_dispatch_scan("links") is False
    assert _st.can_dispatch_scan("full") is True
    assert _st.acquire_scan_lock("links", timeout=1) is None


def test_parse_waiting_member():
    assert _st._parse_waiting_member("links:1700000000.123:abc") == ("links", 1700000000.123)
    assert _st._parse_waiting_member(b"full:12.5:x") == ("full", 12.5)
    assert _st._parse_waiting_member("macs") == ("macs", None)
    assert _st._parse_waiting_member("macs:nan-ish:x")[0] == "macs"


# ---------------------------------------------------------------------------
# 10. Atomic job updates and in-memory fallback on Redis miss
# ---------------------------------------------------------------------------


class _WatchError(Exception):
    pass


class _Pipeline:
    def __init__(self, redis):
        self.redis = redis
        self.ops = []
        self.watched_version = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def watch(self, key):
        self.watched_version = self.redis.version

    def unwatch(self):
        self.watched_version = None

    def hget(self, key, field):
        return self.redis.hash.get(field)

    def multi(self):
        pass

    def hset(self, key, field, value):
        self.ops.append((field, value))

    def execute(self):
        if self.redis.interfere:
            # A concurrent writer changes another field between read and write
            self.redis.interfere -= 1
            data = json.loads(self.redis.hash["job"])
            data["progress"] = 42
            self.redis.hash["job"] = json.dumps(data)
            self.redis.version += 1
        if self.watched_version != self.redis.version:
            raise _WatchError()
        for field, value in self.ops:
            self.redis.hash[field] = value
        self.redis.version += 1


class _TxRedis:
    def __init__(self):
        self.hash = {}
        self.version = 0
        self.interfere = 0

    def pipeline(self):
        return _Pipeline(self)

    def hget(self, key, field):
        return self.hash.get(field)


@pytest.fixture()
def tx_redis(monkeypatch):
    import redis.exceptions

    fake = _TxRedis()
    monkeypatch.setattr(_st, "get_redis", lambda: fake)
    monkeypatch.setattr(redis.exceptions, "WatchError", _WatchError)
    return fake


def test_update_scan_job_retries_and_keeps_concurrent_fields(tx_redis):
    tx_redis.hash["job"] = json.dumps({"id": "job", "status": "running", "cancel_requested": False})
    tx_redis.interfere = 1
    _st.update_scan_job("job", {"status": "finished"})
    data = json.loads(tx_redis.hash["job"])
    assert data == {"id": "job", "status": "finished", "cancel_requested": False, "progress": 42}


def test_request_scan_cancel_is_atomic(tx_redis):
    tx_redis.hash["job"] = json.dumps({"id": "job", "status": "running"})
    tx_redis.interfere = 1
    assert _st.request_scan_cancel("job") is True
    data = json.loads(tx_redis.hash["job"])
    assert data["cancel_requested"] is True and data["progress"] == 42


def test_update_missing_job_is_noop(tx_redis):
    _st.update_scan_job("missing", {"status": "finished"})
    assert tx_redis.hash == {}
    assert _st.request_scan_cancel("missing-job") is False


def test_conditional_update_respects_status(tx_redis):
    tx_redis.hash["job"] = json.dumps({"id": "job", "status": "running"})
    assert _st.update_scan_job_if_status("job", ("queued",), {"status": "failed"}) is False
    assert json.loads(tx_redis.hash["job"])["status"] == "running"
    assert _st.update_scan_job_if_status("job", ("running",), {"status": "failed"}) is True
    assert json.loads(tx_redis.hash["job"])["status"] == "failed"


def test_get_scan_job_falls_back_to_memory_on_redis_miss(tx_redis):
    with _st.SCAN_JOBS_LOCK:
        _st.SCAN_JOBS["test-mem-only"] = {"id": "test-mem-only", "status": "running", "cancel_requested": True}
    try:
        assert _st.get_scan_job("test-mem-only")["status"] == "running"
        assert _st.is_cancel_requested("test-mem-only") is True
    finally:
        with _st.SCAN_JOBS_LOCK:
            _st.SCAN_JOBS.pop("test-mem-only", None)


# ---------------------------------------------------------------------------
# 11. Scheduler timestamps only advance on dispatch
# ---------------------------------------------------------------------------


def test_scheduler_retries_on_next_tick_when_not_dispatched(executor_mod, monkeypatch):  # noqa: F811
    scheduler = importlib.import_module("scan_engine.scheduler")
    outcomes = iter([False, True])
    calls = []

    def dispatch(kind):
        calls.append(kind)
        return next(outcomes, True)

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
    monkeypatch.setattr(scheduler, "_dispatch_scheduled_scan", dispatch)
    scheduler._background_scheduler()
    # Tick 1 not dispatched -> tick 2 retries and dispatches -> tick 3 waits
    assert calls == ["macs", "macs"]


def test_dispatch_returns_false_when_skipped_or_lock_fails(executor_mod, monkeypatch):  # noqa: F811
    scheduler = importlib.import_module("scan_engine.scheduler")
    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: False)
    assert scheduler._dispatch_scheduled_scan("macs") is False

    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: True)
    monkeypatch.setattr(shared.redis_client, "get_redis", lambda: None)
    monkeypatch.setattr(_st, "acquire_scan_lock", lambda *a, **k: None)
    assert scheduler._dispatch_scheduled_scan("macs") is False


# ---------------------------------------------------------------------------
# 12/13. Scanner registry fallback and shared vendor scaffolding
# ---------------------------------------------------------------------------


def test_get_scanner_without_generic_uses_fallback(monkeypatch):
    import scanners

    monkeypatch.setattr(scanners, "SCANNER_REGISTRY", {})
    monkeypatch.setattr(scanners, "_scanner_cache", {})
    s = scanners.get_scanner("nothing-registered")
    assert s.fdb_strategy() == "dot1d"
    assert s.extract_model("Some device") == ""
    assert s.is_virtual_port("vlan10") is False


@pytest.mark.parametrize("vendor, descr, expected", [
    ("aruba_cx", "1/1/1", False), ("aruba_cx", "lag1", True), ("aruba_cx", "VLAN10", True),
    ("cisco", "GigabitEthernet1/0/1", False), ("cisco", "Port-channel1", True),
    ("generic", "eth0", False), ("generic", "CPU interface", True),
    ("fs", "eth-0-1", False), ("fs", "Stack1", True),
    ("unifi", "Port 1", False), ("unifi", "br0 bridge", True),
    ("opnsense", "mlxen0", False), ("opnsense", "lo0", True), ("opnsense", "igb0_vlan10", False),
    ("eaton", "eth0", False), ("eaton", "lo", True),
    ("hpe_ilo", "Loopback", True), ("hpe_ups", "eth0", False),
    ("generic", None, False),
])
def test_virtual_port_rules_unchanged(vendor, descr, expected):
    from scanners import get_scanner

    assert get_scanner(vendor).is_virtual_port(descr) is expected


def test_model_and_version_patterns_shared():
    from scanners import get_scanner

    assert get_scanner("eaton").extract_model("  Eaton 9PX 3000i RT3U") == "Eaton 9PX 3000i"
    assert get_scanner("aruba_cx").extract_version("Aruba CX 6300 SW: FL.10.12.0010") == "FL.10.12.0010"
    assert get_scanner("cisco").extract_version("Cisco IOS Version 15.2(7)E4, RELEASE") == "15.2(7)E4"
    assert get_scanner("unifi").extract_version("USW-Pro-48, 6.5.59.14722, Linux") == "6.5.59.14722"
    # Vendors without VERSION_PATTERN keep the generic version patterns
    assert get_scanner("generic").extract_version("Foo Version 1.2.3") == "1.2.3"
    assert get_scanner("generic").extract_model(None) == ""
