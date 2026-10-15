"""Reverse DNS names of network devices: persistence, schema and migration 031."""
import importlib.util

import sqlalchemy as sa

from database import Device
from schemas import DeviceOut
from tests.test_stp_vlan import BACKEND, _finalize, _sw, executor_mod  # noqa: F401


def _finalize_with_hosts(executor_mod, db, switch_data, hostname_by_ip, scan_mode="discovery"):  # noqa: F811
    return executor_mod._finalize_scan_db(
        db,
        dry_run=False, scan_mode=scan_mode, corr="test", cancel_event=None,
        switch_data=switch_data,
        ping_by_ip={ip: (True, 1) for ip in switch_data},
        range_found_ips=[], range_matched_profile={}, range_no_profile_ips=[],
        errors=[], status="finished", total_duration_ms=1, scanned=len(switch_data),
        workers=1, switch_metrics=[], lock_token=None,
        hostname_by_ip=hostname_by_ip,
    )


def test_executor_stores_and_keeps_device_hostname(db, executor_mod):  # noqa: F811
    db.add(Device(ip="10.4.0.1", sys_name="core"))
    db.commit()
    _finalize_with_hosts(executor_mod, db, {"10.4.0.1": _sw("10.4.0.1"), "10.4.0.2": _sw("10.4.0.2")},
                         {"10.4.0.1": "core.lan", "10.4.0.2": "new.lan"})
    existing = db.query(Device).filter(Device.ip == "10.4.0.1").one()
    created = db.query(Device).filter(Device.ip == "10.4.0.2").one()
    db.refresh(existing)
    assert existing.hostname == "core.lan" and created.hostname == "new.lan"

    # A failed lookup ("") keeps the stored name.
    _finalize_with_hosts(executor_mod, db, {"10.4.0.1": _sw("10.4.0.1")}, {"10.4.0.1": ""})
    db.refresh(existing)
    assert existing.hostname == "core.lan"
    assert DeviceOut.model_validate(existing).hostname == "core.lan"


def test_device_out_hostname_defaults_to_empty():
    out = DeviceOut.model_validate({"id": 1, "sys_name": "sw", "ip": "10.0.0.1",
                                    "last_seen": "2026-01-01T00:00:00", "hostname": None})
    assert out.hostname == ""


def test_migration_031_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location("_mig031", BACKEND / "alembic" / "versions" / "031_device_hostname.py")
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "031" and mig.down_revision == "030"
    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY)"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        assert "hostname" in {c["name"] for c in sa.inspect(conn).get_columns("devices")}
        mig.downgrade()
        assert {c["name"] for c in sa.inspect(conn).get_columns("devices")} == {"id"}
