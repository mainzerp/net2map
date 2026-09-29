"""Regression tests for _finalize_scan_db device status updates.

A device that answers neither ping nor SNMP was previously absent from the
update set (discovered_ips only covered ping-ok IPs and SNMP responders), so
its ping_status stayed stuck on the last good result forever. These tests run
the real executor module -- conftest mocks the whole scan_engine package, so
the mock is temporarily removed.
"""
import sys

import pytest

from database import Device


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
