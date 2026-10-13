"""Buildings and floors: CRUD, roles, floor assignments, per-floor backgrounds,
legacy map-background mapping and migration 026."""
import importlib.util
import io
import os
from pathlib import Path

import pytest
import sqlalchemy as sa

from database import Device, Floor, Rack, User
from shared.auth import create_token, hash_password
from tests.test_map_bg import _png_bytes

BACKEND = Path(__file__).resolve().parents[1]
V1 = "/api/v1"


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    import routers.floors as _floors
    import routers.map_bg as _mbg
    from main import app
    for limiter in (app.state.limiter, _floors.limiter, _mbg.limiter):
        limiter.reset()
    yield
    for limiter in (app.state.limiter, _floors.limiter, _mbg.limiter):
        limiter.reset()


@pytest.fixture
def bg_dir(tmp_path, monkeypatch):
    monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
    return tmp_path


def _user_headers(db, username, role):
    user = User(username=username, email="", hashed_pw=hash_password("Password123"), role=role, is_active=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"Authorization": f"Bearer {create_token(user.id, user.username, user.role)}"}


@pytest.fixture
def operator_headers(db):
    return _user_headers(db, "testoperator", "operator")


def _building(client, headers, label="HQ", **extra):
    r = client.post(f"{V1}/buildings", json={"label": label, **extra}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def _floor(client, headers, building_id, label="F1", **extra):
    r = client.post(f"{V1}/buildings/{building_id}/floors", json={"label": label, **extra}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def _upload(client, headers, floor_id, name="bg.png", data=None):
    return client.post(
        f"{V1}/floors/{floor_id}/background",
        headers=headers,
        files={"file": (name, io.BytesIO(data if data is not None else _png_bytes()), "image/png")},
    )


# ---------------------------------------------------------------------------
# CRUD and ordering
# ---------------------------------------------------------------------------

def test_building_and_floor_crud(client, auth_headers):
    assert client.get(f"{V1}/buildings", headers=auth_headers).json() == []
    b = _building(client, auth_headers, "HQ", description="Main site", sort_order=2)
    assert b["label"] == "HQ" and b["description"] == "Main site" and b["sort_order"] == 2 and b["floors"] == []

    f = _floor(client, auth_headers, b["id"], "Ground", sort_order=0)
    assert f == {
        "id": f["id"], "building_id": b["id"], "label": "Ground", "sort_order": 0, "has_background": False,
        "bg_version": 0, "bg_opacity": 0.3, "bg_scale": 1.0, "bg_color": "#020817",
    }

    r = client.patch(f"{V1}/buildings/{b['id']}", json={"label": "HQ2", "description": None}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["label"] == "HQ2" and r.json()["description"] is None
    assert r.json()["floors"][0]["id"] == f["id"]

    r = client.patch(
        f"{V1}/floors/{f['id']}",
        json={"label": "G", "bg_opacity": 0.7, "bg_scale": 2.5, "bg_color": "#ffffff"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["label"] == "G" and r.json()["bg_opacity"] == 0.7
    assert r.json()["bg_scale"] == 2.5 and r.json()["bg_color"] == "#ffffff"

    other = _building(client, auth_headers, "Annex")
    r = client.patch(f"{V1}/floors/{f['id']}", json={"building_id": other["id"]}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["building_id"] == other["id"]

    assert client.delete(f"{V1}/floors/{f['id']}", headers=auth_headers).status_code == 204
    assert client.delete(f"{V1}/buildings/{b['id']}", headers=auth_headers).status_code == 204
    assert [x["label"] for x in client.get(f"{V1}/buildings", headers=auth_headers).json()] == ["Annex"]


def test_validation_and_not_found(client, auth_headers):
    assert client.post(f"{V1}/buildings", json={"label": "x" * 121}, headers=auth_headers).status_code == 422
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    for body in ({"bg_opacity": 1.5}, {"bg_scale": 0.01}, {"bg_scale": 11}, {"bg_color": "x" * 21}):
        assert client.patch(f"{V1}/floors/{f['id']}", json=body, headers=auth_headers).status_code == 422
    r = client.patch(f"{V1}/floors/{f['id']}", json={"building_id": 999}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "BUILDING_NOT_FOUND"
    r = client.post(f"{V1}/buildings/999/floors", json={"label": "F"}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "BUILDING_NOT_FOUND"
    r = client.patch(f"{V1}/floors/999", json={"label": "F"}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "FLOOR_NOT_FOUND"
    assert client.delete(f"{V1}/buildings/999", headers=auth_headers).status_code == 404


def test_ordering_by_sort_order_then_id(client, auth_headers):
    b2 = _building(client, auth_headers, "B2", sort_order=1)
    b1 = _building(client, auth_headers, "B1", sort_order=0)
    b3 = _building(client, auth_headers, "B3", sort_order=1)
    _floor(client, auth_headers, b1["id"], "Upper", sort_order=5)
    _floor(client, auth_headers, b1["id"], "Lower", sort_order=1)
    _floor(client, auth_headers, b1["id"], "Lower2", sort_order=1)
    data = client.get(f"{V1}/buildings", headers=auth_headers).json()
    assert [b["id"] for b in data] == [b1["id"], b2["id"], b3["id"]]
    assert [f["label"] for f in data[0]["floors"]] == ["Lower", "Lower2", "Upper"]


def test_roles(client, db, auth_headers, viewer_jwt_headers, operator_headers):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    assert client.get(f"{V1}/buildings", headers=viewer_jwt_headers).status_code == 200

    viewer_writes = [
        ("post", f"{V1}/buildings", {"label": "X"}),
        ("patch", f"{V1}/buildings/{b['id']}", {"label": "X"}),
        ("delete", f"{V1}/buildings/{b['id']}", None),
        ("post", f"{V1}/buildings/{b['id']}/floors", {"label": "X"}),
        ("patch", f"{V1}/floors/{f['id']}", {"label": "X"}),
        ("delete", f"{V1}/floors/{f['id']}", None),
        ("delete", f"{V1}/floors/{f['id']}/background", None),
    ]
    for method, url, body in viewer_writes:
        kwargs = {"headers": viewer_jwt_headers}
        if body is not None:
            kwargs["json"] = body
        assert getattr(client, method)(url, **kwargs).status_code == 403, (method, url)
    assert _upload(client, viewer_jwt_headers, f["id"]).status_code == 403

    # Operators may create and update, deletes of buildings/floors are admin-only
    ob = _building(client, operator_headers, "Op")
    of = _floor(client, operator_headers, ob["id"])
    assert client.patch(f"{V1}/floors/{of['id']}", json={"label": "Y"}, headers=operator_headers).status_code == 200
    assert client.delete(f"{V1}/floors/{of['id']}", headers=operator_headers).status_code == 403
    assert client.delete(f"{V1}/buildings/{ob['id']}", headers=operator_headers).status_code == 403


def test_reads_require_auth(client):
    assert client.get(f"{V1}/buildings").status_code == 401


# ---------------------------------------------------------------------------
# Deletes detach racks/devices and cascade
# ---------------------------------------------------------------------------

def test_floor_delete_nulls_rack_and_device_floor(client, db, auth_headers, bg_dir):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    rack = client.post(f"{V1}/racks", json={"label": "R1", "floor_id": f["id"]}, headers=auth_headers).json()
    assert rack["floor_id"] == f["id"]
    db.add(Device(ip="10.0.0.1", sys_name="sw1", floor_id=f["id"]))
    db.commit()
    assert _upload(client, auth_headers, f["id"]).status_code == 200
    assert os.path.isfile(bg_dir / f"floor-{f['id']}-background.png")

    assert client.delete(f"{V1}/floors/{f['id']}", headers=auth_headers).status_code == 204
    db.expire_all()
    assert db.get(Rack, rack["id"]).floor_id is None
    assert db.query(Device).filter(Device.ip == "10.0.0.1").one().floor_id is None
    assert not os.path.exists(bg_dir / f"floor-{f['id']}-background.png")


def test_building_delete_cascades_floors(client, db, auth_headers, bg_dir):
    b = _building(client, auth_headers)
    f1 = _floor(client, auth_headers, b["id"], "F1")
    f2 = _floor(client, auth_headers, b["id"], "F2")
    keep_b = _building(client, auth_headers, "Keep")
    keep_f = _floor(client, auth_headers, keep_b["id"])
    rack = client.post(f"{V1}/racks", json={"label": "R", "floor_id": f2["id"]}, headers=auth_headers).json()
    db.add(Device(ip="10.0.0.2", sys_name="sw2", floor_id=f1["id"]))
    db.commit()
    assert _upload(client, auth_headers, f1["id"]).status_code == 200

    assert client.delete(f"{V1}/buildings/{b['id']}", headers=auth_headers).status_code == 204
    db.expire_all()
    assert {fl.id for fl in db.query(Floor).all()} == {keep_f["id"]}
    assert db.get(Rack, rack["id"]).floor_id is None
    assert db.query(Device).filter(Device.ip == "10.0.0.2").one().floor_id is None
    assert not os.path.exists(bg_dir / f"floor-{f1['id']}-background.png")


# ---------------------------------------------------------------------------
# Per-floor background
# ---------------------------------------------------------------------------

def test_floor_background_upload_get_delete(client, auth_headers, bg_dir):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    other = _floor(client, auth_headers, b["id"], "F2")

    r = client.get(f"{V1}/floors/{f['id']}/background")
    assert r.status_code == 404 and r.json()["error"]["code"] == "NO_BACKGROUND_IMAGE"

    r = _upload(client, auth_headers, f["id"])
    assert r.status_code == 200
    assert r.json()["has_background"] is True and r.json()["bg_version"] == 1

    # Public GET on both prefixes, with the same hardening headers as /map-background
    for prefix in ("/api/v1", "/api"):
        g = client.get(f"{prefix}/floors/{f['id']}/background")
        assert g.status_code == 200
        assert g.content == _png_bytes()
        assert g.headers.get("content-security-policy") == "script-src 'none'"
        assert g.headers.get("content-disposition", "").startswith("inline")
    assert client.get(f"{V1}/floors/{other['id']}/background").status_code == 404

    # Replacing with another format removes the previous file
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>x</script><rect width="1" height="1"/></svg>'
    r = _upload(client, auth_headers, f["id"], name="bg.svg", data=svg)
    assert r.status_code == 200 and r.json()["bg_version"] == 2
    assert not os.path.exists(bg_dir / f"floor-{f['id']}-background.png")
    content = (bg_dir / f"floor-{f['id']}-background.svg").read_text().lower()
    assert "<script" not in content and "<rect" in content

    r = client.delete(f"{V1}/floors/{f['id']}/background", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["has_background"] is False and r.json()["bg_version"] == 3
    assert not os.path.exists(bg_dir / f"floor-{f['id']}-background.svg")
    assert client.get(f"{V1}/floors/{f['id']}/background").status_code == 404


def test_floor_background_validation_and_range(client, auth_headers, bg_dir, monkeypatch):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    r = _upload(client, auth_headers, f["id"], name="bg.bmp", data=b"\x00" * 10)
    assert r.status_code == 400 and "UNSUPPORTED_FILE_TYPE" in r.text
    r = _upload(client, auth_headers, f["id"], data=b"not-an-image")
    assert r.status_code == 400 and "UNSUPPORTED_IMAGE_TYPE" in r.text
    monkeypatch.setattr("shared.file_settings.MAX_FILE_SIZE", 10)
    r = _upload(client, auth_headers, f["id"])
    assert r.status_code == 400 and "FILE_TOO_LARGE" in r.text
    assert _upload(client, auth_headers, 999).status_code == 404

    r = client.get(f"{V1}/floors/{f['id']}/background", headers={"Range": "bytes=0-1,3-4"})
    assert r.status_code == 416 and r.json()["error"]["code"] == "INVALID_RANGE"


def test_floor_background_auth_exemption_is_get_only(client, auth_headers, bg_dir):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    r = client.delete(f"{V1}/floors/{f['id']}/background")
    assert r.status_code == 401 and r.json()["error"]["code"] == "AUTH_MISSING"
    r = client.post(f"{V1}/floors/{f['id']}/background", files={"file": ("bg.png", io.BytesIO(_png_bytes()))})
    assert r.status_code == 401
    from shared.auth import _is_auth_exempt
    assert _is_auth_exempt("/api/v1/floors/3/background", "GET")
    assert _is_auth_exempt("/api/floors/3/background", "GET")
    assert not _is_auth_exempt("/api/v1/floors/3/background", "POST")
    assert not _is_auth_exempt("/api/v1/floors/3/background", "DELETE")
    assert not _is_auth_exempt("/api/v1/floors/3/background/extra", "GET")
    assert not _is_auth_exempt("/api/v1/floors/x/background", "GET")
    assert not _is_auth_exempt("/api/v1/floors/3", "GET")
    assert not _is_auth_exempt("/floors/3/background", "GET")


def test_floor_background_upload_rate_limited(client, auth_headers, bg_dir):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    codes = [_upload(client, auth_headers, f["id"]).status_code for _ in range(6)]
    assert codes[:5] == [200] * 5 and codes[5] == 429


# ---------------------------------------------------------------------------
# Rack and device floor assignment
# ---------------------------------------------------------------------------

def test_rack_floor_id_validation(client, auth_headers):
    r = client.post(f"{V1}/racks", json={"label": "R", "floor_id": 999}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "FLOOR_NOT_FOUND"
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    rack = client.post(f"{V1}/racks", json={"label": "R"}, headers=auth_headers).json()
    assert rack["floor_id"] is None
    r = client.put(f"{V1}/racks/{rack['id']}", json={"floor_id": 999}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "FLOOR_NOT_FOUND"
    r = client.put(f"{V1}/racks/{rack['id']}", json={"floor_id": f["id"]}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["floor_id"] == f["id"]
    r = client.put(f"{V1}/racks/{rack['id']}", json={"label": "R2"}, headers=auth_headers)
    assert r.json()["floor_id"] == f["id"]
    r = client.put(f"{V1}/racks/{rack['id']}", json={"floor_id": None}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["floor_id"] is None


def test_device_meta_floor_id_set_and_clear(client, db, auth_headers):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    rack = client.post(f"{V1}/racks", json={"label": "R"}, headers=auth_headers).json()
    dev = Device(ip="10.0.0.3", sys_name="sw3")
    db.add(dev)
    db.commit()
    url = f"{V1}/topology/devices/{dev.id}/meta"

    r = client.patch(url, json={"floor_id": 999}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "FLOOR_NOT_FOUND"
    r = client.patch(url, json={"floor_id": f["id"]}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["floor_id"] == f["id"]
    # Rack changes keep floor_id untouched
    r = client.patch(url, json={"rack_id": rack["id"]}, headers=auth_headers)
    assert r.json()["floor_id"] == f["id"]
    r = client.patch(url, json={"rack_id": None}, headers=auth_headers)
    assert r.json()["floor_id"] == f["id"]
    r = client.patch(url, json={"label": "x"}, headers=auth_headers)
    assert r.json()["floor_id"] == f["id"]
    r = client.patch(url, json={"floor_id": None}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["floor_id"] is None


def test_bulk_meta_floor_id_and_clear_floor(client, db, auth_headers):
    b = _building(client, auth_headers)
    f = _floor(client, auth_headers, b["id"])
    devs = [Device(ip=f"10.0.1.{i}", sys_name=f"s{i}") for i in range(3)]
    db.add_all(devs)
    db.commit()
    ids = [d.id for d in devs]
    url = f"{V1}/topology/devices/bulk-meta"

    r = client.patch(url, json={"device_ids": ids, "floor_id": 999}, headers=auth_headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "FLOOR_NOT_FOUND"
    r = client.patch(url, json={"device_ids": ids[:2], "floor_id": f["id"]}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["updated"] == 2
    db.expire_all()
    assert [db.get(Device, i).floor_id for i in ids] == [f["id"], f["id"], None]

    r = client.patch(url, json={"device_ids": ids, "floor_id": f["id"], "clear_floor": True}, headers=auth_headers)
    assert r.status_code == 200
    db.expire_all()
    assert [db.get(Device, i).floor_id for i in ids] == [None, None, None]


# ---------------------------------------------------------------------------
# Topology payload
# ---------------------------------------------------------------------------

def test_topology_contains_buildings_with_floors(client, db, auth_headers, bg_dir):
    b2 = _building(client, auth_headers, "B2", sort_order=1)
    b1 = _building(client, auth_headers, "B1", sort_order=0)
    f = _floor(client, auth_headers, b1["id"], "Upper", sort_order=2)
    _floor(client, auth_headers, b1["id"], "Lower", sort_order=1)
    db.add(Device(ip="10.0.2.1", sys_name="s", floor_id=f["id"]))
    db.commit()

    data = client.get(f"{V1}/topology", headers=auth_headers).json()
    assert [b["id"] for b in data["buildings"]] == [b1["id"], b2["id"]]
    assert [fl["label"] for fl in data["buildings"][0]["floors"]] == ["Lower", "Upper"]
    assert data["buildings"][1]["floors"] == []
    assert data["nodes"][0]["floor_id"] == f["id"]

    # Background uploads bump the topology version so the payload refreshes
    assert _upload(client, auth_headers, f["id"]).status_code == 200
    data = client.get(f"{V1}/topology", headers=auth_headers).json()
    upper = next(fl for fl in data["buildings"][0]["floors"] if fl["id"] == f["id"])
    assert upper["has_background"] is True and upper["bg_version"] == 1


# ---------------------------------------------------------------------------
# Legacy /map-background and /map-settings
# ---------------------------------------------------------------------------

def test_legacy_endpoints_without_floor(client, auth_headers, bg_dir):
    assert client.get("/api/map-background").status_code == 404
    assert client.get("/api/map-settings", headers=auth_headers).json() == {
        "opacity": 0.3, "scale": 1.0, "bg_color": "#020817",
    }
    assert client.get(f"{V1}/buildings", headers=auth_headers).json() == []
    # A failed upload does not create the default floor
    r = client.post("/api/map-background", headers=auth_headers,
                    files={"file": ("bg.png", io.BytesIO(b"nope"), "image/png")})
    assert r.status_code == 400
    assert client.get(f"{V1}/buildings", headers=auth_headers).json() == []


def test_legacy_upload_auto_creates_default_floor(client, auth_headers, bg_dir):
    r = client.post("/api/map-background", headers=auth_headers,
                    files={"file": ("bg.png", io.BytesIO(_png_bytes()), "image/png")})
    assert r.status_code == 200
    buildings = client.get(f"{V1}/buildings", headers=auth_headers).json()
    assert [b["label"] for b in buildings] == ["Main building"]
    floor = buildings[0]["floors"][0]
    assert floor["label"] == "Ground floor" and floor["has_background"] is True and floor["bg_version"] == 1
    assert client.get("/api/map-background").content == _png_bytes()
    assert client.get(f"{V1}/floors/{floor['id']}/background").content == _png_bytes()

    assert client.delete("/api/map-background", headers=auth_headers).status_code == 200
    floor = client.get(f"{V1}/buildings", headers=auth_headers).json()[0]["floors"][0]
    assert floor["has_background"] is False and floor["bg_version"] == 2


def test_legacy_map_settings_auto_create_and_map_to_default_floor(client, auth_headers):
    r = client.put("/api/map-settings", json={"opacity": 0.6, "bg_color": "#123456"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"opacity": 0.6, "scale": 1.0, "bg_color": "#123456"}
    floor = client.get(f"{V1}/buildings", headers=auth_headers).json()[0]["floors"][0]
    assert floor["bg_opacity"] == 0.6 and floor["bg_color"] == "#123456"
    client.patch(f"{V1}/floors/{floor['id']}", json={"bg_scale": 3.0}, headers=auth_headers)
    assert client.get("/api/map-settings", headers=auth_headers).json()["scale"] == 3.0


def test_legacy_endpoints_use_first_floor_by_order(client, auth_headers, bg_dir):
    late = _building(client, auth_headers, "Late", sort_order=5)
    _floor(client, auth_headers, late["id"], "L0", sort_order=0)
    early = _building(client, auth_headers, "Early", sort_order=1)
    _floor(client, auth_headers, early["id"], "E2", sort_order=2)
    target = _floor(client, auth_headers, early["id"], "E1", sort_order=1)

    client.put("/api/map-settings", json={"scale": 4.0}, headers=auth_headers)
    r = client.post("/api/map-background", headers=auth_headers,
                    files={"file": ("bg.png", io.BytesIO(_png_bytes()), "image/png")})
    assert r.status_code == 200
    assert os.path.isfile(bg_dir / f"floor-{target['id']}-background.png")
    floors = {fl["id"]: fl for b in client.get(f"{V1}/buildings", headers=auth_headers).json() for fl in b["floors"]}
    assert floors[target["id"]]["bg_scale"] == 4.0
    assert [fid for fid, fl in floors.items() if fl["has_background"]] == [target["id"]]
    assert len(client.get(f"{V1}/buildings", headers=auth_headers).json()) == 2


# ---------------------------------------------------------------------------
# Migration 026
# ---------------------------------------------------------------------------

def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "_mig026", BACKEND / "alembic" / "versions" / "026_buildings_floors.py"
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    return mig


def _legacy_schema(conn):
    conn.execute(sa.text("CREATE TABLE racks (id INTEGER PRIMARY KEY, label VARCHAR NOT NULL)"))
    conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY, ip VARCHAR, rack_id INTEGER)"))
    conn.execute(sa.text("CREATE TABLE app_settings (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)"))


def test_migration_026_upgrade_with_data_and_legacy_file(tmp_path, monkeypatch):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mig = _load_migration()
    assert mig.revision == "026" and mig.down_revision == "025"
    monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path))
    (tmp_path / "map-background.svg").write_bytes(b"<svg/>")

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        _legacy_schema(conn)
        conn.execute(sa.text("INSERT INTO racks (id, label) VALUES (1, 'R1'), (2, 'R2')"))
        conn.execute(sa.text("INSERT INTO devices (id, ip, rack_id) VALUES (1, 'a', 1), (2, 'b', NULL)"))
        conn.execute(sa.text(
            "INSERT INTO app_settings (key, value) VALUES"
            " ('map_opacity', '0.55'), ('map_scale', '2.0'), ('map_bg_color', '#abcdef'), ('other', 'x')"
        ))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()

        buildings = conn.execute(sa.text("SELECT id, label, sort_order FROM buildings")).fetchall()
        assert [(b[1], b[2]) for b in buildings] == [("Main building", 0)]
        floor = conn.execute(sa.text(
            "SELECT id, building_id, label, sort_order, bg_ext, bg_version, bg_opacity, bg_scale, bg_color FROM floors"
        )).mappings().one()
        assert floor["building_id"] == buildings[0][0] and floor["label"] == "Ground floor"
        assert (floor["bg_ext"], floor["bg_version"]) == (".svg", 1)
        assert (floor["bg_opacity"], floor["bg_scale"], floor["bg_color"]) == (0.55, 2.0, "#abcdef")
        fid = floor["id"]
        assert conn.execute(sa.text("SELECT floor_id FROM racks ORDER BY id")).scalars().all() == [fid, fid]
        assert conn.execute(sa.text("SELECT floor_id FROM devices ORDER BY id")).scalars().all() == [None, fid]
        assert not (tmp_path / "map-background.svg").exists()
        assert (tmp_path / f"floor-{fid}-background.svg").read_bytes() == b"<svg/>"

        mig.downgrade()
        tables = set(sa.inspect(conn).get_table_names())
        assert "buildings" not in tables and "floors" not in tables
        assert {c["name"] for c in sa.inspect(conn).get_columns("racks")} == {"id", "label"}
        assert {c["name"] for c in sa.inspect(conn).get_columns("devices")} == {"id", "ip", "rack_id"}
        assert conn.execute(sa.text("SELECT COUNT(*) FROM devices")).scalar() == 2


def test_migration_026_empty_install_creates_no_building(tmp_path, monkeypatch):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mig = _load_migration()
    monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path / "missing"))
    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        _legacy_schema(conn)
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        assert conn.execute(sa.text("SELECT COUNT(*) FROM buildings")).scalar() == 0
        assert conn.execute(sa.text("SELECT COUNT(*) FROM floors")).scalar() == 0


def test_migration_026_missing_data_dir_does_not_fail(tmp_path, monkeypatch):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mig = _load_migration()
    monkeypatch.setattr("shared.file_settings.MAP_BG_DIR", str(tmp_path / "missing"))
    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        _legacy_schema(conn)
        conn.execute(sa.text("INSERT INTO devices (id, ip) VALUES (1, 'a')"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        row = conn.execute(sa.text("SELECT bg_ext, bg_version, bg_opacity FROM floors")).one()
        assert tuple(row) == (None, 0, 0.3)
        assert conn.execute(sa.text("SELECT floor_id FROM devices")).scalar() is not None
