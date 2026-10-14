"""Ping candidates and ping-only adoption (POST /credentials/ping-only).

The finalize tests run the real executor module (see the executor_mod fixture
in test_executor_finalize).
"""
import threading
from datetime import datetime, timedelta

import pytest

from database import AuditLog, Credential, Device, Endpoint, PingCandidate
from tests.test_executor_finalize import _finalize_kwargs, executor_mod  # noqa: F401


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    import routers.credentials as _c
    _c.limiter.reset()
    yield
    _c.limiter.reset()


# ---------------------------------------------------------------------------
# POST /credentials/ping-only
# ---------------------------------------------------------------------------

def test_adopt_creates_credential_and_device(client, auth_headers, db):
    db.add(PingCandidate(ip="10.50.0.1", rtt_ms=4))
    db.commit()

    r = client.post("/api/v1/credentials/ping-only",
                    json={"entries": [{"ip": "10.50.0.1", "label": "Printer"}, {"ip": "10.50.0.2"}]},
                    headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skipped"] == []
    assert [c["ip"] for c in body["created"]] == ["10.50.0.1", "10.50.0.2"]

    db.expire_all()
    for item in body["created"]:
        cred = db.query(Credential).filter(Credential.id == item["credential_id"]).one()
        dev = db.query(Device).filter(Device.id == item["device_id"]).one()
        assert cred.ip == dev.ip == item["ip"]
        assert cred.snmp_enabled is False
        assert cred.enabled is True
        assert cred.device_id == dev.id
        assert dev.ping_only is True
        assert dev.ping_status == "unknown"
        assert dev.device_type == "other"
    printer = db.query(Device).filter(Device.ip == "10.50.0.1").one()
    assert printer.sys_name == "Printer"
    assert db.query(Credential).filter(Credential.ip == "10.50.0.2").one().label == ""
    assert db.query(Device).filter(Device.ip == "10.50.0.2").one().sys_name == "10.50.0.2"
    # The candidate is gone
    assert db.query(PingCandidate).filter(PingCandidate.ip == "10.50.0.1").first() is None

    audit = db.query(AuditLog).filter(AuditLog.resource == "credential", AuditLog.action == "create").all()
    assert len(audit) == 2
    assert all(a.details["ping_only"] is True for a in audit)
    assert {a.resource_id for a in audit} == {str(c["credential_id"]) for c in body["created"]}


def test_adopt_legacy_api_prefix(client, auth_headers):
    r = client.post("/api/credentials/ping-only", json={"entries": [{"ip": "10.50.0.9"}]}, headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()["created"]) == 1


def test_adopt_skips_exists_invalid_duplicate(client, auth_headers, db):
    db.add(Credential(ip="10.50.1.1", label="snmp", enabled=False))
    db.commit()

    r = client.post("/api/v1/credentials/ping-only", json={"entries": [
        {"ip": "10.50.1.1"},
        {"ip": "bad;ip"},
        {"ip": "  "},
        {"ip": "10.50.1.2", "label": "A"},
        {"ip": "10.50.1.2", "label": "B"},
    ]}, headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["ip"] for c in body["created"]] == ["10.50.1.2"]
    assert body["skipped"] == [
        {"ip": "10.50.1.1", "reason": "exists"},
        {"ip": "bad;ip", "reason": "invalid"},
        {"ip": "  ", "reason": "invalid"},
        {"ip": "10.50.1.2", "reason": "duplicate"},
    ]
    db.expire_all()
    assert db.query(Credential).filter(Credential.ip == "10.50.1.1").count() == 1
    assert db.query(Device).filter(Device.ip == "10.50.1.1").first() is None
    assert db.query(Credential).filter(Credential.ip == "10.50.1.2").one().label == "A"


def test_adopt_existing_device_keeps_metadata(client, auth_headers, db):
    dev = Device(ip="10.50.2.1", sys_name="core", vendor="aruba_cx", device_type="switch", ping_status="online")
    db.add(dev)
    db.commit()

    r = client.post("/api/v1/credentials/ping-only", json={"entries": [{"ip": "10.50.2.1", "label": "x"}]},
                    headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["created"][0]["device_id"] == dev.id
    db.expire_all()
    dev = db.query(Device).filter(Device.ip == "10.50.2.1").one()
    assert dev.ping_only is True
    assert dev.sys_name == "core"
    assert dev.vendor == "aruba_cx"
    assert dev.device_type == "switch"
    assert dev.ping_status == "online"
    assert db.query(Credential).filter(Credential.ip == "10.50.2.1").one().device_id == dev.id


def test_adopt_rejects_too_many_entries(client, auth_headers):
    entries = [{"ip": f"10.51.{i // 250}.{i % 250 + 1}"} for i in range(501)]
    r = client.post("/api/v1/credentials/ping-only", json={"entries": entries}, headers=auth_headers)
    assert r.status_code == 422


def test_adopt_bumps_topology_version(client, auth_headers, monkeypatch):
    import routers.credentials as _c

    calls = []
    monkeypatch.setattr(_c, "_bump_topo_version", lambda: calls.append(1))
    client.post("/api/v1/credentials/ping-only", json={"entries": [{"ip": "10.50.3.1"}]}, headers=auth_headers)
    assert calls == [1]


def test_adopt_and_candidate_writes_forbidden_for_viewer(client, viewer_jwt_headers, db):
    db.add(PingCandidate(ip="10.50.4.1"))
    db.commit()
    r = client.post("/api/v1/credentials/ping-only", json={"entries": [{"ip": "10.50.4.1"}]},
                    headers=viewer_jwt_headers)
    assert r.status_code == 403
    assert db.query(Credential).count() == 0
    assert client.post("/api/v1/ping-candidates/dismiss", json={"ids": [1]},
                       headers=viewer_jwt_headers).status_code == 403
    assert client.post("/api/v1/ping-candidates/restore", json={"ids": [1]},
                       headers=viewer_jwt_headers).status_code == 403
    # Reading is allowed
    r = client.get("/api/v1/ping-candidates", headers=viewer_jwt_headers)
    assert r.status_code == 200
    assert [c["ip"] for c in r.json()] == ["10.50.4.1"]


# ---------------------------------------------------------------------------
# Scan finalize
# ---------------------------------------------------------------------------

def _finalize(executor_mod, db, **overrides):  # noqa: F811
    executor_mod._finalize_scan_db(db, **_finalize_kwargs(db, scan_mode="discovery", **overrides))


def test_finalize_creates_candidate_for_ping_only_probe_host(db, executor_mod):  # noqa: F811
    _finalize(executor_mod, db,
              ping_by_ip={"10.60.0.1": (True, 5), "10.60.0.2": (False, 0)},
              range_no_profile_ips=["10.60.0.1", "10.60.0.2"])
    cands = db.query(PingCandidate).all()
    assert [(c.ip, c.rtt_ms, c.dismissed) for c in cands] == [("10.60.0.1", 5, False)]
    assert cands[0].first_seen is not None and cands[0].last_seen is not None
    # The probe host still gets no Device
    assert db.query(Device).filter(Device.ip == "10.60.0.1").first() is None


def test_finalize_skips_cancelled_scans(db, executor_mod):  # noqa: F811
    _finalize(executor_mod, db, status="cancelled",
              ping_by_ip={"10.60.1.1": (True, 5)}, range_no_profile_ips=["10.60.1.1"])
    assert db.query(PingCandidate).count() == 0

    cancel = threading.Event()
    cancel.set()
    _finalize(executor_mod, db, cancel_event=cancel,
              ping_by_ip={"10.60.1.1": (True, 5)}, range_no_profile_ips=["10.60.1.1"])
    assert db.query(PingCandidate).count() == 0


def test_finalize_skips_existing_devices_and_credentials(db, executor_mod):  # noqa: F811
    db.add_all([
        Device(ip="10.60.2.1", sys_name="known"),
        Credential(ip="10.60.2.2", label="c", enabled=False),
    ])
    db.commit()
    _finalize(executor_mod, db,
              ping_by_ip={"10.60.2.1": (True, 1), "10.60.2.2": (True, 1), "10.60.2.3": (True, 1)},
              range_no_profile_ips=["10.60.2.1", "10.60.2.2", "10.60.2.3"])
    assert [c.ip for c in db.query(PingCandidate).all()] == ["10.60.2.3"]


def test_finalize_ignores_credential_targets(db, executor_mod):  # noqa: F811
    """Credential targets that answer ping but not SNMP are not range probes: no candidate."""
    _finalize(executor_mod, db, ping_by_ip={"10.60.3.1": (True, 2)})
    assert db.query(PingCandidate).count() == 0


def test_finalize_repeat_updates_last_seen_and_keeps_dismissed(db, executor_mod):  # noqa: F811
    old = datetime(2020, 1, 1)
    db.add(PingCandidate(ip="10.60.4.1", rtt_ms=9, first_seen=old, last_seen=old, dismissed=True))
    db.commit()
    _finalize(executor_mod, db, ping_by_ip={"10.60.4.1": (True, 3)}, range_no_profile_ips=["10.60.4.1"])
    db.expire_all()
    cand = db.query(PingCandidate).one()
    assert cand.rtt_ms == 3
    assert cand.dismissed is True
    assert cand.first_seen == old
    assert cand.last_seen.replace(tzinfo=None) > old


# ---------------------------------------------------------------------------
# GET / dismiss / restore
# ---------------------------------------------------------------------------

def test_list_filters_adopted_and_dismissed(client, auth_headers, db):
    db.add_all([
        PingCandidate(ip="10.70.0.10", rtt_ms=1),
        PingCandidate(ip="10.70.0.9", rtt_ms=2),
        PingCandidate(ip="10.70.0.100", rtt_ms=3),
        PingCandidate(ip="10.70.0.2", dismissed=True),
        PingCandidate(ip="10.70.0.3"),
        PingCandidate(ip="10.70.0.4"),
        Device(ip="10.70.0.3", sys_name="dev"),
        Credential(ip="10.70.0.4", label="c"),
    ])
    db.commit()

    r = client.get("/api/v1/ping-candidates", headers=auth_headers)
    assert r.status_code == 200
    items = r.json()
    # Numeric-aware IP order; adopted (device/credential) and dismissed hidden
    assert [c["ip"] for c in items] == ["10.70.0.9", "10.70.0.10", "10.70.0.100"]
    assert set(items[0]) == {"id", "ip", "rtt_ms", "first_seen", "last_seen", "hostname", "mac", "vendor",
                             "dismissed"}
    assert all(c["dismissed"] is False for c in items)

    r = client.get("/api/v1/ping-candidates?include_dismissed=true", headers=auth_headers)
    by_ip = {c["ip"]: c["dismissed"] for c in r.json()}
    assert by_ip == {"10.70.0.2": True, "10.70.0.9": False, "10.70.0.10": False, "10.70.0.100": False}


def test_list_enriches_from_endpoints(client, auth_headers, db):
    now = datetime(2026, 1, 1)
    db.add_all([
        PingCandidate(ip="10.70.1.1"),
        PingCandidate(ip="10.70.1.2"),
        Endpoint(mac="aa:bb:cc:00:00:01", ip="10.70.1.1", hostname="old", last_seen=now - timedelta(days=1)),
        Endpoint(mac="aa:bb:cc:00:00:02", ip="10.70.1.1", hostname="printer.lan", last_seen=now),
    ])
    db.commit()
    items = {c["ip"]: c for c in client.get("/api/v1/ping-candidates", headers=auth_headers).json()}
    assert items["10.70.1.1"]["hostname"] == "printer.lan"
    assert items["10.70.1.1"]["mac"] == "aa:bb:cc:00:00:02"
    assert items["10.70.1.1"]["vendor"] is None
    assert items["10.70.1.2"]["hostname"] is None
    assert items["10.70.1.2"]["mac"] is None


def test_dismiss_and_restore(client, auth_headers, db):
    a, b = PingCandidate(ip="10.70.2.1"), PingCandidate(ip="10.70.2.2")
    db.add_all([a, b])
    db.commit()

    r = client.post("/api/v1/ping-candidates/dismiss", json={"ids": [a.id, b.id, 9999]}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"dismissed": 2}
    assert client.get("/api/v1/ping-candidates", headers=auth_headers).json() == []
    # Already dismissed rows are not counted again
    assert client.post("/api/v1/ping-candidates/dismiss", json={"ids": [a.id]},
                       headers=auth_headers).json() == {"dismissed": 0}

    r = client.post("/api/v1/ping-candidates/restore", json={"ids": [a.id]}, headers=auth_headers)
    assert r.json() == {"restored": 1}
    assert [c["ip"] for c in client.get("/api/v1/ping-candidates", headers=auth_headers).json()] == ["10.70.2.1"]
    assert client.post("/api/ping-candidates/restore", json={"ids": []}, headers=auth_headers).json() == {
        "restored": 0}


# ---------------------------------------------------------------------------
# Migration 028
# ---------------------------------------------------------------------------

def test_migration_028_upgrade_downgrade_sqlite():
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "028_ping_candidates.py"
    spec = importlib.util.spec_from_file_location("_mig028", path)
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "028" and mig.down_revision == "027"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        cols = {c["name"]: c for c in sa.inspect(conn).get_columns("ping_candidates")}
        assert set(cols) == {"id", "ip", "rtt_ms", "first_seen", "last_seen", "dismissed"}
        assert cols["dismissed"]["nullable"] is False
        conn.execute(sa.text("INSERT INTO ping_candidates (ip) VALUES ('10.0.0.1')"))
        row = conn.execute(sa.text("SELECT dismissed, first_seen FROM ping_candidates")).one()
        assert not row[0] and row[1] is not None
        with pytest.raises(sa.exc.IntegrityError):
            conn.execute(sa.text("INSERT INTO ping_candidates (ip) VALUES ('10.0.0.1')"))
        mig.downgrade()
        assert "ping_candidates" not in sa.inspect(conn).get_table_names()
    eng.dispose()
