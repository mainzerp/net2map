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
