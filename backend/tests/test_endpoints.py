"""Tests for the endpoints router (/api/endpoints)."""
from database import Device, Endpoint, EndpointPortAssociation, Port


def test_list_endpoints_empty(client, auth_headers, db):
    """GET /api/endpoints returns empty list when no endpoints exist."""
    r = client.get("/api/endpoints", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_list_endpoints_returns_data(client, auth_headers, db):
    """GET /api/endpoints returns existing endpoints."""
    ep = Endpoint(mac="aa:bb:cc:dd:ee:01", ip="10.0.0.100", hostname="pc1")
    db.add(ep)
    db.commit()

    r = client.get("/api/endpoints", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["mac"] == "aa:bb:cc:dd:ee:01"
    assert data[0]["ip"] == "10.0.0.100"
    assert data[0]["hostname"] == "pc1"


def test_get_single_endpoint(client, auth_headers, db):
    """GET /api/endpoints/{id} returns a single endpoint with found_on."""
    dev = Device(sys_name="sw1", ip="10.0.0.1", vendor="generic")
    db.add(dev)
    db.flush()

    port = Port(device_id=dev.id, if_index=1, if_descr="eth0", oper_status=1)
    db.add(port)
    db.flush()

    ep = Endpoint(mac="aa:bb:cc:dd:ee:02", ip="10.0.0.101")
    db.add(ep)
    db.flush()

    assoc = EndpointPortAssociation(endpoint_id=ep.id, port_id=port.id, vlan_id=100)
    db.add(assoc)
    db.commit()

    r = client.get(f"/api/endpoints/{ep.id}", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["mac"] == "aa:bb:cc:dd:ee:02"
    assert len(data["found_on"]) == 1
    assert data["found_on"][0]["vlan_id"] == 100
    assert data["found_on"][0]["switch_ip"] == "10.0.0.1"


def test_get_endpoint_not_found(client, auth_headers, db):
    """GET /api/endpoints/999 returns 404."""
    r = client.get("/api/endpoints/999", headers=auth_headers)
    assert r.status_code == 404


def test_update_endpoint_ignored(client, jwt_headers, db):
    """PATCH /api/endpoints/{id} toggles ignored flag."""
    ep = Endpoint(mac="aa:bb:cc:dd:ee:03", ignored=False)
    db.add(ep)
    db.commit()

    r = client.patch(
        f"/api/endpoints/{ep.id}",
        json={"ignored": True},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    assert r.json()["ignored"] is True

    db.refresh(ep)
    assert ep.ignored is True


def test_update_endpoint_notes(client, jwt_headers, db):
    """PATCH /api/endpoints/{id} updates notes."""
    ep = Endpoint(mac="aa:bb:cc:dd:ee:04")
    db.add(ep)
    db.commit()

    r = client.patch(
        f"/api/endpoints/{ep.id}",
        json={"notes": "Test note"},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    assert r.json()["notes"] == "Test note"


def test_bulk_update_endpoints(client, jwt_headers, db):
    """PATCH /api/endpoints/bulk sets ignored on multiple endpoints."""
    ep1 = Endpoint(mac="aa:bb:cc:dd:ee:05", ignored=False)
    ep2 = Endpoint(mac="aa:bb:cc:dd:ee:06", ignored=False)
    db.add_all([ep1, ep2])
    db.commit()

    r = client.patch(
        "/api/endpoints/bulk",
        json={"endpoint_ids": [ep1.id, ep2.id], "ignored": True},
        headers=jwt_headers,
    )
    assert r.status_code == 200
    assert r.json()["updated"] == 2

    db.refresh(ep1)
    db.refresh(ep2)
    assert ep1.ignored is True
    assert ep2.ignored is True


def test_delete_endpoint(client, jwt_headers, db):
    """DELETE /api/endpoints/{id} removes endpoint and associations."""
    dev = Device(sys_name="sw1", ip="10.0.0.1", vendor="generic")
    db.add(dev)
    db.flush()

    port = Port(device_id=dev.id, if_index=1, if_descr="eth0", oper_status=1)
    db.add(port)
    db.flush()

    ep = Endpoint(mac="aa:bb:cc:dd:ee:07")
    db.add(ep)
    db.flush()

    assoc = EndpointPortAssociation(endpoint_id=ep.id, port_id=port.id)
    db.add(assoc)
    db.commit()

    r = client.delete(f"/api/endpoints/{ep.id}", headers=jwt_headers)
    assert r.status_code == 200

    assert db.query(Endpoint).filter_by(id=ep.id).first() is None
    assert db.query(EndpointPortAssociation).filter_by(endpoint_id=ep.id).first() is None
