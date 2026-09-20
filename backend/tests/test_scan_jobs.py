"""Tests for scan job state management and scheduling logic.

Phase T4: Covers unit-testable logic in scan_engine/jobs.py (via shared.state)
and scan_engine/scheduler.py (dispatch decisions).
"""
import json
import logging
import threading
from unittest.mock import MagicMock, patch

import pytest

import shared.state as _st
from shared.state import (
    SCAN_JOBS,
    SCAN_JOBS_LOCK,
    can_dispatch_scan,
    get_scan_job,
    is_cancel_requested,
    request_scan_cancel,
    set_scan_job,
    update_scan_job,
)


@pytest.fixture(autouse=True)
def _reset_local_scan_state():
    """Reset in-memory scan state between tests."""
    original = _st._LOCAL_ACTIVE_SCAN
    yield
    _st._LOCAL_ACTIVE_SCAN = original
    with SCAN_JOBS_LOCK:
        for k in list(SCAN_JOBS.keys()):
            if k.startswith("test-"):
                del SCAN_JOBS[k]


@patch("shared.state.get_redis", return_value=None)
def test_can_dispatch_no_active_scan(_mock_redis):
    """can_dispatch_scan returns True when no scan is running (no Redis)."""
    _st._LOCAL_ACTIVE_SCAN = None
    assert can_dispatch_scan("discovery") is True
    assert can_dispatch_scan("macs") is True


@patch("shared.state.get_redis", return_value=None)
def test_can_dispatch_blocked_by_active_scan(_mock_redis):
    """can_dispatch_scan returns False when a scan is already active (no Redis)."""
    _st._LOCAL_ACTIVE_SCAN = "full"
    assert can_dispatch_scan("discovery") is False
    assert can_dispatch_scan("macs") is False


@patch("shared.state.get_redis", return_value=None)
def test_job_state_lifecycle(_mock_redis):
    """set/get/update scan job state round-trips correctly in-memory."""
    job_id = "test-lifecycle-001"
    set_scan_job(job_id, {"id": job_id, "status": "running", "result": None})

    job = get_scan_job(job_id)
    assert job is not None
    assert job["status"] == "running"
    assert job["result"] is None

    update_scan_job(job_id, {"status": "finished", "result": {"scanned": 5}})
    job = get_scan_job(job_id)
    assert job["status"] == "finished"
    assert job["result"]["scanned"] == 5


@patch("shared.state.get_redis", return_value=None)
def test_cancel_job_sets_event(_mock_redis):
    """request_scan_cancel sets cancel_requested flag and triggers cancel_event."""
    job_id = "test-cancel-001"
    cancel_event = threading.Event()
    set_scan_job(job_id, {
        "id": job_id,
        "status": "running",
        "cancel_requested": False,
        "cancel_event": cancel_event,
    })

    assert not is_cancel_requested(job_id)

    found = request_scan_cancel(job_id)
    assert found is True
    assert is_cancel_requested(job_id)
    assert cancel_event.is_set()


@patch("shared.state.get_redis", return_value=None)
def test_is_cancel_requested_unknown_job(_mock_redis):
    """is_cancel_requested returns False for non-existent job IDs."""
    assert is_cancel_requested("test-nonexistent-job") is False


class TestSchedulerShutdown:
    def test_shutdown_flag_stops_scheduler(self):
        from scan_engine.scheduler import _shutdown_requested, shutdown_scheduler
        _shutdown_requested.clear()
        assert not _shutdown_requested.is_set()
        shutdown_scheduler()
        assert _shutdown_requested.is_set()
        _shutdown_requested.clear()  # cleanup


# ---------------------------------------------------------------------------
# Scan lock ownership tokens (in-memory fallback path)
# ---------------------------------------------------------------------------

class TestScanLockTokens:
    @patch("shared.state.get_redis", return_value=None)
    def test_acquire_returns_owner_token(self, _mock_redis):
        token = _st.acquire_scan_lock("full", timeout=1)
        try:
            assert token
            assert _st._LOCAL_ACTIVE_SCAN == "full"
            # A second acquire fails while the lock is held
            assert _st.acquire_scan_lock("full", timeout=0.1) is None
        finally:
            _st.release_scan_lock(token, "full")

    @patch("shared.state.get_redis", return_value=None)
    def test_release_requires_matching_token(self, _mock_redis):
        token = _st.acquire_scan_lock("full", timeout=1)
        try:
            # A foreign token must not release the lock
            _st.release_scan_lock("foreign-token", "full")
            assert _st._LOCAL_ACTIVE_SCAN == "full"
            assert _st.acquire_scan_lock("full", timeout=0.1) is None
        finally:
            _st.release_scan_lock(token, "full")
        assert _st._LOCAL_ACTIVE_SCAN is None
        # Now a new acquire succeeds again
        token2 = _st.acquire_scan_lock("full", timeout=0.1)
        assert token2
        _st.release_scan_lock(token2, "full")

    @patch("shared.state.get_redis", return_value=None)
    def test_renew_only_for_owner(self, _mock_redis):
        token = _st.acquire_scan_lock("macs", timeout=1)
        try:
            assert _st.renew_scan_lock(token) is True
            assert _st.renew_scan_lock("foreign-token") is False
        finally:
            _st.release_scan_lock(token, "macs")


# ---------------------------------------------------------------------------
# Structured log buffer
# ---------------------------------------------------------------------------

class TestLogEntries:
    @patch("shared.state.get_redis", return_value=None)
    def test_log_event_timestamp_has_no_z_suffix(self, _mock_redis):
        _st._log_event(logging.INFO, "test.event.timestamp")
        with _st.LOG_BUFFER_LOCK:
            entry = _st.LOG_BUFFER[-1]
        # isoformat() already carries "+00:00"; a trailing "Z" would be invalid
        assert entry["ts"].endswith("+00:00")
        assert not entry["ts"].endswith("Z")

    def test_get_log_entries_redis_chronological_order(self):
        """The Redis list is newest-first (lpush); results must be the newest
        `limit` entries in chronological order, like the in-memory path."""
        payload = [
            {"ts": f"2024-01-01T00:00:0{i}+00:00", "level": "INFO", "event": f"e{i}"}
            for i in range(5)
        ]
        mock_redis = MagicMock()
        mock_redis.lrange.return_value = [json.dumps(p) for p in reversed(payload)]
        with patch("shared.state.get_redis", return_value=mock_redis):
            rows = _st.get_log_entries(limit=3)
        assert [r["event"] for r in rows] == ["e2", "e3", "e4"]
