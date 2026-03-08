"""Tests for the credentials CRUD endpoints."""


def test_create_credential(client, auth_headers):
    payload = {"label": "Switch-1", "ip": "10.0.0.1", "community": "public"}
    r = client.post("/api/credentials", json=payload, headers=auth_headers)
    assert r.status_code == 201
    data = r.json()
    assert data["label"] == "Switch-1"
    assert data["ip"] == "10.0.0.1"
    assert "id" in data


def test_duplicate_ip_rejected(client, auth_headers):
    payload = {"label": "Switch-1", "ip": "10.0.0.1"}
    client.post("/api/credentials", json=payload, headers=auth_headers)
    r = client.post("/api/credentials", json=payload, headers=auth_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "CREDENTIAL_IP_PRIORITY_EXISTS"


def test_list_credentials(client, auth_headers):
    client.post("/api/credentials", json={"label": "A", "ip": "10.0.0.1"}, headers=auth_headers)
    client.post("/api/credentials", json={"label": "B", "ip": "10.0.0.2"}, headers=auth_headers)
    r = client.get("/api/credentials", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_update_credential(client, auth_headers):
    r = client.post("/api/credentials", json={"label": "Old", "ip": "10.0.0.1"}, headers=auth_headers)
    cred_id = r.json()["id"]
    r = client.put(f"/api/credentials/{cred_id}", json={"label": "New"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["label"] == "New"


def test_delete_credential(client, auth_headers):
    r = client.post("/api/credentials", json={"label": "Del", "ip": "10.0.0.1"}, headers=auth_headers)
    cred_id = r.json()["id"]
    r = client.delete(f"/api/credentials/{cred_id}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get("/api/credentials", headers=auth_headers)
    assert len(r.json()) == 0


def test_update_nonexistent_credential(client, auth_headers):
    r = client.put("/api/credentials/999", json={"label": "Ghost"}, headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "CREDENTIAL_NOT_FOUND"


def test_delete_nonexistent_credential(client, auth_headers):
    r = client.delete("/api/credentials/999", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "CREDENTIAL_NOT_FOUND"
