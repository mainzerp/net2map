"""Tests for the racks CRUD endpoints."""


def test_list_racks_empty(client, auth_headers):
    r = client.get("/api/racks", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_create_rack(client, auth_headers):
    payload = {"label": "Rack A", "room": "RZ-01", "description": "Main rack"}
    r = client.post("/api/racks", json=payload, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["label"] == "Rack A"
    assert data["room"] == "RZ-01"
    assert "id" in data


def test_list_racks(client, auth_headers):
    client.post("/api/racks", json={"label": "Rack A"}, headers=auth_headers)
    client.post("/api/racks", json={"label": "Rack B"}, headers=auth_headers)
    r = client.get("/api/racks", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_update_rack(client, auth_headers):
    r = client.post("/api/racks", json={"label": "Old"}, headers=auth_headers)
    rack_id = r.json()["id"]
    r = client.put(f"/api/racks/{rack_id}", json={"label": "New"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["label"] == "New"


def test_delete_rack(client, auth_headers):
    r = client.post("/api/racks", json={"label": "Del"}, headers=auth_headers)
    rack_id = r.json()["id"]
    r = client.delete(f"/api/racks/{rack_id}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get("/api/racks", headers=auth_headers)
    assert len(r.json()) == 0


def test_update_nonexistent_rack(client, auth_headers):
    r = client.put("/api/racks/999", json={"label": "Ghost"}, headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "RACK_NOT_FOUND"


def test_delete_nonexistent_rack(client, auth_headers):
    r = client.delete("/api/racks/999", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "RACK_NOT_FOUND"


# ---------------------------------------------------------------------------
# exclude_unset update semantics
# ---------------------------------------------------------------------------

def test_update_rack_partial_keeps_other_fields(client, auth_headers, db):
    """Fields not sent in a PUT keep their current values."""
    from database import Rack as RackModel
    r = client.post("/api/racks", json={"label": "KeepRack", "room": "RZ-9", "description": "keep"}, headers=auth_headers)
    rack_id = r.json()["id"]

    r = client.put(f"/api/racks/{rack_id}", json={"room": "RZ-10"}, headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["room"] == "RZ-10"
    assert data["label"] == "KeepRack"
    assert data["description"] == "keep"

    db.expire_all()
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    assert rack.description == "keep"



def test_partial_layout_rejects_collision_with_unchanged_device(client, auth_headers, db):
    from database import Device, Rack

    rack = Rack(label="Rack", height_u=42)
    db.add(rack)
    db.flush()
    first = Device(ip="10.0.0.1", rack_id=rack.id, rack_u_position=1, u_height=2)
    second = Device(ip="10.0.0.2", rack_id=rack.id, rack_u_position=5, u_height=2)
    db.add_all([first, second])
    db.commit()
    response = client.patch(f"/api/racks/{rack.id}/layout", headers=auth_headers, json={
        "entries": [{"device_id": second.id, "rack_u_position": 2, "u_height": 2}],
    })
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "U_OVERLAP"
    db.refresh(second)
    assert second.rack_u_position == 5


def test_rack_shrink_rejects_truncating_device(client, auth_headers, db):
    from database import Device, Rack

    rack = Rack(label="Rack", height_u=42)
    db.add(rack)
    db.flush()
    db.add(Device(ip="10.0.0.1", rack_id=rack.id, rack_u_position=20, u_height=2))
    db.commit()
    response = client.put(f"/api/racks/{rack.id}", headers=auth_headers, json={"height_u": 20})
    assert response.status_code == 409
    db.refresh(rack)
    assert rack.height_u == 42


def test_delete_rack_clears_device_u_position(client, auth_headers, db):
    """Deleting a rack unracks its devices without leaving a stale U slot."""
    from database import Building, Device, Floor, Rack

    building = Building(label="B1")
    db.add(building)
    db.flush()
    floor = Floor(building_id=building.id, label="F1")
    db.add(floor)
    db.flush()
    rack = Rack(label="DelPos", height_u=42, floor_id=floor.id)
    db.add(rack)
    db.flush()
    dev = Device(ip="10.0.0.9", rack_id=rack.id, rack_u_position=12, u_height=2, rack_side="rear")
    db.add(dev)
    db.commit()

    r = client.delete(f"/api/racks/{rack.id}", headers=auth_headers)
    assert r.status_code == 204

    db.refresh(dev)
    assert dev.rack_id is None
    assert dev.rack_u_position is None
    assert dev.floor_id == floor.id
    # Side and depth are kept, as when unracking via the meta PATCH
    assert dev.rack_side == "rear"
