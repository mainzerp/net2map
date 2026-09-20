"""Tests for the rack elevation layout endpoint (PATCH /api/racks/{id}/layout)."""
from database import Device
from database import Rack as RackModel


def _make_rack(db, label="LayoutRack", height_u=42):
    rack = RackModel(label=label, room="RZ-1", height_u=height_u)
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


def _make_device(db, name, ip, rack_id=None):
    dev = Device(sys_name=name, ip=ip, vendor="generic", rack_id=rack_id)
    db.add(dev)
    db.commit()
    db.refresh(dev)
    return dev


def test_layout_update_happy_path(client, auth_headers, db):
    rack = _make_rack(db)
    d1 = _make_device(db, "lay-sw1", "10.20.0.1", rack_id=rack.id)
    d2 = _make_device(db, "lay-sw2", "10.20.0.2", rack_id=rack.id)

    r = client.patch(
        f"/api/racks/{rack.id}/layout",
        json={"entries": [
            {"device_id": d1.id, "rack_u_position": 1, "u_height": 2},
            {"device_id": d2.id, "rack_u_position": 5, "u_height": 1},
        ]},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["updated"] == 2

    db.expire_all()
    d1 = db.query(Device).filter(Device.id == d1.id).first()
    d2 = db.query(Device).filter(Device.id == d2.id).first()
    assert d1.rack_u_position == 1
    assert d1.u_height == 2
    assert d2.rack_u_position == 5
    assert d2.u_height == 1


def test_layout_overlap_returns_409(client, auth_headers, db):
    rack = _make_rack(db)
    d1 = _make_device(db, "ov-sw1", "10.20.1.1", rack_id=rack.id)
    d2 = _make_device(db, "ov-sw2", "10.20.1.2", rack_id=rack.id)

    r = client.patch(
        f"/api/racks/{rack.id}/layout",
        json={"entries": [
            {"device_id": d1.id, "rack_u_position": 10, "u_height": 2},
            {"device_id": d2.id, "rack_u_position": 11, "u_height": 1},
        ]},
        headers=auth_headers,
    )
    assert r.status_code == 409
    body = r.json()["error"]
    assert body["code"] == "U_OVERLAP"
    assert str(d1.id) in body["message"]
    assert str(d2.id) in body["message"]


def test_layout_out_of_range_returns_409(client, auth_headers, db):
    rack = _make_rack(db, height_u=12)
    d1 = _make_device(db, "oor-sw1", "10.20.2.1", rack_id=rack.id)

    r = client.patch(
        f"/api/racks/{rack.id}/layout",
        json={"entries": [
            {"device_id": d1.id, "rack_u_position": 12, "u_height": 2},
        ]},
        headers=auth_headers,
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_POSITION_OUT_OF_RANGE"


def test_layout_device_not_in_rack_returns_422(client, auth_headers, db):
    rack = _make_rack(db)
    other = _make_rack(db, label="OtherRack")
    d1 = _make_device(db, "wr-sw1", "10.20.3.1", rack_id=other.id)

    r = client.patch(
        f"/api/racks/{rack.id}/layout",
        json={"entries": [
            {"device_id": d1.id, "rack_u_position": 1, "u_height": 1},
        ]},
        headers=auth_headers,
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "DEVICE_NOT_IN_RACK"


def test_layout_unknown_device_returns_404(client, auth_headers, db):
    rack = _make_rack(db)

    r = client.patch(
        f"/api/racks/{rack.id}/layout",
        json={"entries": [
            {"device_id": 9999, "rack_u_position": 1, "u_height": 1},
        ]},
        headers=auth_headers,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "DEVICE_NOT_FOUND"


def test_layout_unknown_rack_returns_404(client, auth_headers, db):
    r = client.patch(
        "/api/racks/9999/layout",
        json={"entries": []},
        headers=auth_headers,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "RACK_NOT_FOUND"


def test_layout_requires_privileged_role(client, viewer_jwt_headers, db):
    rack = _make_rack(db)
    d1 = _make_device(db, "rb-sw1", "10.20.4.1", rack_id=rack.id)

    r = client.patch(
        f"/api/racks/{rack.id}/layout",
        json={"entries": [
            {"device_id": d1.id, "rack_u_position": 1, "u_height": 1},
        ]},
        headers=viewer_jwt_headers,
    )
    assert r.status_code == 403


def test_device_meta_sets_rack_u_fields(client, auth_headers, db):
    rack = _make_rack(db)
    d1 = _make_device(db, "meta-sw1", "10.20.5.1", rack_id=rack.id)

    r = client.patch(
        f"/api/topology/devices/{d1.id}/meta",
        json={"rack_u_position": 7, "u_height": 4},
        headers=auth_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["rack_u_position"] == 7
    assert data["u_height"] == 4

    # Explicit null unplaces the device from the elevation
    r = client.patch(
        f"/api/topology/devices/{d1.id}/meta",
        json={"rack_u_position": None},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["rack_u_position"] is None


def test_rack_height_u_defaults_and_validation(client, auth_headers):
    r = client.post("/api/racks", json={"label": "DefRack"}, headers=auth_headers)
    assert r.status_code == 201
    assert r.json()["height_u"] == 42

    r = client.post("/api/racks", json={"label": "BadRack", "height_u": 100}, headers=auth_headers)
    assert r.status_code == 422
