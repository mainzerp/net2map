"""Tests for the switch models CRUD endpoints."""


def test_list_switch_models_empty(client, auth_headers):
    r = client.get("/api/switch-models", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_create_switch_model(client, auth_headers):
    payload = {"name": "Aruba CX 6300M-48", "ports_per_row": 24, "total_ports": 48}
    r = client.post("/api/switch-models", json=payload, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Aruba CX 6300M-48"
    assert data["ports_per_row"] == 24
    assert "id" in data


def test_get_switch_model_via_list(client, auth_headers):
    client.post("/api/switch-models", json={"name": "Model-A"}, headers=auth_headers)
    client.post("/api/switch-models", json={"name": "Model-B"}, headers=auth_headers)
    r = client.get("/api/switch-models", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_update_switch_model(client, auth_headers):
    r = client.post("/api/switch-models", json={"name": "Old"}, headers=auth_headers)
    sm_id = r.json()["id"]
    r = client.put(f"/api/switch-models/{sm_id}", json={"name": "New"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["name"] == "New"


def test_delete_switch_model(client, auth_headers):
    r = client.post("/api/switch-models", json={"name": "Del"}, headers=auth_headers)
    sm_id = r.json()["id"]
    r = client.delete(f"/api/switch-models/{sm_id}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get("/api/switch-models", headers=auth_headers)
    assert len(r.json()) == 0


def test_update_nonexistent_switch_model(client, auth_headers):
    r = client.put("/api/switch-models/999", json={"name": "Ghost"}, headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "SWITCH_MODEL_NOT_FOUND"


def test_delete_nonexistent_switch_model(client, auth_headers):
    r = client.delete("/api/switch-models/999", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "SWITCH_MODEL_NOT_FOUND"
