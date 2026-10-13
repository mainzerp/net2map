"""Tests for manually maintained rack items (patch panels, blanks, ...)."""
from database import Device, RackItem
from database import Rack as RackModel


def _make_rack(db, label="ItemRack", height_u=42):
    rack = RackModel(label=label, room="RZ-1", height_u=height_u)
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


def _make_device(db, name, ip, rack_id=None, position=None, u_height=1):
    dev = Device(sys_name=name, ip=ip, vendor="generic", rack_id=rack_id,
                 rack_u_position=position, u_height=u_height)
    db.add(dev)
    db.commit()
    db.refresh(dev)
    return dev


def _create_item(client, headers, rack_id, **fields):
    body = {"kind": "patch_panel", "label": "PP-01", "rack_u_position": 10, "u_height": 1}
    body.update(fields)
    return client.post(f"/api/v1/racks/{rack_id}/items", json=body, headers=headers)


def test_rack_item_crud(client, auth_headers, db):
    rack = _make_rack(db)

    r = _create_item(client, auth_headers, rack.id, note="Floor A uplinks")
    assert r.status_code == 201
    item = r.json()
    assert item["rack_id"] == rack.id
    assert item["kind"] == "patch_panel"
    assert item["label"] == "PP-01"
    assert item["rack_u_position"] == 10
    assert item["u_height"] == 1
    assert item["note"] == "Floor A uplinks"
    assert item["created_at"] is not None

    r = client.get(f"/api/v1/racks/{rack.id}/items", headers=auth_headers)
    assert r.status_code == 200
    assert [i["id"] for i in r.json()] == [item["id"]]

    r = client.patch(
        f"/api/v1/rack-items/{item['id']}",
        json={"label": "PP-02", "kind": "blank", "u_height": 2, "note": None},
        headers=auth_headers,
    )
    assert r.status_code == 200
    updated = r.json()
    assert updated["label"] == "PP-02"
    assert updated["kind"] == "blank"
    assert updated["u_height"] == 2
    assert updated["note"] is None

    r = client.delete(f"/api/v1/rack-items/{item['id']}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get(f"/api/v1/racks/{rack.id}/items", headers=auth_headers)
    assert r.json() == []


def test_rack_item_legacy_alias(client, auth_headers, db):
    rack = _make_rack(db)
    r = client.post(
        f"/api/racks/{rack.id}/items",
        json={"label": "Blank", "kind": "blank", "rack_u_position": 1},
        headers=auth_headers,
    )
    assert r.status_code == 201
    assert r.json()["u_height"] == 1


def test_rack_item_unknown_kind_rejected(client, auth_headers, db):
    rack = _make_rack(db)
    r = _create_item(client, auth_headers, rack.id, kind="server")
    assert r.status_code == 422


def test_rack_item_unknown_rack_and_item_return_404(client, auth_headers):
    r = _create_item(client, auth_headers, 9999)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "RACK_NOT_FOUND"

    r = client.get("/api/v1/racks/9999/items", headers=auth_headers)
    assert r.status_code == 404

    r = client.patch("/api/v1/rack-items/9999", json={"label": "x"}, headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "RACK_ITEM_NOT_FOUND"

    r = client.delete("/api/v1/rack-items/9999", headers=auth_headers)
    assert r.status_code == 404


def test_rack_item_out_of_rack_rejected(client, auth_headers, db):
    rack = _make_rack(db, height_u=12)

    r = _create_item(client, auth_headers, rack.id, rack_u_position=12, u_height=2)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_POSITION_OUT_OF_RANGE"

    r = _create_item(client, auth_headers, rack.id, rack_u_position=11, u_height=2)
    assert r.status_code == 201
    item_id = r.json()["id"]

    r = client.patch(f"/api/v1/rack-items/{item_id}", json={"u_height": 3}, headers=auth_headers)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_POSITION_OUT_OF_RANGE"


def test_rack_item_overlapping_device_rejected(client, auth_headers, db):
    rack = _make_rack(db)
    dev = _make_device(db, "it-sw1", "10.30.0.1", rack_id=rack.id, position=5, u_height=2)

    r = _create_item(client, auth_headers, rack.id, rack_u_position=6, u_height=1)
    assert r.status_code == 409
    body = r.json()["error"]
    assert body["code"] == "U_OVERLAP"
    assert f"device {dev.id}" in body["message"]

    # Directly adjacent above the device is fine
    r = _create_item(client, auth_headers, rack.id, rack_u_position=7, u_height=1)
    assert r.status_code == 201


def test_rack_item_overlapping_item_rejected(client, auth_headers, db):
    rack = _make_rack(db)
    first = _create_item(client, auth_headers, rack.id, rack_u_position=20, u_height=2).json()

    r = _create_item(client, auth_headers, rack.id, label="PP-02", rack_u_position=21, u_height=1)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_OVERLAP"

    second = _create_item(client, auth_headers, rack.id, label="PP-02", rack_u_position=22).json()
    r = client.patch(f"/api/v1/rack-items/{second['id']}", json={"rack_u_position": 21}, headers=auth_headers)
    assert r.status_code == 409
    assert f"rack item {first['id']}" in r.json()["error"]["message"]

    # Moving an item within its own former range does not collide with itself
    r = client.patch(f"/api/v1/rack-items/{first['id']}", json={"rack_u_position": 19}, headers=auth_headers)
    assert r.status_code == 200


def test_rack_item_cascade_on_rack_delete(client, auth_headers, db):
    rack = _make_rack(db)
    assert _create_item(client, auth_headers, rack.id).status_code == 201
    assert _create_item(client, auth_headers, rack.id, rack_u_position=11).status_code == 201

    r = client.delete(f"/api/v1/racks/{rack.id}", headers=auth_headers)
    assert r.status_code == 204
    db.expire_all()
    assert db.query(RackItem).count() == 0


def test_layout_rejects_device_overlapping_item(client, auth_headers, db):
    rack = _make_rack(db)
    dev = _make_device(db, "it-sw2", "10.30.0.2", rack_id=rack.id)
    item = _create_item(client, auth_headers, rack.id, rack_u_position=10, u_height=2).json()

    r = client.patch(
        f"/api/v1/racks/{rack.id}/layout",
        json={"entries": [{"device_id": dev.id, "rack_u_position": 9, "u_height": 2}]},
        headers=auth_headers,
    )
    assert r.status_code == 409
    body = r.json()["error"]
    assert body["code"] == "U_OVERLAP"
    assert f"rack item {item['id']}" in body["message"]

    r = client.patch(
        f"/api/v1/racks/{rack.id}/layout",
        json={"entries": [{"device_id": dev.id, "rack_u_position": 12, "u_height": 1}]},
        headers=auth_headers,
    )
    assert r.status_code == 200


def test_rack_height_cannot_exclude_item(client, auth_headers, db):
    rack = _make_rack(db)
    assert _create_item(client, auth_headers, rack.id, rack_u_position=30).status_code == 201

    r = client.put(f"/api/v1/racks/{rack.id}", json={"height_u": 24}, headers=auth_headers)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_POSITION_OUT_OF_RANGE"


def test_rack_item_writes_require_privileged_role(client, viewer_jwt_headers, auth_headers, db):
    rack = _make_rack(db)
    r = _create_item(client, viewer_jwt_headers, rack.id)
    assert r.status_code == 403

    item = _create_item(client, auth_headers, rack.id).json()
    r = client.patch(f"/api/v1/rack-items/{item['id']}", json={"label": "x"}, headers=viewer_jwt_headers)
    assert r.status_code == 403
    r = client.delete(f"/api/v1/rack-items/{item['id']}", headers=viewer_jwt_headers)
    assert r.status_code == 403

    r = client.get(f"/api/v1/racks/{rack.id}/items", headers=viewer_jwt_headers)
    assert r.status_code == 200
