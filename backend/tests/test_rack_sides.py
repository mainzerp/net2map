"""Rack sides and depth: side-aware U-space occupancy for devices and rack items."""
from database import Device
from database import Rack as RackModel
from shared.rack_space import RackSlot, find_pairwise_conflict, occupied_sides, slots_conflict


def _make_rack(db, label="SideRack", height_u=42):
    rack = RackModel(label=label, room="RZ-1", height_u=height_u)
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


def _make_device(db, ip, rack_id=None, position=None, u_height=1, side="front", full_depth=False):
    dev = Device(sys_name=ip, ip=ip, vendor="generic", rack_id=rack_id, rack_u_position=position,
                 u_height=u_height, rack_side=side, full_depth=full_depth)
    db.add(dev)
    db.commit()
    db.refresh(dev)
    return dev


def _create_item(client, headers, rack_id, **fields):
    body = {"kind": "patch_panel", "label": "PP", "rack_u_position": 10, "u_height": 1}
    body.update(fields)
    return client.post(f"/api/v1/racks/{rack_id}/items", json=body, headers=headers)


def _meta(client, headers, device_id, **fields):
    return client.patch(f"/api/v1/topology/devices/{device_id}/meta", json=fields, headers=headers)


# ---------------------------------------------------------------------------
# Pure occupancy rule
# ---------------------------------------------------------------------------

def test_occupancy_rule():
    assert occupied_sides("front", False) == {"front"}
    assert occupied_sides("rear", False) == {"rear"}
    assert occupied_sides("rear", True) == {"front", "rear"}

    front = RackSlot(10, 2, "front")
    rear = RackSlot(10, 2, "rear")
    deep = RackSlot(11, 1, "rear", True)
    above = RackSlot(12, 1, "front", True)
    assert not slots_conflict(front, rear)
    assert slots_conflict(front, deep) and slots_conflict(rear, deep)
    assert not slots_conflict(front, above)
    assert find_pairwise_conflict([front, rear, above]) is None
    assert find_pairwise_conflict([front, rear, deep]) is not None


# ---------------------------------------------------------------------------
# Rack items
# ---------------------------------------------------------------------------

def test_rack_item_front_and_rear_share_u(client, auth_headers, db):
    rack = _make_rack(db)
    r = _create_item(client, auth_headers, rack.id)
    assert r.status_code == 201
    assert r.json()["rack_side"] == "front" and r.json()["full_depth"] is False

    r = _create_item(client, auth_headers, rack.id, rack_side="rear")
    assert r.status_code == 201
    rear = r.json()
    assert rear["rack_side"] == "rear"

    # A third item on the front side of the same U conflicts
    r = _create_item(client, auth_headers, rack.id, rack_side="front")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_OVERLAP"

    # Making the rear item full depth now conflicts with the front item
    r = client.patch(f"/api/v1/rack-items/{rear['id']}", json={"full_depth": True}, headers=auth_headers)
    assert r.status_code == 409

    # Moving it to the other side, freeing nothing, is equally refused
    r = client.patch(f"/api/v1/rack-items/{rear['id']}", json={"rack_side": "front"}, headers=auth_headers)
    assert r.status_code == 409

    items = client.get(f"/api/v1/racks/{rack.id}/items", headers=auth_headers).json()
    assert sorted(i["rack_side"] for i in items) == ["front", "rear"]


def test_rack_item_full_depth_conflicts_with_rear_device(client, auth_headers, db):
    rack = _make_rack(db)
    dev = _make_device(db, "10.50.0.1", rack_id=rack.id, position=20, side="rear")

    assert _create_item(client, auth_headers, rack.id, rack_u_position=20).status_code == 201
    r = _create_item(client, auth_headers, rack.id, rack_u_position=20, full_depth=True)
    assert r.status_code == 409
    body = r.json()["error"]
    assert body["code"] == "U_OVERLAP"
    # Devices are checked before rack items, so the rear device is reported
    assert body["details"][0]["device_ids"] == [dev.id]

    r = _create_item(client, auth_headers, rack.id, rack_side="sideways")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Rack layout
# ---------------------------------------------------------------------------

def test_layout_front_and_rear_same_u(client, auth_headers, db):
    rack = _make_rack(db)
    d1 = _make_device(db, "10.51.0.1", rack_id=rack.id)
    d2 = _make_device(db, "10.51.0.2", rack_id=rack.id)

    r = client.patch(f"/api/v1/racks/{rack.id}/layout", json={"entries": [
        {"device_id": d1.id, "rack_u_position": 5, "u_height": 2, "rack_side": "front"},
        {"device_id": d2.id, "rack_u_position": 5, "u_height": 2, "rack_side": "rear"},
    ]}, headers=auth_headers)
    assert r.status_code == 200
    db.expire_all()
    assert db.get(Device, d2.id).rack_side == "rear"

    # full_depth on one of them conflicts with the other side
    r = client.patch(f"/api/v1/racks/{rack.id}/layout", json={"entries": [
        {"device_id": d1.id, "rack_u_position": 5, "u_height": 2, "full_depth": True},
    ]}, headers=auth_headers)
    assert r.status_code == 409
    body = r.json()["error"]
    assert body["code"] == "U_OVERLAP"
    assert sorted(body["details"][0]["device_ids"]) == sorted([d1.id, d2.id])


def test_layout_full_depth_item_blocks_rear_device(client, auth_headers, db):
    rack = _make_rack(db)
    dev = _make_device(db, "10.51.1.1", rack_id=rack.id)
    item = _create_item(client, auth_headers, rack.id, rack_u_position=8, full_depth=True).json()

    r = client.patch(f"/api/v1/racks/{rack.id}/layout", json={"entries": [
        {"device_id": dev.id, "rack_u_position": 8, "u_height": 1, "rack_side": "rear"},
    ]}, headers=auth_headers)
    assert r.status_code == 409
    assert f"rack item {item['id']}" in r.json()["error"]["message"]


# ---------------------------------------------------------------------------
# Device meta PATCH / bulk-meta
# ---------------------------------------------------------------------------

def test_meta_patch_overlap_now_refused(client, auth_headers, db):
    rack = _make_rack(db)
    other = _make_device(db, "10.52.0.1", rack_id=rack.id, position=10, u_height=2)
    dev = _make_device(db, "10.52.0.2", rack_id=rack.id)

    r = _meta(client, auth_headers, dev.id, rack_u_position=11)
    assert r.status_code == 409
    body = r.json()["error"]
    assert body["code"] == "U_OVERLAP"
    assert f"device {other.id}" in body["message"]
    db.expire_all()
    assert db.get(Device, dev.id).rack_u_position is None

    # Same U on the rear side is fine and returned in the payload
    r = _meta(client, auth_headers, dev.id, rack_u_position=11, rack_side="rear")
    assert r.status_code == 200
    out = r.json()
    assert out["rack_u_position"] == 11 and out["rack_side"] == "rear" and out["full_depth"] is False

    # Turning it full depth conflicts with the front device
    r = _meta(client, auth_headers, dev.id, full_depth=True)
    assert r.status_code == 409

    # Growing beyond the rack height is refused as well
    small = _make_rack(db, label="Small", height_u=12)
    r = _meta(client, auth_headers, dev.id, rack_id=small.id, rack_u_position=12, u_height=2)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_POSITION_OUT_OF_RANGE"


def test_meta_patch_overlap_with_rack_item(client, auth_headers, db):
    rack = _make_rack(db)
    item = _create_item(client, auth_headers, rack.id, rack_u_position=3).json()
    dev = _make_device(db, "10.52.1.1", rack_id=rack.id)

    r = _meta(client, auth_headers, dev.id, rack_u_position=3)
    assert r.status_code == 409
    assert f"rack item {item['id']}" in r.json()["error"]["message"]
    assert r.json()["error"]["details"][0]["rack_item_ids"] == [item["id"]]

    # Unplacing (explicit null) and re-assigning without a position stay possible
    assert _meta(client, auth_headers, dev.id, rack_u_position=None).status_code == 200
    assert _meta(client, auth_headers, dev.id, rack_id=None).status_code == 200


def test_meta_patch_rack_change_keeps_position_validated(client, auth_headers, db):
    rack_a = _make_rack(db, label="A")
    rack_b = _make_rack(db, label="B")
    _make_device(db, "10.52.2.1", rack_id=rack_b.id, position=4)
    dev = _make_device(db, "10.52.2.2", rack_id=rack_a.id, position=4)

    r = _meta(client, auth_headers, dev.id, rack_id=rack_b.id)
    assert r.status_code == 409


def test_bulk_meta_side_and_depth(client, auth_headers, db):
    rack = _make_rack(db)
    front = _make_device(db, "10.53.0.1", rack_id=rack.id, position=1)
    rear = _make_device(db, "10.53.0.2", rack_id=rack.id, position=1, side="rear")
    loose = _make_device(db, "10.53.0.3")

    r = client.patch("/api/v1/topology/devices/bulk-meta",
                     json={"device_ids": [rear.id], "full_depth": True}, headers=auth_headers)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "U_OVERLAP"

    r = client.patch("/api/v1/topology/devices/bulk-meta",
                     json={"device_ids": [front.id, rear.id], "rack_side": "rear"}, headers=auth_headers)
    assert r.status_code == 409

    r = client.patch("/api/v1/topology/devices/bulk-meta",
                     json={"device_ids": [loose.id], "rack_side": "rear", "full_depth": True},
                     headers=auth_headers)
    assert r.status_code == 200
    db.expire_all()
    loose = db.get(Device, loose.id)
    assert loose.rack_side == "rear" and loose.full_depth is True


def test_migration_027_upgrade_and_downgrade():
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "027_ping_only_rack_sides.py"
    spec = importlib.util.spec_from_file_location("_mig027", path)
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "027" and mig.down_revision == "026"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE credentials (id INTEGER PRIMARY KEY, ip VARCHAR)"))
        conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY, ip VARCHAR)"))
        conn.execute(sa.text("CREATE TABLE rack_items (id INTEGER PRIMARY KEY, label VARCHAR)"))
        conn.execute(sa.text("INSERT INTO credentials (id, ip) VALUES (1, 'a')"))
        conn.execute(sa.text("INSERT INTO devices (id, ip) VALUES (1, 'a')"))
        conn.execute(sa.text("INSERT INTO rack_items (id, label) VALUES (1, 'pp')"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()

        assert conn.execute(sa.text("SELECT snmp_enabled FROM credentials")).scalar() in (1, True)
        row = conn.execute(sa.text("SELECT ping_only, rack_side, full_depth FROM devices")).one()
        assert (bool(row[0]), row[1], bool(row[2])) == (False, "front", False)
        row = conn.execute(sa.text("SELECT rack_side, full_depth FROM rack_items")).one()
        assert (row[0], bool(row[1])) == ("front", False)

        mig.downgrade()
        assert {c["name"] for c in sa.inspect(conn).get_columns("credentials")} == {"id", "ip"}
        assert {c["name"] for c in sa.inspect(conn).get_columns("devices")} == {"id", "ip"}
        assert {c["name"] for c in sa.inspect(conn).get_columns("rack_items")} == {"id", "label"}


def test_device_payload_defaults(client, auth_headers, db):
    _make_device(db, "10.54.0.1")
    node = client.get("/api/v1/topology", headers=auth_headers).json()["nodes"][0]
    assert node["rack_side"] == "front"
    assert node["full_depth"] is False
    assert node["ping_only"] is False
