"""Ping-only devices: credentials with snmp_enabled=False are pinged, never queried via SNMP.

The scan tests run the real executor module (conftest mocks the whole
scan_engine package, see the executor_mod fixture in test_executor_finalize).
"""
import asyncio
from unittest.mock import AsyncMock, Mock

from database import Credential, Device
from tests.test_executor_finalize import _finalize_kwargs, executor_mod  # noqa: F401


def _patch_scan(monkeypatch, executor_mod, ping_ok=True):  # noqa: F811
    """Patch ping (subprocess) and SNMP; returns the SNMP mock."""
    proc = Mock(returncode=0 if ping_ok else 1)
    proc.communicate = AsyncMock(return_value=(b"time=3ms" if ping_ok else b"", b""))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    monkeypatch.setattr(executor_mod, "_read_discovery_ranges", lambda db: [])
    snmp = AsyncMock(return_value=None)
    monkeypatch.setattr(executor_mod, "scan_switch", snmp)
    return snmp


def test_ping_only_credential_creates_device_without_snmp(db, executor_mod, monkeypatch):  # noqa: F811
    cred = Credential(ip="10.40.0.1", label="Printer", enabled=True, snmp_enabled=False)
    db.add(cred)
    db.commit()
    snmp = _patch_scan(monkeypatch, executor_mod, ping_ok=True)

    result = asyncio.run(executor_mod._execute_scan(db, scan_type="full"))

    snmp.assert_not_called()
    assert result.scanned == 1
    assert result.found == 1
    assert result.errors == []
    assert [m.success for m in result.switch_metrics] == [True]
    db.expire_all()
    dev = db.query(Device).filter(Device.ip == "10.40.0.1").one()
    assert dev.ping_only is True
    assert dev.sys_name == "Printer"
    assert dev.sys_descr == "Ping-only device (SNMP disabled)"
    assert dev.device_type == "other"
    assert dev.vendor == ""
    assert dev.ping_status == "online"
    assert dev.ping_rtt_ms == 3
    assert dev.last_ping is not None
    assert db.query(Credential).filter(Credential.id == cred.id).one().device_id == dev.id


def test_ping_only_failed_ping_still_creates_offline_device(db, executor_mod, monkeypatch):  # noqa: F811
    db.add(Credential(ip="10.40.0.2", label="", enabled=True, snmp_enabled=False))
    db.commit()
    snmp = _patch_scan(monkeypatch, executor_mod, ping_ok=False)

    result = asyncio.run(executor_mod._execute_scan(db, scan_type="discovery"))

    snmp.assert_not_called()
    assert result.found == 0
    assert result.errors == []
    db.expire_all()
    dev = db.query(Device).filter(Device.ip == "10.40.0.2").one()
    assert dev.ping_only is True
    assert dev.ping_status == "offline"
    assert dev.ping_rtt_ms == 0
    # No label on the credential: the IP becomes the name
    assert dev.sys_name == "10.40.0.2"


def test_ping_only_target_in_port_scan_mode(db, executor_mod, monkeypatch):  # noqa: F811
    """A newly registered ping-only host is picked up by any scan type."""
    db.add(Credential(ip="10.40.0.3", label="Cam", enabled=True, snmp_enabled=False))
    db.commit()
    snmp = _patch_scan(monkeypatch, executor_mod, ping_ok=True)

    asyncio.run(executor_mod._execute_scan(db, scan_type="macs"))

    snmp.assert_not_called()
    db.expire_all()
    assert db.query(Device).filter(Device.ip == "10.40.0.3").one().ping_only is True


def test_existing_device_toggles_ping_only_and_keeps_metadata(db, executor_mod):  # noqa: F811
    dev = Device(ip="10.40.0.4", sys_name="core-sw", vendor="aruba_cx", device_type="switch",
                 rack_id=None, class_id=None, ping_status="unknown")
    cred = Credential(ip="10.40.0.4", label="Core", enabled=True, snmp_enabled=False)
    db.add_all([dev, cred])
    db.commit()

    executor_mod._finalize_scan_db(db, **_finalize_kwargs(
        db,
        ping_by_ip={"10.40.0.4": (True, 7)},
        ping_only_targets={"10.40.0.4": {"credential_id": cred.id, "label": "Core"}},
    ))
    db.refresh(dev)
    assert dev.ping_only is True
    assert dev.ping_status == "online"
    assert dev.ping_rtt_ms == 7
    assert dev.sys_name == "core-sw"
    assert dev.vendor == "aruba_cx"
    assert dev.device_type == "switch"
    db.refresh(cred)
    assert cred.device_id == dev.id

    # Credential switched back to SNMP: the next scan clears the flag even
    # when SNMP does not answer (ping ok, no switch data).
    executor_mod._finalize_scan_db(db, **_finalize_kwargs(db, ping_by_ip={"10.40.0.4": (True, 2)}))
    db.refresh(dev)
    assert dev.ping_only is False
    assert dev.ping_status == "online"


def test_snmp_credential_wins_over_ping_only_for_same_ip(db, executor_mod, monkeypatch):  # noqa: F811
    db.add_all([
        Credential(ip="10.40.0.5", label="ping", priority=0, enabled=True, snmp_enabled=False),
        Credential(ip="10.40.0.5", label="snmp", priority=1, enabled=True, snmp_enabled=True),
    ])
    db.commit()
    snmp = _patch_scan(monkeypatch, executor_mod, ping_ok=True)

    asyncio.run(executor_mod._execute_scan(db, scan_type="full"))

    assert snmp.call_count == 1
    db.expire_all()
    # SNMP failed for an unknown host: no ping-only device is created
    assert db.query(Device).filter(Device.ip == "10.40.0.5").first() is None


def test_cancelled_scan_does_not_create_ping_only_device(db, executor_mod):  # noqa: F811
    cred = Credential(ip="10.40.0.6", label="x", enabled=True, snmp_enabled=False)
    db.add(cred)
    db.commit()
    executor_mod._finalize_scan_db(db, **_finalize_kwargs(
        db,
        status="cancelled",
        ping_by_ip={"10.40.0.6": (False, 0)},
        ping_only_targets={"10.40.0.6": {"credential_id": cred.id, "label": "x"}},
    ))
    assert db.query(Device).filter(Device.ip == "10.40.0.6").first() is None


def test_latency_monitor_selects_ping_only_devices(db):
    from types import SimpleNamespace

    from latency import store

    db.add(Device(ip="10.40.0.7", sys_name="p", ping_only=True, latency_monitored=True))
    db.commit()
    for mode in ("all", "selected"):
        ips = [d.ip for d in store.target_query(db, SimpleNamespace(mode=mode)).all()]
        assert "10.40.0.7" in ips


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def test_credentials_api_round_trips_snmp_enabled(client, auth_headers):
    r = client.post("/api/v1/credentials", json={"label": "P", "ip": "10.41.0.1", "snmp_enabled": False},
                    headers=auth_headers)
    assert r.status_code == 201
    cred = r.json()
    assert cred["snmp_enabled"] is False

    r = client.post("/api/v1/credentials", json={"label": "S", "ip": "10.41.0.2"}, headers=auth_headers)
    assert r.json()["snmp_enabled"] is True

    r = client.put(f"/api/v1/credentials/{cred['id']}", json={"snmp_enabled": True}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["snmp_enabled"] is True

    # Explicit null leaves the flag unchanged instead of violating NOT NULL
    r = client.put(f"/api/v1/credentials/{cred['id']}", json={"snmp_enabled": None}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["snmp_enabled"] is True

    listed = {c["ip"]: c["snmp_enabled"] for c in client.get("/api/v1/credentials", headers=auth_headers).json()}
    assert listed == {"10.41.0.1": True, "10.41.0.2": True}


def test_bulk_export_import_snmp_enabled(client, auth_headers, db):
    import json

    db.add(Credential(ip="10.42.0.1", label="P", enabled=True, snmp_enabled=False))
    db.commit()
    r = client.get("/api/v1/bulk-export/credentials?fmt=json", headers=auth_headers)
    rows = json.loads(r.json()["data"])
    assert rows[0]["snmp_enabled"] is False

    r = client.get("/api/v1/bulk-export/credentials?fmt=csv", headers=auth_headers)
    assert "snmp_enabled" in r.json()["data"].splitlines()[0]

    payload = [
        {"label": "Old", "ip": "10.42.0.2"},                                 # field missing -> True
        {"label": "Ping", "ip": "10.42.0.3", "snmp_enabled": "false"},
    ]
    r = client.post("/api/v1/bulk-import/credentials",
                    json={"format": "json", "data": json.dumps(payload), "dry_run": False}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["inserted"] == 2
    db.expire_all()
    by_ip = {c.ip: c.snmp_enabled for c in db.query(Credential).all()}
    assert by_ip["10.42.0.2"] is True
    assert by_ip["10.42.0.3"] is False

    csv_data = "label,ip,snmp_enabled\nCsvOld,10.42.0.4,\nCsvPing,10.42.0.5,0\n"
    r = client.post("/api/v1/bulk-import/credentials",
                    json={"format": "csv", "data": csv_data, "dry_run": False}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["inserted"] == 2
    db.expire_all()
    by_ip = {c.ip: c.snmp_enabled for c in db.query(Credential).all()}
    assert by_ip["10.42.0.4"] is True
    assert by_ip["10.42.0.5"] is False


def test_config_export_import_snmp_enabled(client, auth_headers, db):
    import json

    db.add(Credential(ip="10.43.0.1", label="P", enabled=True, snmp_enabled=False))
    db.commit()
    exported = json.loads(client.get("/api/v1/config/export", headers=auth_headers).json()["data"])
    assert exported["credentials"][0]["snmp_enabled"] is False

    data = {"credentials": [
        {"label": "Legacy", "ip": "10.43.0.2"},
        {"label": "Ping", "ip": "10.43.0.3", "snmp_enabled": False},
    ]}
    r = client.post("/api/v1/config/import", json={"data": json.dumps(data), "dry_run": False}, headers=auth_headers)
    assert r.status_code == 200, r.text
    db.expire_all()
    by_ip = {c.ip: c.snmp_enabled for c in db.query(Credential).all()}
    assert by_ip["10.43.0.2"] is True
    assert by_ip["10.43.0.3"] is False


def test_device_payloads_expose_ping_only(client, auth_headers, db):
    db.add(Device(ip="10.44.0.1", sys_name="p", ping_only=True))
    db.commit()
    devices = client.get("/api/v1/devices", headers=auth_headers).json()
    assert devices[0]["ping_only"] is True
    nodes = client.get("/api/v1/topology", headers=auth_headers).json()["nodes"]
    assert nodes[0]["ping_only"] is True


def test_meta_patch_accepts_device_type_other(client, auth_headers, db):
    dev = Device(ip="10.44.0.2", sys_name="p")
    db.add(dev)
    db.commit()
    r = client.patch(f"/api/v1/topology/devices/{dev.id}/meta", json={"device_type": "other"},
                     headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["device_type"] == "other"
