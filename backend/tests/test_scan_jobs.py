"""Tests for scan job state management and scheduling logic.

Phase T4: Covers unit-testable logic in scan_engine/jobs.py (via shared.state)
and scan_engine/scheduler.py (dispatch decisions).
"""
import threading
from unittest.mock import patch

import pytest

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
import shared.state as _st


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
