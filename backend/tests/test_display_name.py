"""Device display name (migration 035) and credential label sync."""
import importlib.util
from pathlib import Path

import sqlalchemy as sa

from database import Credential, Device

BACKEND = Path(__file__).resolve().parents[1]
V1 = "/api/v1"


def test_meta_sets_trims_and_clears_display_name(client, db, auth_headers):
    dev = Device(ip="10.40.0.1", sys_name="sw1", label="Core")
    db.add(dev)
    db.commit()
    url = f"{V1}/topology/devices/{dev.id}/meta"

    r = client.patch(url, json={"display_name": "  Core RZ-01  "}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["display_name"] == "Core RZ-01"
    assert client.get(f"{V1}/devices", headers=auth_headers).json()[0]["display_name"] == "Core RZ-01"

    r = client.patch(url, json={"label": "x"}, headers=auth_headers)
    assert r.json()["display_name"] == "Core RZ-01"
    r = client.patch(url, json={"display_name": None}, headers=auth_headers)
    assert r.json()["display_name"] == ""
    r = client.patch(url, json={"display_name": "a" * 121}, headers=auth_headers)
    assert r.status_code == 422


def test_credential_label_change_updates_device_label(client, db, auth_headers):
    dev = Device(ip="10.40.0.2", sys_name="sw2", label="old")
    db.add(dev)
    db.commit()
    cred = Credential(ip="10.40.0.2", label="old", device_id=dev.id)
    other = Device(ip="10.40.0.3", sys_name="sw3", label="by-ip")
    db.add_all([cred, other])
    db.commit()
    cred_by_ip = Credential(ip="10.40.0.3", label="by-ip")
    db.add(cred_by_ip)
    db.commit()

    assert client.put(f"{V1}/credentials/{cred.id}", json={"label": "Renamed"}, headers=auth_headers).status_code == 200
    assert client.put(f"{V1}/credentials/{cred_by_ip.id}", json={"label": "Linked by IP"},
                      headers=auth_headers).status_code == 200
    # A change without a label leaves the device label alone.
    assert client.put(f"{V1}/credentials/{cred.id}", json={"priority": 0}, headers=auth_headers).status_code == 200
    db.expire_all()
    assert db.get(Device, dev.id).label == "Renamed"
    assert db.get(Device, other.id).label == "Linked by IP"


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "_mig035", BACKEND / "alembic" / "versions" / "035_device_display_name.py",
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    return mig


def test_migration_035_adds_column_and_resyncs_labels():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mig = _load_migration()
    assert mig.revision == "035" and mig.down_revision == "034"
    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY, ip VARCHAR, label VARCHAR NOT NULL DEFAULT '')"))
        conn.execute(sa.text(
            "CREATE TABLE credentials (id INTEGER PRIMARY KEY, ip VARCHAR, label VARCHAR, priority INTEGER, device_id INTEGER)"
        ))
        conn.execute(sa.text(
            "INSERT INTO devices (id, ip, label) VALUES (1, '10.0.0.1', 'stale'), (2, '10.0.0.2', 'keep'), (3, '10.0.0.3', '')"
        ))
        conn.execute(sa.text(
            "INSERT INTO credentials (id, ip, label, priority, device_id) VALUES "
            "(1, '10.0.0.1', 'fallback', 1, 1), (2, '10.0.0.1', 'primary', 0, 1), "
            "(3, '10.0.0.2', '', 0, 2), (4, '10.0.0.3', 'new', 0, 3)"
        ))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        rows = conn.execute(sa.text("SELECT id, label, display_name FROM devices ORDER BY id")).fetchall()
        assert [tuple(r) for r in rows] == [(1, "primary", ""), (2, "keep", ""), (3, "new", "")]

        mig.downgrade()
        assert "display_name" not in {c["name"] for c in sa.inspect(conn).get_columns("devices")}
