"""Regression tests for scan engine review findings.

Covers: SNMP walk truncation warning and row cap, one-time credential
profile decryption per scan, last_seen refresh for ping-only devices, the
Redis-backed scheduler dispatch claim, and per-job pruning of the Redis scan
job hash.
"""
import asyncio
import importlib
import importlib.util
import logging
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import shared.state as _st
from database import Device, SnmpProfile

BACKEND = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# Real snmp_scanner against pysnmp stand-ins
# ---------------------------------------------------------------------------

class _StubOctetString:
    def __init__(self, value=b""):
        self._raw = value if isinstance(value, bytes) else str(value).encode()

    def __bytes__(self):
        return self._raw

    def __str__(self):
        return self._raw.decode()


class _StubSnmpEngine:
    def close_dispatcher(self):
        pass


@pytest.fixture()
def scanner(monkeypatch):
    hlapi = types.ModuleType("pysnmp.hlapi.v3arch.asyncio")
    for name in ("USM_AUTH_HMAC96_MD5", "USM_AUTH_HMAC96_SHA", "USM_AUTH_HMAC128_SHA224",
                 "USM_AUTH_HMAC192_SHA256", "USM_AUTH_HMAC256_SHA384", "USM_AUTH_HMAC384_SHA512",
                 "USM_AUTH_NONE", "USM_PRIV_CBC56_DES", "USM_PRIV_CBC168_3DES", "USM_PRIV_CFB128_AES",
                 "USM_PRIV_CFB192_AES", "USM_PRIV_CFB256_AES", "USM_PRIV_NONE"):
        setattr(hlapi, name, name)
    hlapi.SnmpEngine = _StubSnmpEngine
    for name in ("CommunityData", "UsmUserData", "ContextData", "ObjectIdentity", "ObjectType",
                 "UdpTransportTarget", "bulk_cmd", "get_cmd"):
        setattr(hlapi, name, MagicMock())
    rfc1902 = types.ModuleType("pysnmp.proto.rfc1902")
    rfc1902.OctetString = _StubOctetString
    rfc1905 = types.ModuleType("pysnmp.proto.rfc1905")
    for name in ("EndOfMibView", "NoSuchInstance", "NoSuchObject"):
        setattr(rfc1905, name, type(name, (), {}))
    for mod_name, mod in {
        "pysnmp.hlapi.v3arch": types.ModuleType("pysnmp.hlapi.v3arch"),
        "pysnmp.hlapi.v3arch.asyncio": hlapi,
        "pysnmp.proto": types.ModuleType("pysnmp.proto"),
        "pysnmp.proto.rfc1902": rfc1902,
        "pysnmp.proto.rfc1905": rfc1905,
    }.items():
        monkeypatch.setitem(sys.modules, mod_name, mod)

    spec = importlib.util.spec_from_file_location("_real_snmp_scanner_walk", BACKEND / "snmp_scanner.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    async def fake_transport(*args, **kwargs):
        return object()

    monkeypatch.setattr(mod, "_transport", fake_transport)
    return mod


TABLE = "1.3.6.1.2.1.17.7.1.2.2.1.2"


def _install_table(scanner, monkeypatch, n_rows):
    """Serve a table of n_rows rows under TABLE via GETBULK (25 per call)."""
    calls = {"n": 0}

    async def fake_bulk(engine, auth, transport, ctx, non_rep, max_rep, obj):
        calls["n"] += 1
        start = fake_bulk.cursor
        binds = []
        for i in range(start + 1, min(start + max_rep, n_rows) + 1):
            binds.append(("%s.%d" % (TABLE, i), _StubOctetString(b"v%d" % i)))
        if len(binds) < max_rep:
            # Past the table: next OID belongs to a different subtree.
            binds.append(("1.3.6.1.2.1.17.7.1.2.3.1", _StubOctetString(b"x")))
        fake_bulk.cursor = start + max_rep
        return None, 0, 0, binds

    fake_bulk.cursor = 0
    monkeypatch.setattr(scanner, "bulk_cmd", fake_bulk)
    return calls


@pytest.mark.parametrize("func", ["snmp_bulk_walk", "snmp_bulk_walk_raw"])
def test_walk_truncation_logs_warning_once(scanner, monkeypatch, caplog, func):
    _install_table(scanner, monkeypatch, 200)
    with caplog.at_level(logging.WARNING, logger=scanner.log.name):
        rows = asyncio.run(getattr(scanner, func)("10.0.0.1", 161, None, TABLE, max_rows=60))
    assert len(rows) == 60
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    msg = warnings[0].getMessage()
    assert "10.0.0.1" in msg and TABLE in msg and "60" in msg


def test_walk_default_cap_covers_large_tables(scanner, monkeypatch, caplog):
    # A large FDB (well above the former 500-row cap) is returned completely
    # and without a truncation warning.
    _install_table(scanner, monkeypatch, 2600)
    with caplog.at_level(logging.WARNING, logger=scanner.log.name):
        rows = asyncio.run(scanner.snmp_bulk_walk("10.0.0.1", 161, None, TABLE))
    assert len(rows) == 2600
    assert rows[-1][0] == "%s.2600" % TABLE
    assert not [r for r in caplog.records if r.levelno == logging.WARNING]
    assert scanner.WALK_MAX_ROWS_DEFAULT >= 10000


def test_walk_max_rows_is_hard_limited(scanner):
    assert scanner._clamp_walk_rows(10 ** 9) == scanner.WALK_MAX_ROWS_HARD_LIMIT
    assert scanner._clamp_walk_rows(0) == 1
    assert scanner._clamp_walk_rows(750) == 750


# ---------------------------------------------------------------------------
# Real scan_engine.executor (conftest mocks the package)
# ---------------------------------------------------------------------------

@pytest.fixture()
def executor_mod():
    saved = {
        k: v for k, v in sys.modules.items()
        if k == "scan_engine" or k.startswith("scan_engine.")
    }
    for k in list(saved):
        sys.modules.pop(k, None)
    mod = importlib.import_module("scan_engine.executor")
    try:
        yield mod
    finally:
        for k in [k for k in sys.modules if k == "scan_engine" or k.startswith("scan_engine.")]:
            sys.modules.pop(k, None)
        sys.modules.update(saved)


class _PingOkProcess:
    returncode = 0

    async def communicate(self):
        return b"reply time=1 ms", b""

    async def wait(self):
        return 0

    def kill(self):
        pass


def test_range_profiles_decrypted_once_per_scan(db, executor_mod, monkeypatch):
    db.add_all([
        SnmpProfile(label="p1", snmp_version="v2c", community="c1"),
        SnmpProfile(label="p2", snmp_version="v3", v3_username="u",
                    v3_auth_password="a", v3_priv_password="p"),
    ])
    db.commit()
    range_ips = ["10.7.0.%d" % i for i in range(1, 6)]
    monkeypatch.setattr(executor_mod, "_read_discovery_ranges", lambda db: ["10.7.0.0/29"])
    monkeypatch.setattr(executor_mod, "_expand_ranges_to_ips", lambda ranges: list(range_ips))

    decrypted = []

    def counting_decrypt(value):
        decrypted.append(value)
        return value

    monkeypatch.setattr(executor_mod, "decrypt", counting_decrypt)

    async def fake_subprocess(*args, **kwargs):
        return _PingOkProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_subprocess)

    tried = []

    async def no_snmp(**kwargs):
        tried.append((kwargs["ip"], kwargs["snmp_version"], kwargs["community"]))
        return None

    monkeypatch.setattr(executor_mod, "scan_switch", no_snmp)

    result = asyncio.run(executor_mod._execute_scan(db, scan_type="discovery", dry_run=True))

    assert result.scanned == len(range_ips)
    # 3 secrets per profile, decrypted once per scan (not once per range IP).
    assert len(decrypted) == 2 * 3
    # Per-IP selection is unchanged: every IP tries every profile in order.
    for ip in range_ips:
        assert [t[1:] for t in tried if t[0] == ip] == [("v2c", "c1"), ("v3", "public")]


def _finalize_kwargs(**overrides):
    kwargs = dict(
        dry_run=False, scan_mode="full", corr="test", cancel_event=None,
        switch_data={}, ping_by_ip={}, range_found_ips=[], range_matched_profile={},
        range_no_profile_ips=[], errors=[], status="finished", total_duration_ms=1,
        scanned=1, workers=1, switch_metrics=[], lock_token=None,
    )
    kwargs.update(overrides)
    return kwargs


def test_ping_only_known_device_refreshes_last_seen(db, executor_mod):
    from datetime import datetime

    old = datetime(2020, 1, 1)
    dev = Device(ip="10.9.9.1", sys_name="sw-old", sys_descr="desc", vendor="cisco",
                 ping_status="offline", last_seen=old)
    db.add(dev)
    db.commit()

    executor_mod._finalize_scan_db(db, **_finalize_kwargs(ping_by_ip={"10.9.9.1": (True, 3)}))

    db.refresh(dev)
    assert dev.ping_status == "online"
    assert dev.last_seen is not None and dev.last_seen.replace(tzinfo=None) > old
    # Existing identity fields are kept for ping-only observations.
    assert dev.sys_name == "sw-old"
    assert dev.sys_descr == "desc"
    assert dev.vendor == "cisco"


def test_unreachable_known_device_keeps_last_seen(db, executor_mod):
    from datetime import datetime

    old = datetime(2020, 1, 1)
    dev = Device(ip="10.9.9.2", sys_name="sw", ping_status="online", last_seen=old)
    db.add(dev)
    db.commit()

    executor_mod._finalize_scan_db(db, **_finalize_kwargs(ping_by_ip={"10.9.9.2": (False, 0)}))

    db.refresh(dev)
    assert dev.ping_status == "offline"
    assert dev.last_seen.replace(tzinfo=None) == old


# ---------------------------------------------------------------------------
# Scheduler dispatch claims
# ---------------------------------------------------------------------------

class _ClaimRedis:
    """Redis stand-in emulating the dispatch claim script with a fake clock."""

    def __init__(self):
        self.data = {}
        self.expiry = {}
        self.now = 1_000_000.0
        self.fail = False

    def eval(self, script, numkeys, *args):
        if self.fail:
            raise ConnectionError("Redis unavailable")
        if script is _st._RELEASE_DISPATCH_LUA:
            key, token = args[0], args[1]
            if key in self.data and "%.6f" % self.data[key] == token:
                del self.data[key]
                return 1
            return 0
        assert script is _st._CLAIM_DISPATCH_LUA
        key, interval, ttl = args[0], float(args[1]), int(args[2])
        exp = self.expiry.get(key)
        if exp is not None and exp <= self.now:
            self.data.pop(key, None)
        last = self.data.get(key)
        if last is not None and self.now - last < interval:
            return 0
        self.data[key] = self.now
        self.expiry[key] = self.now + ttl
        return "%.6f" % self.now


@pytest.fixture()
def claim_redis(monkeypatch):
    fake = _ClaimRedis()
    monkeypatch.setattr(_st, "get_redis", lambda: fake)
    monkeypatch.setattr(_st, "_LOCAL_LAST_DISPATCH", {})
    return fake


def test_dispatch_claim_is_exclusive_per_interval(claim_redis):
    # Two workers (same Redis) ticking in the same interval: only one wins.
    assert _st.claim_scheduled_dispatch("macs", 30) is True
    assert _st.claim_scheduled_dispatch("macs", 30) is False
    claim_redis.now += 29
    assert _st.claim_scheduled_dispatch("macs", 30) is False
    claim_redis.now += 1
    assert _st.claim_scheduled_dispatch("macs", 30) is True
    assert "net2map:sched:last_dispatch:macs" in claim_redis.data
    # Kinds are independent.
    assert _st.claim_scheduled_dispatch("links", 30) is True


def test_dispatch_claim_survives_worker_restart(claim_redis, monkeypatch):
    assert _st.claim_scheduled_dispatch("discovery", 1800) is True
    # A restarted worker has empty process memory; the claim lives in Redis.
    monkeypatch.setattr(_st, "_LOCAL_LAST_DISPATCH", {})
    assert _st.claim_scheduled_dispatch("discovery", 1800) is False


def test_dispatch_claim_honours_lowered_interval(claim_redis):
    assert _st.claim_scheduled_dispatch("discovery", 1800) is True
    claim_redis.now += 120
    assert _st.claim_scheduled_dispatch("discovery", 1800) is False
    assert _st.claim_scheduled_dispatch("discovery", 60) is True


def test_dispatch_claim_falls_back_to_memory(monkeypatch):
    monkeypatch.setattr(_st, "get_redis", lambda: None)
    monkeypatch.setattr(_st, "_LOCAL_LAST_DISPATCH", {})
    assert _st.claim_scheduled_dispatch("macs", 30) is True
    assert _st.claim_scheduled_dispatch("macs", 30) is False
    assert _st.claim_scheduled_dispatch("macs", 0) is False


def test_dispatch_claim_fails_closed_on_redis_error(claim_redis):
    # Per-process timestamps cannot deduplicate across workers: a configured
    # but failing Redis never dispatches (the next tick retries).
    claim_redis.fail = True
    assert _st.claim_scheduled_dispatch("links", 30) is False
    assert _st.claim_scheduled_dispatch("links", 30) is False
    assert _st._LOCAL_LAST_DISPATCH == {}
    claim_redis.fail = False
    assert _st.claim_scheduled_dispatch("links", 30) is True


def test_dispatch_claim_fails_closed_when_configured_redis_unavailable(monkeypatch):
    import shared.redis_client

    monkeypatch.setattr(_st, "get_redis", lambda: None)
    monkeypatch.setattr(shared.redis_client, "REDIS_URL", "redis://configured-test")
    monkeypatch.setattr(_st, "_LOCAL_LAST_DISPATCH", {})
    assert _st.claim_scheduled_dispatch("macs", 30) is False
    assert _st._LOCAL_LAST_DISPATCH == {}


def test_scheduler_tick_two_workers_dispatch_once(claim_redis, executor_mod, monkeypatch):
    tasks = importlib.import_module("tasks")
    scheduler = importlib.import_module("scan_engine.scheduler")
    dispatched = []
    monkeypatch.setattr(tasks, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(scheduler, "_read_scheduler_intervals",
                        lambda db: {"discovery": 1800, "links": 60, "macs": 30})
    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: True)
    monkeypatch.setattr(scheduler, "_dispatch_scheduled_scan", lambda kind: dispatched.append(kind) or True)

    tasks.scheduler_tick.run()  # worker A
    tasks.scheduler_tick.run()  # worker B, same interval
    assert dispatched == ["macs", "links", "discovery"]

    claim_redis.now += 30
    tasks.scheduler_tick.run()
    assert dispatched[3:] == ["macs"]


@pytest.fixture()
def tick_env(claim_redis, executor_mod, monkeypatch):
    tasks = importlib.import_module("tasks")
    scheduler = importlib.import_module("scan_engine.scheduler")
    env = types.SimpleNamespace(tasks=tasks, scheduler=scheduler, redis=claim_redis,
                                attempts=[], dispatchable=True, accept=True)
    monkeypatch.setattr(tasks, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(tasks, "_maybe_reap_stale_jobs", lambda: None)
    monkeypatch.setattr(scheduler, "_blocked_kinds", set())
    monkeypatch.setattr(scheduler, "_read_scheduler_intervals",
                        lambda db: {"discovery": 0, "links": 0, "macs": 300})
    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: env.dispatchable)

    def dispatch(kind):
        env.attempts.append(kind)
        return env.accept

    monkeypatch.setattr(scheduler, "_dispatch_scheduled_scan", dispatch)
    return env


def test_scheduler_tick_refused_dispatch_does_not_consume_interval(tick_env):
    key = "net2map:sched:last_dispatch:macs"
    tick_env.accept = False  # e.g. lock state changed between check and dispatch
    tick_env.tasks.scheduler_tick.run()
    assert tick_env.attempts == ["macs"]
    assert key not in tick_env.redis.data  # claim rolled back
    tick_env.redis.now += 5
    tick_env.accept = True
    tick_env.tasks.scheduler_tick.run()  # next tick retries
    assert tick_env.attempts == ["macs", "macs"]
    assert key in tick_env.redis.data
    tick_env.redis.now += 5
    tick_env.tasks.scheduler_tick.run()  # interval now consumed
    assert tick_env.attempts == ["macs", "macs"]


def test_scheduler_tick_blocked_scan_never_claims(tick_env):
    tick_env.dispatchable = False  # long manual scan holds the lock
    for _ in range(3):
        tick_env.tasks.scheduler_tick.run()
        tick_env.redis.now += 5
    assert tick_env.attempts == []
    assert tick_env.redis.data == {}
    tick_env.dispatchable = True
    tick_env.tasks.scheduler_tick.run()
    assert tick_env.attempts == ["macs"]


def test_scheduler_tick_dedup_across_workers_after_rollback(tick_env):
    tick_env.accept = False
    tick_env.tasks.scheduler_tick.run()  # worker A: refused, rolled back
    tick_env.accept = True
    tick_env.tasks.scheduler_tick.run()  # worker B: dispatches
    tick_env.tasks.scheduler_tick.run()  # worker C, same interval: nothing
    assert tick_env.attempts == ["macs", "macs"]


def test_release_dispatch_claim_only_removes_own_claim(claim_redis):
    token = _st.claim_scheduled_dispatch_token("macs", 30)
    assert token
    assert _st.release_scheduled_dispatch("macs", "123.000000") is False
    assert "net2map:sched:last_dispatch:macs" in claim_redis.data
    assert _st.release_scheduled_dispatch("macs", token) is True
    assert _st.release_scheduled_dispatch("macs", token) is False
    assert _st.release_scheduled_dispatch("macs", None) is False
    claim_redis.fail = True
    assert _st.release_scheduled_dispatch("macs", token) is False


def test_release_dispatch_claim_local_mode(monkeypatch):
    monkeypatch.setattr(_st, "get_redis", lambda: None)
    monkeypatch.setattr(_st, "_LOCAL_LAST_DISPATCH", {})
    token = _st.claim_scheduled_dispatch_token("links", 30)
    assert token and token.startswith("local:")
    assert _st.claim_scheduled_dispatch("links", 30) is False
    assert _st.release_scheduled_dispatch("links", token) is True
    assert _st.claim_scheduled_dispatch("links", 30) is True


def test_blocked_dispatch_logs_once_per_streak(executor_mod, monkeypatch):
    scheduler = importlib.import_module("scan_engine.scheduler")
    events = []
    monkeypatch.setattr(scheduler, "_log_event", lambda level, event, **kw: events.append(event))
    monkeypatch.setattr(scheduler, "_blocked_kinds", set())
    allowed = {"value": False}
    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: allowed["value"])
    for _ in range(5):
        scheduler._log_dispatch_start("macs")
        assert scheduler._dispatch_scheduled_scan("macs") is False
    assert events == ["scheduler.macs.start", "scheduler.macs.skipped"]
    # Dispatch goes through: the streak ends with one "resumed" entry.
    allowed["value"] = True
    import shared.redis_client
    import shared.state

    monkeypatch.setattr(shared.redis_client, "get_redis", lambda: None)
    monkeypatch.setattr(shared.state, "acquire_scan_lock", lambda *a, **k: None)
    assert scheduler._dispatch_scheduled_scan("macs") is False  # lock not acquired: still blocked
    assert events[-1] == "scheduler.macs.skipped"
    monkeypatch.setattr(shared.state, "acquire_scan_lock", lambda *a, **k: "owner:1")
    monkeypatch.setattr(shared.state, "release_scan_lock", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: MagicMock())
    monkeypatch.setattr(scheduler, "_get_bg_loop", lambda: MagicMock())
    monkeypatch.setattr(scheduler.asyncio, "run_coroutine_threadsafe",
                        lambda coro, loop: (coro.close(), MagicMock())[1])
    assert scheduler._dispatch_scheduled_scan("macs") is True
    assert events[-1] == "scheduler.macs.resumed"
    scheduler._log_dispatch_start("macs")
    assert events[-1] == "scheduler.macs.start"


# ---------------------------------------------------------------------------
# Scan job hash pruning
# ---------------------------------------------------------------------------

class _JobRedis:
    def __init__(self):
        self.hash = {}
        self.zset = {}
        self.expires = []

    def hset(self, key, field, value):
        self.hash[field] = value

    def hget(self, key, field):
        return self.hash.get(field)

    def hdel(self, key, *fields):
        for f in fields:
            self.hash.pop(f, None)

    def zadd(self, key, mapping):
        self.zset.update(mapping)

    def zrangebyscore(self, key, lo, hi):
        return [m for m, s in self.zset.items() if s <= hi]

    def zremrangebyscore(self, key, lo, hi):
        for m in [m for m, s in self.zset.items() if s <= hi]:
            del self.zset[m]

    def expire(self, key, ttl):
        self.expires.append((key, ttl))


def test_set_scan_job_prunes_jobs_older_than_ttl(monkeypatch):
    fake = _JobRedis()
    monkeypatch.setattr(_st, "get_redis", lambda: fake)
    clock = {"t": 1_000_000.0}
    monkeypatch.setattr(_st.time, "time", lambda: clock["t"])

    _st.set_scan_job("old-job", {"id": "old-job", "status": "finished"})
    clock["t"] += _st._SCAN_JOB_TTL - 1
    _st.set_scan_job("mid-job", {"id": "mid-job", "status": "finished"})
    assert set(fake.hash) == {"old-job", "mid-job"}

    clock["t"] += 2
    _st.set_scan_job("new-job", {"id": "new-job", "status": "queued"})
    # The hash-level EXPIRE is refreshed by every new job; per-job pruning
    # still drops the entry older than the TTL.
    assert set(fake.hash) == {"mid-job", "new-job"}
    assert set(fake.zset) == {"mid-job", "new-job"}
    assert _st.get_scan_job("old-job") is None
