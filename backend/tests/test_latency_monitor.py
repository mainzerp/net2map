"""Latency monitor round logic with a mocked probe and an in-memory Redis."""
import asyncio
import json
from datetime import datetime, timedelta, timezone

from database import AppSetting, Device, LatencySample
from latency import monitor as monitor_mod
from latency import store
from latency.monitor import BASELINE_KEY, HEARTBEAT_KEY, LOCK_KEY, STATE_KEY, LatencyMonitor, lock_ttl
from latency.probe import Sample
from latency.settings import LatencySettings, parse_settings
from tests._latency_fakes import FakeRedis


class Clock:
    def __init__(self, start):
        self.now = start

    def __call__(self):
        return self.now


def _make_probe(rtts: dict, clock: Clock, calls: list):
    async def fake_probe(device_id, ip, count, timeout_sec):
        calls.append((device_id, ip, count))
        rtt = rtts.get(ip)
        return Sample(device_id=device_id, ts=clock(), rtt_avg_ms=rtt, rtt_min_ms=rtt, rtt_max_ms=rtt,
                      jitter_ms=None if rtt is None else 0.1, loss_pct=100.0 if rtt is None else 0.0, sent=count)
    return fake_probe


def _seed(db):
    a = Device(sys_name="a", ip="10.3.0.1")
    b = Device(sys_name="b", ip="10.3.0.2", latency_monitored=True)
    off = Device(sys_name="off", ip="10.3.0.3", enabled=False)
    ign = Device(sys_name="ign", ip="10.3.0.4", ignored=True)
    db.add_all([a, b, off, ign])
    db.commit()
    return a, b


def test_parse_settings_defaults_and_clamping():
    assert parse_settings({}) == LatencySettings()
    s = parse_settings({"latency_interval_sec": "1", "latency_pings": "50", "latency_mode": "weird",
                        "latency_retention_days": "x", "latency_enabled": "false"})
    assert s.interval_sec == 5 and s.pings == 10 and s.mode == "all" and s.retention_days == 30
    assert s.enabled is False


def test_select_targets_modes(db):
    a, b = _seed(db)
    assert store.select_targets(db, LatencySettings(mode="all")) == [(a.id, a.ip), (b.id, b.ip)]
    assert store.select_targets(db, LatencySettings(mode="selected")) == [(b.id, b.ip)]


def test_round_publishes_state_and_flushes_minute_rollups(db):
    a, b = _seed(db)
    db.add(AppSetting(key="latency_pings", value="4"))
    db.commit()
    clock = Clock(datetime(2026, 10, 8, 12, 0, 30, tzinfo=timezone.utc))
    calls = []
    fake = FakeRedis()
    mon = LatencyMonitor(probe_fn=_make_probe({"10.3.0.1": 2.0, "10.3.0.2": None}, clock, calls),
                         redis_factory=lambda: fake, now_fn=clock)

    interval = asyncio.run(mon.run_round())
    assert interval == 10.0
    assert sorted(c[0] for c in calls) == [a.id, b.id] and all(c[2] == 4 for c in calls)
    state = {int(k): json.loads(v) for k, v in fake.hgetall(STATE_KEY).items()}
    assert state[a.id]["status"] == "ok" and state[a.id]["rtt_ms"] == 2.0
    assert state[b.id]["status"] == "down" and state[b.id]["loss_pct"] == 100.0
    hb = json.loads(fake.get(HEARTBEAT_KEY))
    assert hb["targets"] == 2 and hb["interval_sec"] == 10
    assert fake.get(LOCK_KEY) == mon.owner_token
    assert db.query(LatencySample).count() == 0  # current minute not flushed yet

    clock.now = clock.now + timedelta(seconds=10)
    asyncio.run(mon.run_round())
    clock.now = clock.now + timedelta(minutes=1)
    asyncio.run(mon.run_round())
    db.expire_all()
    rows = db.query(LatencySample).order_by(LatencySample.device_id).all()
    assert len(rows) == 2
    row_a = next(r for r in rows if r.device_id == a.id)
    assert row_a.probes == 8 and row_a.rtt_avg_ms == 2.0 and row_a.loss_pct == 0.0
    assert store.as_utc(row_a.bucket_ts) == datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
    row_b = next(r for r in rows if r.device_id == b.id)
    assert row_b.loss_pct == 100.0 and row_b.rtt_avg_ms is None


def test_flush_merges_existing_bucket(db):
    a, _ = _seed(db)
    bucket = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
    db.add(LatencySample(device_id=a.id, bucket_ts=bucket, rtt_avg_ms=1.0, rtt_min_ms=1.0, rtt_max_ms=1.0,
                         jitter_ms=0.1, loss_pct=0.0, probes=3))
    db.commit()
    s = Sample(device_id=a.id, ts=bucket + timedelta(seconds=20), rtt_avg_ms=3.0, rtt_min_ms=2.0,
               rtt_max_ms=4.0, jitter_ms=0.3, loss_pct=0.0, sent=3)
    assert store.flush_rollups(db, [store.build_rollup(a.id, s.ts, [s])]) == 1
    rows = db.query(LatencySample).all()
    assert len(rows) == 1
    assert rows[0].probes == 6 and rows[0].rtt_avg_ms == 2.0
    assert rows[0].rtt_min_ms == 1.0 and rows[0].rtt_max_ms == 4.0


def test_requeued_rollup_keeps_probe_weight(db):
    a, _ = _seed(db)
    clock = Clock(datetime(2026, 10, 8, 12, 0, 30, tzinfo=timezone.utc))
    mon = LatencyMonitor(redis_factory=lambda: None, now_fn=clock)
    bucket = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)

    def sample(rtt, sent):
        return Sample(device_id=a.id, ts=bucket + timedelta(seconds=5), rtt_avg_ms=rtt, rtt_min_ms=rtt,
                      rtt_max_ms=rtt, jitter_ms=rtt / 10, loss_pct=0.0, sent=sent)

    # A failed flush requeues a rollup of 6 samples x 3 probes at 1 ms ...
    rollup = store.build_rollup(a.id, bucket, [sample(1.0, 3)] * 6)
    mon._requeue([rollup], clock())
    # ... then one fresh 3-probe sample at 8 ms arrives for the same minute.
    mon.pending[(a.id, bucket)].append(sample(8.0, 3))
    merged = mon.take_due_rollups(clock(), include_current=True)[0]
    assert merged["probes"] == 21
    assert merged["rtt_avg_ms"] == 2.0  # (18 * 1 + 3 * 8) / 21, not the unweighted 4.5
    assert abs(merged["jitter_ms"] - 0.2) < 1e-9


def test_publish_sets_state_and_baseline_ttl(db):
    _seed(db)
    clock = Clock(datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc))
    fake = FakeRedis()
    mon = LatencyMonitor(probe_fn=_make_probe({"10.3.0.1": 1.0, "10.3.0.2": 1.0}, clock, []),
                         redis_factory=lambda: fake, now_fn=clock)
    asyncio.run(mon.run_round())
    ttl = lock_ttl(LatencySettings().interval_sec)
    assert fake.ttl[HEARTBEAT_KEY] == ttl
    assert fake.ttl[STATE_KEY] == ttl
    assert fake.ttl[BASELINE_KEY] == ttl


def test_flush_skips_deleted_devices(db):
    s = Sample(device_id=4242, ts=datetime.now(timezone.utc), rtt_avg_ms=1.0, rtt_min_ms=1.0, rtt_max_ms=1.0,
               jitter_ms=0.0, loss_pct=0.0, sent=3)
    assert store.flush_rollups(db, [store.build_rollup(4242, s.ts, [s])]) == 0


def test_untargeted_device_state_removed_and_disabled_clears(db):
    a, b = _seed(db)
    clock = Clock(datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc))
    fake = FakeRedis()
    mon = LatencyMonitor(probe_fn=_make_probe({"10.3.0.1": 1.0, "10.3.0.2": 1.0}, clock, []),
                         redis_factory=lambda: fake, now_fn=clock)
    asyncio.run(mon.run_round())
    assert set(fake.hkeys(STATE_KEY)) == {str(a.id), str(b.id)}

    db.add(AppSetting(key="latency_mode", value="selected"))
    db.commit()
    asyncio.run(mon.run_round())
    assert set(fake.hkeys(STATE_KEY)) == {str(b.id)}
    assert a.id not in mon.windows

    db.query(AppSetting).filter(AppSetting.key == "latency_mode").delete()
    db.add(AppSetting(key="latency_enabled", value="false"))
    db.commit()
    asyncio.run(mon.run_round())
    assert fake.hkeys(STATE_KEY) == []
    assert json.loads(fake.get(HEARTBEAT_KEY))["targets"] == 0


def test_lock_held_by_other_instance_skips_round(db):
    _seed(db)
    fake = FakeRedis()
    fake.set(LOCK_KEY, "someone-else")
    calls = []
    clock = Clock(datetime.now(timezone.utc))
    mon = LatencyMonitor(probe_fn=_make_probe({}, clock, calls), redis_factory=lambda: fake, now_fn=clock)
    asyncio.run(mon.run_round())
    assert calls == []
    assert fake.hkeys(STATE_KEY) == []


def test_runs_without_redis(db):
    a, _ = _seed(db)
    clock = Clock(datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc))
    mon = LatencyMonitor(probe_fn=_make_probe({"10.3.0.1": 1.5}, clock, []), redis_factory=lambda: None,
                         now_fn=clock)
    asyncio.run(mon.run_round())
    assert mon.state[a.id]["rtt_ms"] == 1.5
    asyncio.run(mon.shutdown())  # flushes the current minute
    assert db.query(LatencySample).filter(LatencySample.device_id == a.id).count() == 1


def test_baseline_degraded_status(db):
    a, _ = _seed(db)
    now = datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc)
    for i in range(40):
        db.add(LatencySample(device_id=a.id, bucket_ts=now - timedelta(minutes=i + 1), rtt_avg_ms=1.0,
                             loss_pct=0.0, probes=3))
    db.commit()
    clock = Clock(now)
    mon = LatencyMonitor(probe_fn=_make_probe({"10.3.0.1": 20.0}, clock, []), redis_factory=lambda: None,
                         now_fn=clock)
    asyncio.run(mon.run_round())
    assert mon.baselines[a.id] == 1.0
    assert mon.state[a.id]["status"] == "degraded"


def test_purge_removes_old_rollups(db):
    a, _ = _seed(db)
    now = datetime.now(timezone.utc)
    db.add_all([
        LatencySample(device_id=a.id, bucket_ts=now - timedelta(days=40), rtt_avg_ms=1.0, loss_pct=0.0, probes=3),
        LatencySample(device_id=a.id, bucket_ts=now - timedelta(days=1), rtt_avg_ms=1.0, loss_pct=0.0, probes=3),
    ])
    db.commit()
    assert store.purge_older_than(db, now - timedelta(days=30)) == 1
    assert db.query(LatencySample).count() == 1


def test_failed_probe_is_skipped_and_db_errors_do_not_crash(db):
    a, b = _seed(db)
    clock = Clock(datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc))

    async def flaky_probe(device_id, ip, count, timeout_sec):
        if device_id == b.id:
            raise RuntimeError("boom")
        return Sample(device_id=device_id, ts=clock(), rtt_avg_ms=1.0, rtt_min_ms=1.0, rtt_max_ms=1.0,
                      jitter_ms=0.0, loss_pct=0.0, sent=count)

    mon = LatencyMonitor(probe_fn=flaky_probe, redis_factory=lambda: None, now_fn=clock)
    asyncio.run(mon.run_round())
    assert set(mon.state) == {a.id}

    def broken_session():
        raise RuntimeError("db down")

    mon._session_factory = broken_session
    assert asyncio.run(mon.run_round()) == 10.0  # config load fails, loop keeps going
    assert monitor_mod.lock_ttl(10) == 30
