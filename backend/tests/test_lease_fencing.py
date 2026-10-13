"""Database-side fencing for the Redis scan lease.

Covers fencing token issuance on lock acquisition (Redis and in-memory
paths), the conditional lease_fences upsert, the executor transaction guard
rejecting stale lease holders, and migration 020.

Note: the test suite runs on SQLite. True concurrent PostgreSQL behaviour
(row lock on the fence row, re-evaluation of the ON CONFLICT ... WHERE clause
after the competing transaction commits) is not exercised here; the
paused-worker scenario is simulated with two sessions on separate SQLite
connections.
"""
import importlib
import importlib.util
import logging
import sys
import threading
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

import shared.redis_client
import shared.state as _st
from database import Base, Device, LeaseFence, ScanRun
from shared.fencing import apply_fence
from shared.metrics import STALE_LEASE_REJECTIONS

BACKEND = Path(__file__).resolve().parents[1]


class FakeRedis:
    """Minimal Redis stand-in emulating the scan lock scripts with a fake clock.

    ``time_us`` emulates the Redis server time used as the fencing floor; it
    defaults to 0 so tokens are plain counter values (1, 2, 3, ...).
    """

    def __init__(self):
        self.data = {}
        self.expiry = {}
        self.now = 1000.0
        self.time_us = 0
        self.fail_eval = False

    def _alive(self, key):
        exp = self.expiry.get(key)
        if exp is not None and exp <= self.now:
            self.data.pop(key, None)
            self.expiry.pop(key, None)
        return key in self.data

    def get(self, key):
        return self.data.get(key) if self._alive(key) else None

    def set(self, key, value, nx=False, ex=None):
        if nx and self._alive(key):
            return None
        self.data[key] = str(value)
        if ex is not None:
            self.expiry[key] = self.now + int(ex)
        else:
            self.expiry.pop(key, None)
        return True

    def delete(self, key):
        self.data.pop(key, None)
        self.expiry.pop(key, None)

    def zadd(self, *args, **kwargs):
        return 1

    def zrem(self, *args, **kwargs):
        return 1

    def zrevrange(self, *args, **kwargs):
        return []

    def flushall(self):
        self.data.clear()
        self.expiry.clear()

    def eval(self, script, numkeys, *args):
        if self.fail_eval:
            raise ConnectionError("Redis unavailable")
        keys, argv = args[:numkeys], args[numkeys:]
        if script is _st._ACQUIRE_LOCK_LUA:
            if self._alive(keys[0]):
                return None
            fence = int(self.get(keys[2]) or 0) + 1
            fence = max(fence, self.time_us)
            self.set(keys[2], fence)
            owner = "%s:%d" % (argv[0], fence)
            self.set(keys[0], owner, ex=argv[2])
            self.set(keys[1], argv[1], ex=argv[2])
            return owner
        if script is _st._RELEASE_LOCK_LUA:
            if self.get(keys[0]) == argv[0]:
                self.delete(keys[0])
                self.delete(keys[1])
                return 1
            return 0
        if script is _st._RENEW_LOCK_LUA:
            if self.get(keys[0]) == argv[0]:
                self.expiry[keys[0]] = self.now + int(argv[1])
                self.expiry[keys[1]] = self.now + int(argv[1])
                return 1
            return 0
        raise AssertionError("Unexpected script")


@pytest.fixture()
def fake_redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(_st, "get_redis", lambda: fake)
    monkeypatch.setattr(_st.time, "sleep", lambda seconds: None)
    return fake


@pytest.fixture()
def executor_mod():
    """Import the real scan_engine.executor despite the conftest package mock."""
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


def _rejections():
    return STALE_LEASE_REJECTIONS.labels(lease=_st.SCAN_LOCK_FENCE_NAME)._value.get()


def _stored_fence(session):
    session.expire_all()
    row = session.get(LeaseFence, _st.SCAN_LOCK_FENCE_NAME)
    return row.token if row else None


# ---------------------------------------------------------------------------
# Fencing token issuance
# ---------------------------------------------------------------------------

def test_fence_token_of_parsing():
    assert _st.fence_token_of("abc:12") == 12
    assert _st.fence_token_of("owner") is None
    assert _st.fence_token_of("abc:") is None
    assert _st.fence_token_of("abc:x1") is None
    assert _st.fence_token_of(None) is None


def test_token_increases_across_release_and_reacquire(fake_redis):
    t1 = _st.acquire_scan_lock("full", timeout=1)
    assert _st.fence_token_of(t1) == 1
    _st.release_scan_lock(t1, "full")
    t2 = _st.acquire_scan_lock("full", timeout=1)
    assert _st.fence_token_of(t2) == 2
    assert fake_redis.get("scan:lock") == t2
    _st.release_scan_lock(t2, "full")


def test_token_increases_across_lease_expiry(fake_redis):
    token_a = _st.acquire_scan_lock("full", timeout=1)
    assert _st.acquire_scan_lock("full", timeout=0.01) is None
    fake_redis.now += _st._SCAN_LOCK_TTL + 1
    token_b = _st.acquire_scan_lock("full", timeout=1)
    assert _st.fence_token_of(token_b) > _st.fence_token_of(token_a)
    # The stale holder can neither renew nor release the new lease.
    assert _st.renew_scan_lock(token_a) is False
    _st.release_scan_lock(token_a, "full")
    assert fake_redis.get("scan:lock") == token_b


def test_token_floor_survives_redis_data_loss(fake_redis):
    fake_redis.time_us = 5_000_000
    first = _st.fence_token_of(_st.acquire_scan_lock("full", timeout=1))
    assert first == 5_000_000
    fake_redis.flushall()
    fake_redis.time_us += 10
    second = _st.fence_token_of(_st.acquire_scan_lock("full", timeout=1))
    assert second > first


def test_acquire_fails_closed_when_fencing_script_errors(fake_redis):
    fake_redis.fail_eval = True
    assert _st.acquire_scan_lock("full", timeout=0.01) is None
    assert fake_redis.get("scan:lock") is None


def test_local_fallback_tokens_increase(monkeypatch):
    monkeypatch.setattr(_st, "get_redis", lambda: None)
    monkeypatch.setattr(shared.redis_client, "REDIS_URL", "")
    t1 = _st.acquire_scan_lock("full", timeout=1)
    _st.release_scan_lock(t1, "full")
    t2 = _st.acquire_scan_lock("full", timeout=1)
    _st.release_scan_lock(t2, "full")
    assert _st.fence_token_of(t2) > _st.fence_token_of(t1) > 0


def test_real_lua_acquire_script_issues_fence_tokens():
    """Runs the actual Lua scripts when fakeredis with Lua support is installed."""
    fakeredis = pytest.importorskip("fakeredis")
    pytest.importorskip("lupa")
    r = fakeredis.FakeRedis(decode_responses=True)
    keys = ("scan:lock", "scan:active_type", _st._SCAN_LOCK_FENCE_KEY)
    t1 = r.eval(_st._ACQUIRE_LOCK_LUA, 3, *keys, "owner-a", "full", 600)
    assert r.eval(_st._ACQUIRE_LOCK_LUA, 3, *keys, "owner-b", "full", 600) is None
    assert r.get("scan:lock") == t1 and r.get("scan:active_type") == "full"
    assert 0 < r.ttl("scan:lock") <= 600
    assert r.eval(_st._RELEASE_LOCK_LUA, 2, "scan:lock", "scan:active_type", t1) == 1
    t2 = r.eval(_st._ACQUIRE_LOCK_LUA, 3, *keys, "owner-b", "full", 600)
    assert t1.startswith("owner-a:") and t2.startswith("owner-b:")
    assert _st.fence_token_of(t2) > _st.fence_token_of(t1) > 0
    # Floor at server time in microseconds after the counter is lost.
    r.delete(_st._SCAN_LOCK_FENCE_KEY, "scan:lock")
    t3 = r.eval(_st._ACQUIRE_LOCK_LUA, 3, *keys, "owner-c", "full", 600)
    assert _st.fence_token_of(t3) > _st.fence_token_of(t2)


# ---------------------------------------------------------------------------
# Conditional upsert
# ---------------------------------------------------------------------------

def test_apply_fence_upsert_semantics(db):
    conn = db.connection()
    assert apply_fence(conn, "lease", 5) is True    # insert
    assert apply_fence(conn, "lease", 5) is True    # equal token
    assert apply_fence(conn, "lease", 7) is True    # newer token
    assert apply_fence(conn, "lease", 6) is False   # stale token
    assert apply_fence(conn, "other", 1) is True    # independent lease
    db.commit()
    assert db.get(LeaseFence, "lease").token == 7
    assert db.get(LeaseFence, "other").token == 1


# ---------------------------------------------------------------------------
# Executor transaction guard
# ---------------------------------------------------------------------------

def _writer(executor_mod, ip):
    @executor_mod._guard_scan_transactions
    def finalize(session, **kwargs):
        session.add(Device(ip=ip, sys_name="fenced"))
        session.commit()
    return finalize


def test_stale_token_rejected_and_writes_nothing(db, executor_mod, monkeypatch, caplog):
    # Redis checks pass for both workers: the race between check and COMMIT.
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)
    before = _rejections()
    _writer(executor_mod, "10.0.0.2")(db, lock_token="worker-b:2", corr="b")
    assert _stored_fence(db) == 2

    with caplog.at_level(logging.WARNING):
        with pytest.raises(executor_mod.StaleLeaseError):
            _writer(executor_mod, "10.0.0.1")(db, lock_token="worker-a:1", corr="a")
    assert db.query(Device).filter(Device.ip == "10.0.0.1").count() == 0
    assert db.query(Device).filter(Device.ip == "10.0.0.2").count() == 1
    assert _stored_fence(db) == 2
    assert _rejections() == before + 1
    assert "scan.lease.stale_token_rejected" in caplog.text
    # Stale lease errors use the existing lease-loss path.
    assert issubclass(executor_mod.StaleLeaseError, executor_mod.ScanOwnershipLost)
    # Listeners are removed: unrelated writes still work.
    db.add(Device(ip="10.0.0.3"))
    db.commit()


def test_equal_token_same_holder_commits_twice(db, executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)

    @executor_mod._guard_scan_transactions
    def finalize(session, **kwargs):
        session.add(Device(ip="10.0.0.1"))
        session.commit()
        session.add(Device(ip="10.0.0.2"))
        session.commit()

    finalize(db, lock_token="holder:5")
    _writer(executor_mod, "10.0.0.3")(db, lock_token="holder:5")
    assert db.query(Device).count() == 3
    assert _stored_fence(db) == 5


def test_transaction_opened_before_guard_is_fenced(db, executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)
    _writer(executor_mod, "10.0.0.2")(db, lock_token="new:9")
    db.query(Device).all()  # scan body reads open the transaction early
    assert db.in_transaction()

    @executor_mod._guard_scan_transactions
    def finalize(session, **kwargs):
        raise AssertionError("A stale holder must be rejected before writing")

    with pytest.raises(executor_mod.StaleLeaseError):
        finalize(db, lock_token="old:3")


def test_finalize_scan_db_rejects_stale_fence(db, executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)
    kwargs = dict(
        dry_run=True, scan_mode="full", corr="test", cancel_event=None,
        switch_data={}, ping_by_ip={}, range_found_ips=[], range_matched_profile={},
        range_no_profile_ips=[], errors=[], status="finished", total_duration_ms=1,
        scanned=1, workers=1, switch_metrics=[],
    )
    executor_mod._finalize_scan_db(db, lock_token="new:4", **kwargs)
    assert db.query(ScanRun).count() == 1
    with pytest.raises(executor_mod.StaleLeaseError):
        executor_mod._finalize_scan_db(db, lock_token="old:3", **kwargs)
    assert db.query(ScanRun).count() == 1


def test_unfenced_tokens_keep_previous_behaviour(db, executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)
    _writer(executor_mod, "10.0.0.1")(db, lock_token="legacy-owner")
    _writer(executor_mod, "10.0.0.2")(db, lock_token=None)
    assert db.query(Device).count() == 2
    assert _stored_fence(db) is None


@pytest.fixture()
def file_sessions(tmp_path):
    """Sessions on separate SQLite connections (one per worker)."""
    eng = sa.create_engine(
        "sqlite:///%s" % (tmp_path / "fence.db").as_posix(),
        connect_args={"check_same_thread": False, "timeout": 0.2},
    )
    Base.metadata.create_all(bind=eng)
    factory = sessionmaker(bind=eng, autoflush=False)
    sessions = []

    def make():
        s = factory()
        sessions.append(s)
        return s

    yield make
    for s in sessions:
        s.close()
    eng.dispose()


def test_paused_worker_rejected_after_expiry_and_reacquisition(
        fake_redis, file_sessions, executor_mod, monkeypatch):
    """Roadmap verify scenario: worker A pauses inside its guarded finalization
    after its Redis check passed; its lease expires and worker B reacquires
    and commits. When A resumes, the database rejects A's writes."""
    # A's Redis check result is stale (e.g. a GC pause right after the check).
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)
    token_a = _st.acquire_scan_lock("full", timeout=1)
    session_a, session_b = file_sessions(), file_sessions()
    paused, resume = threading.Event(), threading.Event()
    outcome = {}

    @executor_mod._guard_scan_transactions
    def finalize_a(session, **kwargs):
        paused.set()
        assert resume.wait(5)
        session.add(Device(ip="10.0.0.1", sys_name="stale-writer"))
        session.commit()

    def run_a():
        try:
            finalize_a(session_a, lock_token=token_a)
            outcome["a"] = "committed"
        except executor_mod.StaleLeaseError:
            outcome["a"] = "rejected"

    worker_a = threading.Thread(target=run_a)
    worker_a.start()
    assert paused.wait(5)

    fake_redis.now += _st._SCAN_LOCK_TTL + 1  # A's lease expires
    token_b = _st.acquire_scan_lock("full", timeout=1)
    assert _st.fence_token_of(token_b) > _st.fence_token_of(token_a)
    _writer(executor_mod, "10.0.0.2")(session_b, lock_token=token_b)

    resume.set()
    worker_a.join(5)
    assert outcome["a"] == "rejected"
    check = file_sessions()
    assert check.query(Device).filter(Device.ip == "10.0.0.1").count() == 0
    assert check.query(Device).filter(Device.ip == "10.0.0.2").count() == 1
    assert _stored_fence(check) == _st.fence_token_of(token_b)


def test_open_fenced_transaction_blocks_newer_holder_until_it_ends(file_sessions, executor_mod, monkeypatch):
    """The fence is the first write of each guarded transaction, so a newer
    holder cannot interleave with an open older transaction: it waits on the
    database lock (SQLite: busy timeout, PostgreSQL: fence row lock)."""
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: True)
    session_a, session_b = file_sessions(), file_sessions()
    in_tx, release = threading.Event(), threading.Event()
    errors = []

    @executor_mod._guard_scan_transactions
    def finalize_a(session, **kwargs):
        session.add(Device(ip="10.0.0.1"))
        session.flush()
        in_tx.set()
        assert release.wait(5)
        session.commit()

    worker_a = threading.Thread(target=lambda: finalize_a(session_a, lock_token="a:1"))
    worker_a.start()
    assert in_tx.wait(5)
    try:
        _writer(executor_mod, "10.0.0.2")(session_b, lock_token="b:2")
    except sa.exc.OperationalError as exc:
        errors.append(exc)
    finally:
        release.set()
        worker_a.join(5)
    assert errors and "locked" in str(errors[0])
    # Older holder committed first; the newer holder succeeds afterwards.
    _writer(executor_mod, "10.0.0.2")(session_b, lock_token="b:2")
    check = file_sessions()
    assert check.query(Device).count() == 2
    assert _stored_fence(check) == 2


# ---------------------------------------------------------------------------
# Migration 020
# ---------------------------------------------------------------------------

def test_migration_020_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location(
        "_mig020", BACKEND / "alembic" / "versions" / "020_lease_fencing.py"
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "020" and mig.down_revision == "019"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        cols = {c["name"]: c for c in sa.inspect(conn).get_columns("lease_fences")}
        assert set(cols) == {"name", "token", "updated_at"}
        assert cols["token"]["nullable"] is False
        assert sa.inspect(conn).get_pk_constraint("lease_fences")["constrained_columns"] == ["name"]
        assert apply_fence(conn, "scan:lock", 3) is True
        assert apply_fence(conn, "scan:lock", 2) is False
        mig.downgrade()
        assert "lease_fences" not in sa.inspect(conn).get_table_names()


def test_alembic_head_is_025():
    from alembic.script import ScriptDirectory

    script = ScriptDirectory(str(BACKEND / "alembic"))
    assert script.get_heads() == ["025"]
