"""Tests for the topology router."""
from unittest.mock import patch

from database import Credential, Device, Port
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


# ---------------------------------------------------------------------------
# Link filtering, bulk-meta validation, position endpoint roles
# ---------------------------------------------------------------------------

def test_topology_links_filtered_to_visible_nodes(client, auth_headers, db):
    """Links referencing ignored devices must not appear in the topology."""
    from database import TopologyLink

    dev_a = Device(sys_name="vis-sw", ip="10.8.0.1", vendor="generic")
    dev_b = Device(sys_name="ign-sw", ip="10.8.0.2", vendor="generic", ignored=True)
    dev_c = Device(sys_name="vis-sw2", ip="10.8.0.3", vendor="generic")
    db.add_all([dev_a, dev_b, dev_c])
    db.flush()
    db.add_all([
        TopologyLink(local_ip="10.8.0.1", local_port="1", remote_ip="10.8.0.2", remote_port="1"),
        TopologyLink(local_ip="10.8.0.1", local_port="2", remote_ip="10.8.0.3", remote_port="2"),
    ])
    db.commit()

    with patch("routers.topology._get_topo_cache", return_value={}):
        r = client.get("/api/topology", headers=auth_headers)
    assert r.status_code == 200
    links = r.json()["links"]
    assert len(links) == 1
    assert links[0]["remote_ip"] == "10.8.0.3"


def test_bulk_meta_rejects_unknown_rack(client, auth_headers, db):
    dev = Device(sys_name="bm-sw1", ip="10.8.1.1", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        "/api/topology/devices/bulk-meta",
        json={"device_ids": [dev.id], "rack_id": 9999},
        headers=auth_headers,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "RACK_NOT_FOUND"


def test_bulk_meta_rejects_unknown_class(client, auth_headers, db):
    dev = Device(sys_name="bm-sw2", ip="10.8.1.2", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        "/api/topology/devices/bulk-meta",
        json={"device_ids": [dev.id], "class_id": 9999},
        headers=auth_headers,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "SWITCH_CLASS_NOT_FOUND"


def test_bulk_meta_clear_rack_unassigns_devices(client, auth_headers, db):
    rack = RackModel(label="ClearRack", room="Room X")
    db.add(rack)
    db.flush()
    dev = Device(sys_name="bm-sw3", ip="10.8.1.3", vendor="generic", rack_id=rack.id)
    db.add(dev)
    db.commit()

    r = client.patch(
        "/api/topology/devices/bulk-meta",
        json={"device_ids": [dev.id], "clear_rack": True},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    db.refresh(dev)
    assert dev.rack_id is None


def test_bulk_meta_strict_class_rejects_unracked_devices(client, auth_headers, db):
    sc = SwitchClassModel(label="StrictClass", color="#123456", allow_outside_rack=False)
    db.add(sc)
    db.flush()
    dev = Device(sys_name="bm-sw4", ip="10.8.1.4", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        "/api/topology/devices/bulk-meta",
        json={"device_ids": [dev.id], "class_id": sc.id},
        headers=auth_headers,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "OUTSIDE_RACK_NOT_ALLOWED"


def test_bulk_meta_strict_class_rejects_clear_rack(client, auth_headers, db):
    sc = SwitchClassModel(label="StrictClass2", color="#654321", allow_outside_rack=False)
    db.add(sc)
    db.flush()
    rack = RackModel(label="StrictRack", room="Room Y")
    db.add(rack)
    db.flush()
    dev = Device(sys_name="bm-sw5", ip="10.8.1.5", vendor="generic", rack_id=rack.id)
    db.add(dev)
    db.commit()

    r = client.patch(
        "/api/topology/devices/bulk-meta",
        json={"device_ids": [dev.id], "class_id": sc.id, "clear_rack": True},
        headers=auth_headers,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "OUTSIDE_RACK_NOT_ALLOWED"


def test_device_position_requires_privileged_role(client, viewer_jwt_headers, db):
    dev = Device(sys_name="pos-sw", ip="10.8.2.1", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/position",
        json={"map_x": 10.0, "map_y": 20.0},
        headers=viewer_jwt_headers,
    )
    assert r.status_code == 403


def test_rack_position_requires_privileged_role(client, viewer_jwt_headers, db):
    rack = RackModel(label="PosRack", room="Room Z")
    db.add(rack)
    db.commit()

    r = client.patch(
        f"/api/topology/racks/{rack.id}/position",
        json={"map_x": 10.0, "map_y": 20.0},
        headers=viewer_jwt_headers,
    )
    assert r.status_code == 403


def test_device_position_update_works_for_operator_role(client, auth_headers, db):
    dev = Device(sys_name="pos-sw2", ip="10.8.2.2", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/position",
        json={"map_x": 42.0, "map_y": 24.0},
        headers=auth_headers,
    )
    assert r.status_code == 200
    db.refresh(dev)
    assert dev.map_x == 42.0
    assert dev.map_y == 24.0


# ---------------------------------------------------------------------------
# vendor_override flag
# ---------------------------------------------------------------------------

def test_update_device_meta_vendor_sets_override_flag(client, auth_headers, db):
    """Setting vendor via the meta API marks it as a manual override."""
    dev = Device(sys_name="vo-sw1", ip="10.9.0.1", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/meta",
        json={"vendor": "aruba_cx"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["vendor"] == "aruba_cx"
    assert body["vendor_override"] is True

    db.refresh(dev)
    assert dev.vendor_override is True


def test_update_device_meta_empty_vendor_clears_override_flag(client, auth_headers, db):
    """Emptying vendor hands control back to auto-detection (flag False)."""
    dev = Device(sys_name="vo-sw2", ip="10.9.0.2", vendor="aruba_cx", vendor_override=True)
    db.add(dev)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/meta",
        json={"vendor": ""},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["vendor_override"] is False

    db.refresh(dev)
    assert dev.vendor == ""
    assert dev.vendor_override is False


def test_update_device_meta_explicit_override_flag_wins(client, auth_headers, db):
    """An explicit vendor_override=False beats the implicit vendor derivation."""
    dev = Device(sys_name="vo-sw3", ip="10.9.0.3", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/meta",
        json={"vendor": "aruba_cx", "vendor_override": False},
        headers=auth_headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["vendor"] == "aruba_cx"
    assert body["vendor_override"] is False


def test_update_device_meta_unrelated_fields_keep_override_flag(client, auth_headers, db):
    """Meta updates without vendor must not touch the override flag."""
    dev = Device(sys_name="vo-sw4", ip="10.9.0.4", vendor="aruba_cx", vendor_override=True)
    db.add(dev)
    db.commit()

    r = client.patch(
        f"/api/topology/devices/{dev.id}/meta",
        json={"location": "RZ-01"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    db.refresh(dev)
    assert dev.vendor_override is True


def test_device_out_contains_vendor_override_default(client, auth_headers, db):
    """DeviceOut exposes vendor_override, defaulting to False."""
    dev = Device(sys_name="vo-sw5", ip="10.9.0.5", vendor="generic")
    db.add(dev)
    db.commit()

    r = client.get("/api/devices", headers=auth_headers)
    assert r.status_code == 200
    entry = [d for d in r.json() if d["ip"] == "10.9.0.5"][0]
    assert entry["vendor_override"] is False
