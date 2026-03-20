"""Tests for the switch classes CRUD endpoints."""


def test_list_switch_classes_empty(client, auth_headers):
    r = client.get("/api/switch-classes", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_create_switch_class(client, auth_headers):
    payload = {"label": "Top of Rack", "color": "#ff0000"}
    r = client.post("/api/switch-classes", json=payload, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["label"] == "Top of Rack"
    assert data["color"] == "#ff0000"
    assert "id" in data


def test_update_switch_class(client, auth_headers):
    r = client.post("/api/switch-classes", json={"label": "Old"}, headers=auth_headers)
    sc_id = r.json()["id"]
    r = client.put(f"/api/switch-classes/{sc_id}", json={"label": "New"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["label"] == "New"


def test_delete_switch_class(client, auth_headers):
    r = client.post("/api/switch-classes", json={"label": "Del"}, headers=auth_headers)
    sc_id = r.json()["id"]
    r = client.delete(f"/api/switch-classes/{sc_id}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get("/api/switch-classes", headers=auth_headers)
    assert len(r.json()) == 0


def test_update_nonexistent_switch_class(client, auth_headers):
    r = client.put("/api/switch-classes/999", json={"label": "Ghost"}, headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "SWITCH_CLASS_NOT_FOUND"


def test_delete_nonexistent_switch_class(client, auth_headers):
    r = client.delete("/api/switch-classes/999", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "SWITCH_CLASS_NOT_FOUND"
