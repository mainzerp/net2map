"""UPS / server device types and health snapshots.

Covers the pure normalization in scanners.health (fake OID -> value dicts),
the vendor scanner hooks, the scan path against pysnmp stand-ins (same
approach as test_stp_vlan.py), executor persistence, the API payloads and
migration 025.
"""
import asyncio
import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa

import scanners.health as h
from database import Device
from scanners import get_scanner
from scanners.base import VendorScanner
from scanners.generic import GenericScanner
from schemas import DeviceOut
from tests.test_stp_vlan import _finalize, _sw, executor_mod, scanner  # noqa: F401

BACKEND = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# UPS normalization
# ---------------------------------------------------------------------------

_UPS_OK = {
    h.OID_UPS_IDENT_MANUFACTURER: "EATON",
    h.OID_UPS_IDENT_MODEL: "Eaton 9PX 3000",
    h.OID_UPS_IDENT_SOFTWARE: "INV: 01.14.0026",
    h.OID_UPS_BATTERY_STATUS: "2",
    h.OID_UPS_SECONDS_ON_BATTERY: "0",
    h.OID_UPS_MINUTES_REMAINING: "42",
    h.OID_UPS_CHARGE_REMAINING: "100",
    h.OID_UPS_BATTERY_TEMPERATURE: "24",
    h.OID_UPS_OUTPUT_SOURCE: "3",
    h.OID_UPS_ALARMS_PRESENT: "0",
}
_LOAD_ROWS = [(f"{h.OID_UPS_OUTPUT_PERCENT_LOAD}.1", "23"), (f"{h.OID_UPS_OUTPUT_PERCENT_LOAD}.2", "31")]
_VOLT_ROWS = [(f"{h.OID_UPS_INPUT_VOLTAGE}.2", "229"), (f"{h.OID_UPS_INPUT_VOLTAGE}.1", "231")]


def test_parse_ups_health_rfc1628():
    health = h.parse_ups_health(_UPS_OK, _LOAD_ROWS, _VOLT_ROWS)
    assert health == {
        "kind": "ups", "status": "ok",
        "manufacturer": "EATON", "model": "Eaton 9PX 3000", "software": "INV: 01.14.0026",
        "battery_status": "normal", "seconds_on_battery": 0, "runtime_minutes": 42,
        "charge_percent": 100, "battery_temperature_c": 24, "output_source": "normal",
        "load_percent": 31, "input_voltage": 231, "alarms_present": 0,
    }


def test_parse_ups_health_xups_fallback():
    values = {
        h.OID_XUPS_IDENT_MODEL: "Eaton 5PX 1500",
        h.OID_XUPS_BAT_TIME_REMAINING: "1830",
        h.OID_XUPS_BAT_CAPACITY: "88",
        h.OID_XUPS_OUTPUT_LOAD: "17",
        h.OID_XUPS_OUTPUT_SOURCE: "3",
    }
    health = h.parse_ups_health(values)
    assert health["model"] == "Eaton 5PX 1500"
    assert health["runtime_minutes"] == 30
    assert health["charge_percent"] == 88
    assert health["load_percent"] == 17
    assert health["output_source"] == "normal"
    assert health["battery_status"] is None
    assert health["status"] == "ok"


def test_parse_ups_health_cpqpower_fallback():
    values = {
        h.OID_CPQ_UPS_IDENT_MODEL: "R1500 G4",
        h.OID_CPQ_UPS_BAT_TIME_REMAINING: "600",
        h.OID_CPQ_UPS_BAT_CAPACITY: "75",
        h.OID_CPQ_UPS_OUTPUT_LOAD: "40",
        h.OID_CPQ_UPS_OUTPUT_SOURCE: "5",
    }
    health = h.parse_ups_health(values)
    assert (health["runtime_minutes"], health["charge_percent"], health["load_percent"]) == (10, 75, 40)
    assert health["output_source"] == "battery"
    assert health["status"] == "warning"


def test_rfc1628_wins_over_vendor_fallback():
    values = dict(_UPS_OK)
    values[h.OID_XUPS_BAT_CAPACITY] = "10"
    values[h.OID_XUPS_OUTPUT_LOAD] = "99"
    health = h.parse_ups_health(values, _LOAD_ROWS)
    assert health["charge_percent"] == 100 and health["load_percent"] == 31


@pytest.mark.parametrize("overrides, expected", [
    ({h.OID_UPS_OUTPUT_SOURCE: "5", h.OID_UPS_SECONDS_ON_BATTERY: "120"}, "warning"),
    ({h.OID_UPS_BATTERY_STATUS: "3"}, "warning"),
    ({h.OID_UPS_OUTPUT_SOURCE: "4"}, "warning"),
    ({h.OID_UPS_ALARMS_PRESENT: "1"}, "warning"),
    ({h.OID_UPS_BATTERY_STATUS: "4"}, "critical"),
    ({h.OID_UPS_OUTPUT_SOURCE: "2"}, "critical"),
    ({h.OID_UPS_ALARMS_PRESENT: "2", h.OID_UPS_CHARGE_REMAINING: "15"}, "critical"),
    ({}, "ok"),
])
def test_ups_status(overrides, expected):
    values = dict(_UPS_OK, **overrides)
    assert h.parse_ups_health(values)["status"] == expected


def test_parse_ups_health_empty_and_garbage():
    assert h.parse_ups_health({}) is None
    assert h.parse_ups_health({h.OID_UPS_CHARGE_REMAINING: "n/a"}) is None
    health = h.parse_ups_health({h.OID_UPS_IDENT_MANUFACTURER: "ACME"})
    assert health["status"] == "unknown" and health["manufacturer"] == "ACME"


def test_parse_ups_unknown_output_source_code():
    assert h.parse_ups_health({h.OID_UPS_OUTPUT_SOURCE: "42"})["output_source"] == "other"


# ---------------------------------------------------------------------------
# Server normalization
# ---------------------------------------------------------------------------

_SERVER_OK = {
    h.OID_CPQ_HE_MIB_CONDITION: "2",
    h.OID_CPQ_HE_THERMAL_CONDITION: "2",
    h.OID_CPQ_HE_POWER_CONDITION: "2",
    h.OID_CPQ_HE_FAN_STATUS: "2",
    h.OID_CPQ_DA_MIB_CONDITION: "2",
    h.OID_CPQ_SI_PRODUCT_NAME: "ProLiant DL380 Gen10",
    h.OID_CPQ_SI_SERIAL: "CZ1234ABCD",
    h.OID_CPQ_SM2_ROM_REVISION: "2.72",
}
_TEMP_ROWS = [
    (f"{h.OID_CPQ_HE_TEMPERATURE_CELSIUS}.0.1", "21"),
    (f"{h.OID_CPQ_HE_TEMPERATURE_CELSIUS}.0.2", "48"),
    (f"{h.OID_CPQ_HE_TEMPERATURE_CELSIUS}.0.3", "-99"),
    (f"{h.OID_CPQ_HE_TEMPERATURE_CELSIUS}.0.4", "0"),
]


def test_parse_server_health():
    assert h.parse_server_health(_SERVER_OK, _TEMP_ROWS) == {
        "kind": "server", "status": "ok",
        "overall": "ok", "thermal": "ok", "power_supply": "ok", "fans": "ok", "storage": "ok",
        "temperature_max_c": 48, "temperature_sensors": 2,
        "product_name": "ProLiant DL380 Gen10", "serial_number": "CZ1234ABCD", "ilo_firmware": "2.72",
    }


@pytest.mark.parametrize("overrides, expected", [
    ({h.OID_CPQ_HE_FAN_STATUS: "3"}, "warning"),
    ({h.OID_CPQ_HE_POWER_CONDITION: "4"}, "critical"),
    ({h.OID_CPQ_HE_MIB_CONDITION: "3", h.OID_CPQ_DA_MIB_CONDITION: "4"}, "critical"),
])
def test_server_status(overrides, expected):
    assert h.parse_server_health(dict(_SERVER_OK, **overrides))["status"] == expected


def test_server_condition_other_is_unknown():
    health = h.parse_server_health({h.OID_CPQ_DA_MIB_CONDITION: "1"})
    assert health["storage"] == "unknown" and health["status"] == "unknown"
    assert health["temperature_max_c"] is None and health["temperature_sensors"] is None


def test_parse_server_health_empty():
    assert h.parse_server_health({}, []) is None


def test_health_model_and_firmware():
    assert h.health_model({"model": "9PX"}) == "9PX"
    assert h.health_model({"product_name": "ProLiant DL360"}) == "ProLiant DL360"
    assert h.health_firmware({"ilo_firmware": "2.72"}) == "2.72"
    assert h.health_model(None) == "" and h.health_firmware({}) == ""


# ---------------------------------------------------------------------------
# Collectors (async, injected SNMP helpers)
# ---------------------------------------------------------------------------

def _fake_snmp(values, walks=None, fail_get=False):
    calls = {"gets": [], "walks": []}

    async def get(*oids):
        calls["gets"].append(oids)
        if fail_get:
            raise RuntimeError("timeout")
        return {o: values[o] for o in oids if o in values}

    async def walk(oid):
        calls["walks"].append(oid)
        return list((walks or {}).get(oid, []))

    return get, walk, calls


def test_collect_ups_health_with_vendor_fallback():
    values = {h.OID_UPS_BATTERY_STATUS: "2", h.OID_XUPS_BAT_CAPACITY: "90"}
    get, walk, calls = _fake_snmp(values, {h.OID_UPS_OUTPUT_PERCENT_LOAD: _LOAD_ROWS})
    health = asyncio.run(h.collect_ups_health(get, walk, extra_oids=h.XUPS_SCALAR_OIDS))
    assert health["charge_percent"] == 90 and health["load_percent"] == 31
    assert len(calls["gets"]) == 2


def test_collectors_never_raise():
    get, walk, _ = _fake_snmp({}, fail_get=True)
    assert asyncio.run(h.collect_ups_health(get, walk)) is None
    assert asyncio.run(h.collect_server_health(get, walk)) is None


def test_collect_server_health():
    get, walk, _ = _fake_snmp(_SERVER_OK, {h.OID_CPQ_HE_TEMPERATURE_CELSIUS: _TEMP_ROWS})
    assert asyncio.run(h.collect_server_health(get, walk))["temperature_max_c"] == 48


# ---------------------------------------------------------------------------
# Scanner hooks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("vendor, device_type, fdb, stp", [
    ("generic", "switch", True, True),
    ("cisco", "switch", True, True),
    ("opnsense", "firewall", True, False),
    ("eaton", "ups", False, False),
    ("hpe_ups", "ups", False, False),
    ("hpe_ilo", "server", False, False),
])
def test_scanner_hooks(vendor, device_type, fdb, stp):
    s = get_scanner(vendor)
    assert s.vendor_id == vendor
    assert s.device_type() == device_type
    assert s.supports_fdb() is fdb
    assert s.supports_stp() is stp


def test_base_collect_health_default_is_none():
    assert asyncio.run(VendorScanner.collect_health(GenericScanner(), None, None)) is None


def test_model_extraction():
    assert get_scanner("hpe_ilo").extract_model("Integrated Lights-Out 5 2.72 ProLiant DL380 Gen10") \
        == "ProLiant DL380 Gen10"
    assert get_scanner("eaton").extract_model("Eaton 9PX 3000i RT3U Network-M2") == "Eaton 9PX 3000i"


# ---------------------------------------------------------------------------
# Scan path against pysnmp stand-ins
# ---------------------------------------------------------------------------

def _install(mod, monkeypatch, sys_descr, sys_oid, values=None, walks=None):
    calls = {"walked": [], "gets": []}
    base = {
        mod.OID_SYS_NAME: "dev1",
        mod.OID_SYS_DESCR: sys_descr,
        mod.OID_SYS_OBJECT_ID: sys_oid,
    }
    base.update(values or {})

    async def fake_get(ip, port, auth, *oids, **kw):
        calls["gets"].append(oids)
        return {o: base[o] for o in oids if o in base}

    async def fake_empty(*args, **kw):
        return {}

    async def fake_walk(ip, port, auth, oid, **kw):
        calls["walked"].append(oid)
        return list((walks or {}).get(oid, []))

    async def fake_walk_raw(ip, port, auth, oid, **kw):
        # MAC-typed columns (ARP) are walked raw
        calls["walked"].append(oid)
        return []

    monkeypatch.setattr(mod, "snmp_get", fake_get)
    monkeypatch.setattr(mod, "snmp_get_raw", fake_empty)
    monkeypatch.setattr(mod, "snmp_get_values", fake_empty)
    monkeypatch.setattr(mod, "snmp_bulk_walk", fake_walk)
    monkeypatch.setattr(mod, "snmp_bulk_walk_raw", fake_walk_raw)
    return calls


def test_scan_eaton_collects_health_and_skips_fdb(scanner, monkeypatch):  # noqa: F811
    calls = _install(scanner, monkeypatch, "Eaton 9PX Network-M2", "1.3.6.1.4.1.534.1",
                     values=_UPS_OK, walks={h.OID_UPS_OUTPUT_PERCENT_LOAD: _LOAD_ROWS})
    sw = asyncio.run(scanner.scan_switch("10.0.0.9", scan_type="full"))
    assert sw.vendor == "eaton" and sw.device_type == "ups"
    assert sw.health["kind"] == "ups" and sw.health["load_percent"] == 31
    assert scanner.OID_DOT1D_TP_FDB_PORT not in calls["walked"]
    assert scanner.OID_QBRIDGE_FDB_PORT not in calls["walked"]
    assert scanner.OID_ARP_MAC in calls["walked"]


def test_scan_ilo_collects_server_health(scanner, monkeypatch):  # noqa: F811
    _install(scanner, monkeypatch, "Integrated Lights-Out 5 2.72", "1.3.6.1.4.1.232.9.4.11",
             values=_SERVER_OK, walks={h.OID_CPQ_HE_TEMPERATURE_CELSIUS: _TEMP_ROWS})
    sw = asyncio.run(scanner.scan_switch("10.0.0.10", scan_type="links"))
    assert sw.vendor == "hpe_ilo" and sw.device_type == "server"
    assert sw.health["status"] == "ok" and sw.health["temperature_max_c"] == 48


def test_scan_generic_ups_probe(scanner, monkeypatch):  # noqa: F811
    _install(scanner, monkeypatch, "UPS SNMP Agent", "1.3.6.1.4.1.99999.1", values=_UPS_OK)
    sw = asyncio.run(scanner.scan_switch("10.0.0.11", scan_type="discovery"))
    assert sw.vendor == "generic" and sw.device_type == "ups"
    assert sw.health is None  # discovery never collects health
    sw = asyncio.run(scanner.scan_switch("10.0.0.11", scan_type="links"))
    assert sw.health["kind"] == "ups" and sw.health["status"] == "ok"


def test_scan_generic_switch_stays_switch(scanner, monkeypatch):  # noqa: F811
    calls = _install(scanner, monkeypatch, "generic switch", "1.3.6.1.4.1.99999.1")
    sw = asyncio.run(scanner.scan_switch("10.0.0.12", scan_type="full"))
    assert sw.device_type == "switch" and sw.health is None
    assert scanner.OID_DOT1D_TP_FDB_PORT in calls["walked"]
    # Exactly one extra GET (the UPS-MIB probe) beyond the system scalars
    assert (h.OID_UPS_IDENT_MANUFACTURER,) in calls["gets"]
    assert not any(h.OID_UPS_BATTERY_STATUS in g for g in calls["gets"])


def test_scan_health_failure_never_breaks_scan(scanner, monkeypatch):  # noqa: F811
    _install(scanner, monkeypatch, "Integrated Lights-Out 5", "1.3.6.1.4.1.232.9.4.11")

    async def boom(self, get, walk):
        raise RuntimeError("agent crashed")

    monkeypatch.setattr(type(get_scanner("hpe_ilo")), "collect_health", boom)
    sw = asyncio.run(scanner.scan_switch("10.0.0.13", scan_type="full"))
    assert sw is not None and sw.health is None


# ---------------------------------------------------------------------------
# Executor persistence
# ---------------------------------------------------------------------------

_UPS_HEALTH = {"kind": "ups", "status": "ok", "model": "Eaton 9PX 3000", "software": "01.14", "charge_percent": 100}


def _ups_sw(ip, vendor="eaton", device_type="ups", health=None):
    sw = _sw(ip)
    sw.vendor = vendor
    sw.device_type = device_type
    sw.health = health
    return sw


def test_executor_persists_health_and_type(db, executor_mod):  # noqa: F811
    _finalize(executor_mod, db, {"10.3.0.1": _ups_sw("10.3.0.1", health=dict(_UPS_HEALTH))}, "links")
    dev = db.query(Device).filter(Device.ip == "10.3.0.1").one()
    assert dev.device_type == "ups"
    assert dev.health == _UPS_HEALTH
    assert dev.health_updated_at is not None and dev.health_updated_at.tzinfo is None
    assert dev.model == "Eaton 9PX 3000" and dev.firmware == "01.14"


def test_executor_keeps_health_when_not_collected(db, executor_mod):  # noqa: F811
    db.add(Device(ip="10.3.0.2", sys_name="ups", device_type="ups", health=dict(_UPS_HEALTH)))
    db.commit()
    _finalize(executor_mod, db, {"10.3.0.2": _ups_sw("10.3.0.2", health=None)}, "links")
    dev = db.query(Device).filter(Device.ip == "10.3.0.2").one()
    db.refresh(dev)
    assert dev.health == _UPS_HEALTH


def test_executor_discovery_skips_health(db, executor_mod):  # noqa: F811
    db.add(Device(ip="10.3.0.3", sys_name="ups"))
    db.commit()
    _finalize(executor_mod, db, {"10.3.0.3": _ups_sw("10.3.0.3", health=dict(_UPS_HEALTH))}, "discovery")
    dev = db.query(Device).filter(Device.ip == "10.3.0.3").one()
    db.refresh(dev)
    assert dev.health is None and dev.device_type == "ups"


def test_executor_opnsense_is_firewall(db, executor_mod):  # noqa: F811
    _finalize(executor_mod, db, {"10.3.0.4": _ups_sw("10.3.0.4", "opnsense", "firewall")}, "links")
    assert db.query(Device).filter(Device.ip == "10.3.0.4").one().device_type == "firewall"


def test_executor_old_switchdata_without_type(db, executor_mod):  # noqa: F811
    """SwitchData-like objects without the new attributes default to switch."""
    _finalize(executor_mod, db, {"10.3.0.5": _sw("10.3.0.5")}, "links")
    dev = db.query(Device).filter(Device.ip == "10.3.0.5").one()
    assert dev.device_type == "switch" and dev.health is None


@pytest.mark.parametrize("current, detected, vendor, override, expected", [
    ("switch", "ups", "eaton", False, "ups"),
    ("ups", "switch", "cisco", False, "switch"),       # confident vendor detection wins
    ("server", "switch", "generic", False, "server"),  # generic fallback keeps manual type
    ("switch", "ups", "generic", False, "ups"),        # UPS-MIB probe is confident
    ("server", "ups", "eaton", True, "server"),        # override keeps a non-default type
    ("switch", "ups", "eaton", True, "ups"),           # override + default type upgrades
    ("switch", "switch", "generic", True, "switch"),
    (None, "firewall", "opnsense", False, "firewall"),
])
def test_resolve_device_type(executor_mod, current, detected, vendor, override, expected):  # noqa: F811
    assert executor_mod._resolve_device_type(current, detected, vendor, override) == expected


def test_executor_vendor_override_keeps_manual_type(db, executor_mod):  # noqa: F811
    db.add(Device(ip="10.3.0.6", sys_name="x", vendor="cisco", vendor_override=True, device_type="server"))
    db.commit()
    _finalize(executor_mod, db, {"10.3.0.6": _ups_sw("10.3.0.6", "eaton", "ups")}, "links")
    dev = db.query(Device).filter(Device.ip == "10.3.0.6").one()
    db.refresh(dev)
    assert dev.vendor == "cisco" and dev.device_type == "server"


# ---------------------------------------------------------------------------
# API payloads
# ---------------------------------------------------------------------------

def test_device_out_defaults():
    out = DeviceOut.model_validate(
        {"id": 1, "sys_name": "sw", "ip": "10.0.0.1", "last_seen": "2026-01-01T00:00:00", "device_type": None}
    ).model_dump(mode="json")
    assert out["device_type"] == "switch" and out["health"] is None and out["health_updated_at"] is None


def test_topology_and_devices_include_health(client, auth_headers, db):
    db.add(Device(ip="10.4.0.1", sys_name="ups1", device_type="ups", health=dict(_UPS_HEALTH)))
    db.add(Device(ip="10.4.0.2", sys_name="sw1"))
    db.commit()
    import routers.topology as topo
    topo._set_topo_cache({})
    r = client.get("/api/v1/topology", headers=auth_headers)
    assert r.status_code == 200, r.text
    nodes = {n["ip"]: n for n in r.json()["nodes"]}
    assert nodes["10.4.0.1"]["device_type"] == "ups"
    assert nodes["10.4.0.1"]["health"]["charge_percent"] == 100
    assert nodes["10.4.0.2"]["device_type"] == "switch" and nodes["10.4.0.2"]["health"] is None
    r = client.get("/api/v1/devices", headers=auth_headers)
    assert r.status_code == 200
    devs = {d["ip"]: d for d in r.json()}
    assert devs["10.4.0.1"]["health"]["kind"] == "ups"


def test_meta_patch_device_type(client, auth_headers, db):
    dev = Device(ip="10.4.0.3", sys_name="x")
    db.add(dev)
    db.commit()
    r = client.patch(f"/api/v1/topology/devices/{dev.id}/meta", json={"device_type": "server"},
                     headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["device_type"] == "server"
    r = client.patch(f"/api/v1/topology/devices/{dev.id}/meta", json={"device_type": "toaster"},
                     headers=auth_headers)
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Migration 025
# ---------------------------------------------------------------------------

def test_migration_025_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location(
        "_mig025", BACKEND / "alembic" / "versions" / "025_device_type_health.py"
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "025" and mig.down_revision == "024"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY, ip VARCHAR, vendor VARCHAR)"))
        conn.execute(sa.text("INSERT INTO devices (id, ip, vendor) VALUES (1, 'a', 'opnsense'), (2, 'b', 'cisco')"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        cols = {c["name"] for c in sa.inspect(conn).get_columns("devices")}
        assert {"device_type", "health", "health_updated_at"} <= cols
        rows = dict(conn.execute(sa.text("SELECT ip, device_type FROM devices")).fetchall())
        assert rows == {"a": "firewall", "b": "switch"}
        mig.downgrade()
        assert {c["name"] for c in sa.inspect(conn).get_columns("devices")} == {"id", "ip", "vendor"}
