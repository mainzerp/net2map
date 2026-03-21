"""Tests for the topology router."""
from unittest.mock import patch
from database import Device, Credential, Port, TopologyLink
from database import Rack as RackModel
from database import SwitchClass as SwitchClassModel


def test_topology_returns_structure(client, auth_headers, db):
    """GET /api/topology returns expected top-level keys."""
    # Clear any cached topology from prior tests
    with patch("routers.topology._get_topo_cache", return_value={}):
        r = client.get("/api/topology", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert "nodes" in data
    assert "links" in data
    assert "racks" in data


def test_topology_includes_seeded_device(client, auth_headers, db):
    """Devices appear in topology nodes."""
    rack = RackModel(label="Rack-1", room="Room A")
    db.add(rack)
    db.flush()

    dev = Device(
        sys_name="core-sw-01", ip="10.0.0.1", vendor="generic",
        rack_id=rack.id,
    )
    db.add(dev)
    db.flush()

    cred = Credential(label="sw1-cred", ip="10.0.0.1", device_id=dev.id)
    db.add(cred)
    db.flush()

    port = Port(device_id=dev.id, if_index=1, if_descr="eth0", oper_status=1)
    db.add(port)
    db.commit()

    # Clear topo cache to force fresh query
    with patch("routers.topology._get_topo_cache", return_value={}):
        r = client.get("/api/topology", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    ips = [n["ip"] for n in data["nodes"]]
    assert "10.0.0.1" in ips


def test_topology_excludes_ignored_devices(client, auth_headers, db):
    """Ignored devices should not appear in topology."""
    dev = Device(
        sys_name="ignored-sw", ip="10.0.0.99", vendor="generic",
        ignored=True,
    )
    db.add(dev)
    db.commit()

    with patch("routers.topology._get_topo_cache", return_value={}):
        r = client.get("/api/topology", headers=auth_headers)
    data = r.json()
    ips = [n["ip"] for n in data["nodes"]]
    assert "10.0.0.99" not in ips


def test_devices_list_returns_all_devices(client, auth_headers, db):
    """GET /api/devices returns all devices."""
    dev = Device(sys_name="dev1", ip="192.168.99.1", vendor="generic")
    db.add(dev)
    db.commit()

    with patch("routers.topology._get_topo_cache", return_value={}):
        r = client.get("/api/devices", headers=auth_headers)
    data = r.json()
    ips = [d["ip"] for d in data]
    assert "192.168.99.1" in ips


def test_update_device_meta_does_not_sync_credential(client, auth_headers, db):
    """PATCH /api/topology/devices/{id}/meta does NOT modify Credential."""
    rack = RackModel(label="SyncRack", room="Room B")
    db.add(rack)
    db.flush()

    sc = SwitchClassModel(label="SyncClass", color="#ff0000", allow_outside_rack=True)
    db.add(sc)
    db.flush()

    dev = Device(sys_name="sync-sw", ip="10.0.0.50", vendor="generic")
    db.add(dev)
    db.flush()

    cred = Credential(label="sync-cred", ip="10.0.0.50", device_id=dev.id)
    db.add(cred)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/meta",
        json={"rack_id": rack.id, "class_id": sc.id},
        headers=auth_headers,
    )
    assert r.status_code == 200

    db.refresh(dev)
    assert dev.rack_id == rack.id
    assert dev.class_id == sc.id

    # Credential should NOT have rack_id/class_id (those fields no longer exist)
    db.refresh(cred)
    assert not hasattr(cred, "rack_id") or not hasattr(cred, "class_id")


def test_bulk_update_device_meta_does_not_sync_credentials(client, auth_headers, db):
    """PATCH /api/topology/devices/bulk-meta does NOT modify Credential."""
    rack = RackModel(label="BulkRack", room="Room C")
    db.add(rack)
    db.flush()

    sc = SwitchClassModel(label="BulkClass", color="#00ff00", allow_outside_rack=True)
    db.add(sc)
    db.flush()

    dev1 = Device(sys_name="bulk-sw1", ip="10.0.0.60", vendor="generic")
    dev2 = Device(sys_name="bulk-sw2", ip="10.0.0.61", vendor="generic")
    db.add_all([dev1, dev2])
    db.flush()

    cred1 = Credential(label="bulk-c1", ip="10.0.0.60", device_id=dev1.id)
    cred2 = Credential(label="bulk-c2", ip="10.0.0.61", device_id=dev2.id)
    db.add_all([cred1, cred2])
    db.commit()

    r = client.patch(
        "/api/topology/devices/bulk-meta",
        json={"device_ids": [dev1.id, dev2.id], "rack_id": rack.id, "class_id": sc.id},
        headers=auth_headers,
    )
    assert r.status_code == 200

    db.refresh(dev1)
    db.refresh(dev2)
    assert dev1.rack_id == rack.id
    assert dev2.rack_id == rack.id
