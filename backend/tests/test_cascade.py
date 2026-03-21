"""Tests for CASCADE / FK delete behavior.

Phase T5: Verifies ORM-level cascades and SQLAlchemy FK handling
with SQLite foreign key enforcement enabled.
"""
import pytest
from sqlalchemy import text

from database import (
    Credential,
    Device,
    Endpoint,
    EndpointPortAssociation,
    Port,
    Rack,
    ScanRun,
    ScanRunSwitchMetric,
    SwitchClass,
)


@pytest.fixture(autouse=True)
def _enable_fk_enforcement(db):
    """Enable SQLite FK enforcement for CASCADE tests."""
    db.execute(text("PRAGMA foreign_keys = ON"))
    db.commit()
    yield
    db.execute(text("PRAGMA foreign_keys = OFF"))
    db.commit()


def test_device_delete_cascades_ports(db):
    """Deleting a Device removes its Ports via ORM cascade (delete-orphan)."""
    dev = Device(ip="10.99.0.1", sys_name="cascade-sw1")
    db.add(dev)
    db.flush()

    db.add(Port(device_id=dev.id, if_index=1, if_descr="GE0/1"))
    db.add(Port(device_id=dev.id, if_index=2, if_descr="GE0/2"))
    db.commit()

    assert db.query(Port).filter_by(device_id=dev.id).count() == 2

    db.delete(dev)
    db.commit()

    assert db.query(Port).count() == 0
    assert db.query(Device).filter_by(ip="10.99.0.1").first() is None


def test_scan_run_delete_cascades_metrics(db):
    """Deleting a ScanRun removes its ScanRunSwitchMetrics via ORM cascade."""
    run = ScanRun(status="finished", scanned=2, found=2)
    db.add(run)
    db.flush()

    db.add(ScanRunSwitchMetric(
        scan_run_id=run.id, ip="10.99.0.2", label="sw2",
        duration_ms=150, success=True,
    ))
    db.add(ScanRunSwitchMetric(
        scan_run_id=run.id, ip="10.99.0.3", label="sw3",
        duration_ms=200, success=False, error="timeout",
    ))
    db.commit()

    assert db.query(ScanRunSwitchMetric).filter_by(scan_run_id=run.id).count() == 2

    db.delete(run)
    db.commit()

    assert db.query(ScanRunSwitchMetric).count() == 0


def test_rack_delete_nullifies_device_rack_id(db):
    """Deleting a Rack sets device.rack_id to NULL (SQLAlchemy default FK handling)."""
    rack = Rack(label="Cascade Rack A")
    db.add(rack)
    db.flush()

    dev = Device(ip="10.99.0.4", sys_name="cascade-sw4", rack_id=rack.id)
    db.add(dev)
    db.commit()

    assert dev.rack_id == rack.id

    db.delete(rack)
    db.commit()

    db.refresh(dev)
    assert dev.rack_id is None
    assert db.query(Device).filter_by(ip="10.99.0.4").first() is not None


def test_class_delete_nullifies_device_class_id(db):
    """Deleting a SwitchClass sets device.class_id to NULL (SQLAlchemy default FK handling)."""
    sc = SwitchClass(label="Cascade Class")
    db.add(sc)
    db.flush()

    dev = Device(ip="10.99.0.5", sys_name="cascade-sw5", class_id=sc.id)
    db.add(dev)
    db.commit()

    assert dev.class_id == sc.id

    db.delete(sc)
    db.commit()

    db.refresh(dev)
    assert dev.class_id is None
    assert db.query(Device).filter_by(ip="10.99.0.5").first() is not None


def test_device_delete_nullifies_credential_device_id(db):
    """Deleting a Device sets credential.device_id to NULL (ondelete=SET NULL)."""
    dev = Device(ip="10.99.0.6", sys_name="cascade-sw6")
    db.add(dev)
    db.flush()

    cred = Credential(label="cascade-cred", ip="10.99.0.6", device_id=dev.id)
    db.add(cred)
    db.commit()

    assert cred.device_id == dev.id

    db.delete(dev)
    db.commit()

    db.refresh(cred)
    assert cred.device_id is None
    assert db.query(Credential).filter_by(ip="10.99.0.6").first() is not None


def test_device_delete_cascades_endpoint_port_associations(db):
    """Deleting a Device cascades ports -> cascades endpoint_port_associations."""
    dev = Device(ip="10.99.0.7", sys_name="cascade-sw7")
    db.add(dev)
    db.flush()

    port = Port(device_id=dev.id, if_index=1, if_descr="GE0/1")
    db.add(port)
    db.flush()

    ep = Endpoint(mac="aa:bb:cc:dd:ee:99", ip="10.99.0.200")
    db.add(ep)
    db.flush()

    assoc = EndpointPortAssociation(endpoint_id=ep.id, port_id=port.id, vlan_id=10)
    db.add(assoc)
    db.commit()

    assert db.query(EndpointPortAssociation).count() == 1

    db.delete(dev)
    db.commit()

    # Association removed (port gone), but endpoint remains
    assert db.query(EndpointPortAssociation).count() == 0
    assert db.query(Endpoint).filter_by(mac="aa:bb:cc:dd:ee:99").first() is not None


def test_endpoint_delete_cascades_associations(db):
    """Deleting an Endpoint removes its EndpointPortAssociations."""
    dev = Device(ip="10.99.0.8", sys_name="cascade-sw8")
    db.add(dev)
    db.flush()

    port = Port(device_id=dev.id, if_index=1, if_descr="GE0/1")
    db.add(port)
    db.flush()

    ep = Endpoint(mac="aa:bb:cc:dd:ee:aa", ip="10.99.0.201")
    db.add(ep)
    db.flush()

    assoc = EndpointPortAssociation(endpoint_id=ep.id, port_id=port.id)
    db.add(assoc)
    db.commit()

    assert db.query(EndpointPortAssociation).count() == 1

    db.delete(ep)
    db.commit()

    assert db.query(EndpointPortAssociation).count() == 0
    # Port and device remain
    assert db.query(Port).filter_by(device_id=dev.id).first() is not None
