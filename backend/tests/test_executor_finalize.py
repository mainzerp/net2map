"""Regression tests for _finalize_scan_db device status updates.

A device that answers neither ping nor SNMP was previously absent from the
update set (discovered_ips only covered ping-ok IPs and SNMP responders), so
its ping_status stayed stuck on the last good result forever. These tests run
the real executor module -- conftest mocks the whole scan_engine package, so
the mock is temporarily removed.
"""
import asyncio
import sys
import threading
from unittest.mock import AsyncMock, Mock

import pytest

from database import Credential, Device, ScanRange
from schemas import ScanResult


@pytest.fixture()
def executor_mod():
    """Import the real scan_engine.executor despite the conftest package mock."""
    saved = {
        k: v for k, v in sys.modules.items()
        if k == "scan_engine" or k.startswith("scan_engine.")
    }
    for k in list(saved):
        sys.modules.pop(k, None)
    import importlib

    mod = importlib.import_module("scan_engine.executor")
    try:
        yield mod
    finally:
        for k in [k for k in sys.modules if k == "scan_engine" or k.startswith("scan_engine.")]:
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _finalize_kwargs(db, **overrides):
    kwargs = dict(
        dry_run=False,
        scan_mode="full",
        corr="test",
        cancel_event=None,
        switch_data={},
        ping_by_ip={},
        range_found_ips=[],
        range_matched_profile={},
        range_no_profile_ips=[],
        errors=[],
        status="finished",
        total_duration_ms=1,
        scanned=1,
        workers=1,
        switch_metrics=[],
        lock_token=None,
    )
    kwargs.update(overrides)
    return kwargs


def test_unresponsive_known_device_marked_offline(db, executor_mod):
    """Existing device with failed ping + no SNMP data must flip to offline."""
    dev = Device(ip="10.9.9.9", sys_name="ap", ping_status="online", ping_rtt_ms=5)
    db.add(dev)
    db.commit()

    executor_mod._finalize_scan_db(
        db,
        **_finalize_kwargs(db, ping_by_ip={"10.9.9.9": (False, 0)}),
    )

    db.refresh(dev)
    assert dev.ping_status == "offline"
    assert dev.ping_rtt_ms == 0
    assert dev.last_ping is not None


def test_unresponsive_unknown_device_not_created(db, executor_mod):
    """A pinged IP with no response and no existing device creates no row."""
    executor_mod._finalize_scan_db(
        db,
        **_finalize_kwargs(db, ping_by_ip={"10.9.9.10": (False, 0)}),
    )

    assert db.query(Device).filter(Device.ip == "10.9.9.10").first() is None


@pytest.mark.parametrize("scan_type", ["full", "discovery", "ranges", "ranges_all"])
def test_ignored_devices_are_not_scan_targets(db, executor_mod, monkeypatch, scan_type):
    db.add_all([
        Device(ip="10.9.9.9", ignored=True),
        Device(ip="10.9.9.10", ignored=True),
        Credential(ip="10.9.9.9", label="ignored", enabled=True),
        # 10.9.9.8/30 has the usable hosts .9 and .10
        ScanRange(cidr="10.9.9.8/30"),
    ])
    db.commit()
    subprocess = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", subprocess)
    result = asyncio.run(executor_mod._execute_scan(db, scan_type=scan_type))
    assert result.scanned == 0
    subprocess.assert_not_called()


def test_cancelled_scan_does_not_ping_queued_targets(db, executor_mod, monkeypatch):
    db.add(Credential(ip="10.9.9.9", label="queued", enabled=True))
    db.commit()
    cancel = threading.Event()
    cancel.set()
    subprocess = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", subprocess)
    result = asyncio.run(executor_mod._execute_scan(db, cancel_event=cancel, dry_run=True))
    assert result.status == "cancelled"
    subprocess.assert_not_called()


def test_lock_is_renewed_while_no_target_finishes(db, executor_mod, monkeypatch):
    renewed = asyncio.Event()
    renewal = Mock(side_effect=lambda token: renewed.set() or True)
    monkeypatch.setattr(executor_mod, "renew_scan_lock", renewal)
    monkeypatch.setattr(executor_mod, "_LOCK_RENEW_INTERVAL_SEC", 0.001)

    async def slow_scan(*args):
        await asyncio.wait_for(renewed.wait(), timeout=2)
        assert renewal.call_count > 0
        return ScanResult(scanned=0, found=0, links=0, errors=[], status="finished")

    monkeypatch.setattr(executor_mod, "_execute_scan_body", slow_scan)
    asyncio.run(executor_mod._execute_scan(db, lock_token="owner-token"))
    renewal.assert_called_with("owner-token")



def test_lock_heartbeat_stops_when_scan_fails(db, executor_mod, monkeypatch):
    renewed = asyncio.Event()
    renewal = Mock(side_effect=lambda token: renewed.set() or True)
    monkeypatch.setattr(executor_mod, "renew_scan_lock", renewal)
    monkeypatch.setattr(executor_mod, "_LOCK_RENEW_INTERVAL_SEC", 0.001)

    async def failed_scan(*args):
        await asyncio.wait_for(renewed.wait(), timeout=2)
        raise RuntimeError("scan failed")

    async def run():
        with pytest.raises(RuntimeError, match="scan failed"):
            await executor_mod._execute_scan(db, lock_token="owner-token")
        count = renewal.call_count
        assert count > 0
        await asyncio.sleep(0.01)
        assert renewal.call_count == count

    monkeypatch.setattr(executor_mod, "_execute_scan_body", failed_scan)
    asyncio.run(run())



@pytest.mark.parametrize("retries, terminal", [(0, False), (2, True)])
def test_celery_retry_status(db, executor_mod, monkeypatch, retries, terminal):
    import importlib

    from celery.exceptions import Retry

    tasks = importlib.import_module("tasks")
    update = Mock()
    release = Mock()
    session = Mock()
    monkeypatch.setattr(tasks, "SessionLocal", lambda: session)
    monkeypatch.setattr(tasks, "acquire_scan_lock", lambda *a, **k: "owner")
    monkeypatch.setattr(tasks, "release_scan_lock", release)
    monkeypatch.setattr(tasks, "update_scan_job", update)
    monkeypatch.setattr(tasks, "_execute_scan", AsyncMock(side_effect=ValueError("scan failure")))
    task = tasks.run_scan_task
    task.push_request(retries=retries, called_directly=False, is_eager=True)
    try:
        if terminal:
            with pytest.raises(ValueError, match="scan failure"):
                task.run("job")
            assert update.call_args.args[1]["status"] == "failed"
            assert update.call_args.args[1]["finished_at"]
        else:
            with pytest.raises(Retry):
                task.run("job")
            assert update.call_args.args[1]["status"] == "retrying"
    finally:
        task.pop_request()
    release.assert_called_once_with("owner", "full")
    session.close.assert_called_once()


def test_scheduler_enqueue_failure_finishes_queued_job(executor_mod, monkeypatch):
    import importlib

    import shared.redis_client
    import shared.state

    scheduler = importlib.import_module("scan_engine.scheduler")
    tasks = importlib.import_module("tasks")
    queued = Mock()
    update = Mock()
    monkeypatch.setattr(scheduler, "can_dispatch_scan", lambda kind: True)
    monkeypatch.setattr(shared.redis_client, "get_redis", lambda: object())
    monkeypatch.setattr(scheduler, "set_scan_job", queued)
    monkeypatch.setattr(scheduler, "update_scan_job", update)
    monkeypatch.setattr(tasks.run_scan_task, "delay", Mock(side_effect=RuntimeError("broker down")))
    monkeypatch.setattr(shared.state, "acquire_scan_lock", lambda *a, **k: None)
    scheduler._dispatch_scheduled_scan("full")
    assert queued.call_args.args[1]["status"] == "queued"
    assert update.call_args.args[0] == queued.call_args.args[0]
    assert update.call_args.args[1]["status"] == "failed"
    assert update.call_args.args[1]["finished_at"]


def test_lost_lock_never_starts_scan(db, executor_mod, monkeypatch):
    scan = AsyncMock()
    monkeypatch.setattr(executor_mod, "_execute_scan_body", scan)
    monkeypatch.setattr(executor_mod, "renew_scan_lock", lambda token: False)
    with pytest.raises(executor_mod.ScanOwnershipLost):
        asyncio.run(executor_mod._execute_scan(db, lock_token="stale-owner"))
    scan.assert_not_called()


def test_lost_heartbeat_cancels_ping_and_reaps_process(db, executor_mod, monkeypatch):
    db.add(Credential(ip="10.9.9.9", label="slow", enabled=True))
    db.commit()
    monkeypatch.setattr(executor_mod, "_LOCK_RENEW_INTERVAL_SEC", 0.001)
    # The setup phase and lease checks run in worker threads, so the first
    # renewal can fire before the ping starts. Lose the lease only once the
    # ping is in flight; this is the situation the test is about.
    ping_started = threading.Event()
    renewal = Mock(side_effect=lambda token: not ping_started.is_set())
    monkeypatch.setattr(executor_mod, "renew_scan_lock", renewal)
    finalizer = Mock()
    monkeypatch.setattr(executor_mod, "_finalize_scan_db", finalizer)
    proc = Mock(returncode=None)

    async def blocked_communicate():
        ping_started.set()
        await asyncio.sleep(30)

    proc.communicate = AsyncMock(side_effect=blocked_communicate)
    proc.wait = AsyncMock(return_value=0)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    with pytest.raises(executor_mod.ScanOwnershipLost):
        asyncio.run(executor_mod._execute_scan(db, lock_token="owner"))
    assert ping_started.is_set()
    proc.kill.assert_called_once()
    proc.wait.assert_awaited_once()
    finalizer.assert_not_called()


def test_external_cancellation_awaits_all_snmp_targets(db, executor_mod, monkeypatch):
    db.add_all([Credential(ip="10.9.9.9", label="one", enabled=True),
                Credential(ip="10.9.9.10", label="two", enabled=True)])
    db.commit()
    monkeypatch.setattr(executor_mod, "_read_scan_settings", lambda: {"max_workers": 2})
    proc = Mock(returncode=0)
    proc.communicate = AsyncMock(return_value=(b"time=1ms", b""))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    started = []
    stopped = []
    both_started = asyncio.Event()

    async def blocked_snmp(**kwargs):
        started.append(kwargs["ip"])
        if len(started) == 2:
            both_started.set()
        try:
            await asyncio.sleep(30)
        finally:
            stopped.append(kwargs["ip"])

    monkeypatch.setattr(executor_mod, "scan_switch", blocked_snmp)
    finalizer = Mock()
    monkeypatch.setattr(executor_mod, "_finalize_scan_db", finalizer)

    async def run():
        task = asyncio.create_task(executor_mod._execute_scan(db))
        await asyncio.wait_for(both_started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert set(stopped) == set(started)

    asyncio.run(run())
    finalizer.assert_not_called()


def test_cancelled_finalizer_drains_thread_and_blocks_commit(db, executor_mod, monkeypatch):
    db.add(Credential(ip="10.9.9.9", label="queued", enabled=True))
    db.commit()
    user_cancel = threading.Event()
    user_cancel.set()
    thread_started = threading.Event()
    thread_release = threading.Event()
    thread_finished = threading.Event()

    @executor_mod._guard_scan_transactions
    def blocked_finalize(session, **kwargs):
        thread_started.set()
        try:
            assert thread_release.wait(3)
            session.add(Device(ip="10.9.9.11", sys_name="must-not-commit"))
            session.commit()
            raise AssertionError("Cancelled finalization committed")
        finally:
            thread_finished.set()

    monkeypatch.setattr(executor_mod, "_finalize_scan_db", blocked_finalize)

    async def run():
        task = asyncio.create_task(executor_mod._execute_scan(db, cancel_event=user_cancel))
        assert await asyncio.to_thread(thread_started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        thread_release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert thread_finished.is_set()

    asyncio.run(run())
    assert db.query(Device).filter(Device.ip == "10.9.9.11").count() == 0
    # The temporary commit listener must be removed; this unrelated write still works.
    db.add(Device(ip="10.9.9.12", sys_name="next-session-write"))
    db.commit()


def test_lease_loss_rejects_nested_scan_run_commit(db, executor_mod, monkeypatch):
    from database import DryRunResult, ScanRun

    monkeypatch.setattr(executor_mod, "renew_scan_lock", Mock(side_effect=[True, False]))
    with pytest.raises(executor_mod.ScanOwnershipLost):
        executor_mod._finalize_scan_db(db, **_finalize_kwargs(db, dry_run=True, lock_token="owner"))
    assert db.query(ScanRun).count() == 0
    assert db.query(DryRunResult).count() == 0


def test_lease_loss_cannot_be_reversed(executor_mod, monkeypatch):
    renewal = Mock(side_effect=[False, True])
    monkeypatch.setattr(executor_mod, "renew_scan_lock", renewal)
    lease = executor_mod._ScanLease("owner")
    for _ in range(2):
        with pytest.raises(executor_mod.ScanOwnershipLost):
            lease.check()
    assert renewal.call_count == 1


def test_lease_loss_during_flush_rolls_back_before_commit(db, executor_mod, monkeypatch):
    monkeypatch.setattr(executor_mod, "renew_scan_lock", Mock(side_effect=[True, True, False]))

    @executor_mod._guard_scan_transactions
    def finalize(session, **kwargs):
        session.add(Device(ip="10.9.9.11", sys_name="must-roll-back"))
        session.commit()

    with pytest.raises(executor_mod.ScanOwnershipLost):
        finalize(db, lock_token="owner")
    assert db.query(Device).filter(Device.ip == "10.9.9.11").count() == 0
    db.add(Device(ip="10.9.9.12", sys_name="after-listener-cleanup"))
    db.commit()
