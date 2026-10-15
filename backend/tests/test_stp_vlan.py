"""Spanning tree (BRIDGE-MIB / RSTP-MIB) and VLAN name support.

Covers the pure parsing helpers, the scan path against pysnmp stand-ins
(same approach as test_engine_id.py), schema serialization, executor
persistence and migration 019.
"""
import asyncio
import importlib
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa

from database import Device, Port
from scanners.base import VendorScanner
from scanners.cisco import CiscoScanner
from scanners.generic import GenericScanner
from scanners.opnsense import OPNsenseScanner
from scanners.parsing import (
    build_bridge_id,
    build_stp_info,
    derive_stp_role,
    parse_bridge_id,
    parse_vlan_names,
    stp_protocol_from,
    stp_state_from,
)
from schemas import DeviceOut, PortOut, StpInfo

BACKEND = Path(__file__).resolve().parents[1]
BRIDGE_ID_RAW = bytes.fromhex("8000aabbccddeeff")


class _StubOctetString:
    def __init__(self, value=b"", hexValue=None):
        self._raw = bytes.fromhex(hexValue) if hexValue is not None else bytes(value)

    def __bytes__(self):
        return self._raw


# ---------------------------------------------------------------------------
# BridgeId parsing / formatting
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", [
    BRIDGE_ID_RAW,
    bytearray(BRIDGE_ID_RAW),
    _StubOctetString(BRIDGE_ID_RAW),
    "0x8000aabbccddeeff",
    "0x8000AABBCCDDEEFF",
    "80:00:aa:bb:cc:dd:ee:ff",
    "80 00 aa bb cc dd ee ff",
    "8000aabbccddeeff",
])
def test_parse_bridge_id_variants(value):
    assert parse_bridge_id(value) == "8000.aabbccddeeff"


@pytest.mark.parametrize("value", [None, b"", b"\x80\x00\xaa", "zz", "0x8000aabbccddeeff00"])
def test_parse_bridge_id_invalid(value):
    assert parse_bridge_id(value) is None


def test_parse_bridge_id_low_priority():
    assert parse_bridge_id(bytes.fromhex("1000001122334455")) == "1000.001122334455"


@pytest.mark.parametrize("priority, mac, expected", [
    (32768, bytes.fromhex("aabbccddeeff"), "8000.aabbccddeeff"),
    ("4096", _StubOctetString(bytes.fromhex("001122334455")), "1000.001122334455"),
    (0, "0x001122334455", "0000.001122334455"),
    (None, bytes.fromhex("aabbccddeeff"), None),
    (32768, b"\x01\x02", None),
    (32768, None, None),
    (70000, bytes.fromhex("aabbccddeeff"), None),
])
def test_build_bridge_id(priority, mac, expected):
    assert build_bridge_id(priority, mac) == expected


# ---------------------------------------------------------------------------
# State, role, protocol mapping
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value, expected", [
    (1, "disabled"), (2, "blocking"), (3, "listening"), (4, "learning"),
    (5, "forwarding"), (6, "broken"), ("5", "forwarding"), (0, None), (7, None),
    (None, None), ("x", None),
])
def test_stp_state_from(value, expected):
    assert stp_state_from(value) == expected


@pytest.mark.parametrize("state, is_root_port, expected", [
    (None, False, None),
    (None, True, None),
    ("disabled", True, "disabled"),
    ("disabled", False, "disabled"),
    ("forwarding", True, "root"),
    ("blocking", True, "root"),
    ("blocking", False, "blocked"),
    ("broken", False, "blocked"),
    ("forwarding", False, "designated"),
    ("learning", False, "designated"),
    ("listening", False, "designated"),
])
def test_derive_stp_role(state, is_root_port, expected):
    assert derive_stp_role(state, is_root_port) == expected


@pytest.mark.parametrize("version, spec, expected", [
    (0, 3, "stp"),
    (2, 3, "rstp"),
    (3, None, "mstp"),
    ("2", None, "rstp"),
    (None, 3, "stp"),
    (1, 3, "stp"),
    (None, 2, "unknown"),
    (None, None, "unknown"),
    (7, None, "unknown"),
])
def test_stp_protocol_from(version, spec, expected):
    assert stp_protocol_from(version, spec) == expected


# ---------------------------------------------------------------------------
# build_stp_info: root port resolution and missing MIB
# ---------------------------------------------------------------------------

_OIDS = dict(
    oid_priority="prio", oid_base_address="addr", oid_designated_root="root",
    oid_root_cost="cost", oid_root_port="rport", oid_version="ver", oid_protocol_spec="spec",
)
_STATE = "1.3.6.1.2.1.17.2.15.1.3"
_COST = "1.3.6.1.2.1.17.2.15.1.5"


def test_build_stp_info_resolves_root_port_name():
    scalars = {
        "prio": 32768, "addr": bytes.fromhex("aabbccddeeff"),
        "root": bytes.fromhex("1000001122334455"), "cost": 4, "rport": 2,
        "ver": 2, "spec": 3,
    }
    state_rows = [(f"{_STATE}.1", "5"), (f"{_STATE}.2", "5"), (f"{_STATE}.3", "2"),
                  (f"{_STATE}.4", "1"), (f"{_STATE}.9", "5")]
    cost_rows = [(f"{_COST}.1", "20000"), (f"{_COST}.2", "2000"), (f"{_COST}.3", "2000")]
    bridge_to_ifindex = {1: 101, 2: 102, 3: 103, 4: 104}  # bridge port 9 is unmapped
    names = {101: "1/1/1", 102: "1/1/2", 103: "1/1/3", 104: "1/1/4"}

    info, ports = build_stp_info(scalars, state_rows, cost_rows, bridge_to_ifindex, names, **_OIDS)

    assert info == {
        "protocol": "rstp", "bridge_id": "8000.aabbccddeeff", "root_id": "1000.001122334455",
        "root_cost": 4, "root_port": "1/1/2",
    }
    assert ports[101] == {"state": "forwarding", "role": "designated", "path_cost": 20000}
    assert ports[102] == {"state": "forwarding", "role": "root", "path_cost": 2000}
    assert ports[103] == {"state": "blocking", "role": "blocked", "path_cost": 2000}
    assert ports[104] == {"state": "disabled", "role": "disabled", "path_cost": None}
    assert set(ports) == {101, 102, 103, 104}


def test_build_stp_info_root_bridge_has_no_root_port():
    raw = bytes.fromhex("8000aabbccddeeff")
    scalars = {"prio": 32768, "addr": raw[2:], "root": raw, "cost": 0, "rport": 0, "ver": 0}
    info, _ = build_stp_info(scalars, [], [], {}, {}, **_OIDS)
    assert info["root_port"] is None
    assert info["bridge_id"] == info["root_id"] == "8000.aabbccddeeff"
    assert info["protocol"] == "stp"


def test_build_stp_info_unresolvable_root_port_is_none():
    scalars = {"root": BRIDGE_ID_RAW, "rport": 7}
    info, _ = build_stp_info(scalars, [], [], {1: 101}, {101: "x"}, **_OIDS)
    assert info["root_port"] is None
    assert info["protocol"] == "unknown"


@pytest.mark.parametrize("scalars", [{}, {"cost": 0, "rport": 0}, {"addr": "garbage", "root": b"\x01"}])
def test_build_stp_info_missing_mib_returns_none(scalars):
    info, ports = build_stp_info(scalars, [], [], {1: 101}, {101: "x"}, **_OIDS)
    assert info is None
    assert ports == {}


# ---------------------------------------------------------------------------
# VLAN names
# ---------------------------------------------------------------------------

def test_parse_vlan_names():
    base = "1.3.6.1.2.1.17.7.1.4.3.1.1"
    rows = [
        (f"{base}.1", "default"),
        (f"{base}.10", " Management "),
        (f"{base}.20", ""),
        (f"{base}.4095", "reserved"),
        (f"{base}.abc", "bad"),
        (f"{base}.99", "Guest"),
    ]
    assert parse_vlan_names(rows) == {"1": "default", "10": "Management", "99": "Guest"}
    assert parse_vlan_names([]) == {}


# ---------------------------------------------------------------------------
# Scanner hook
# ---------------------------------------------------------------------------

def test_supports_stp_hook():
    assert VendorScanner.supports_stp(GenericScanner()) is True
    assert GenericScanner().supports_stp() is True
    assert CiscoScanner().supports_stp() is True
    assert OPNsenseScanner().supports_stp() is False


# ---------------------------------------------------------------------------
# Scan path against pysnmp stand-ins
# ---------------------------------------------------------------------------

class _StubSnmpEngine:
    def close_dispatcher(self):
        pass


@pytest.fixture()
def scanner(monkeypatch):
    hlapi = types.ModuleType("pysnmp.hlapi.v3arch.asyncio")
    for name in ("USM_AUTH_HMAC96_MD5", "USM_AUTH_HMAC96_SHA", "USM_AUTH_HMAC128_SHA224",
                 "USM_AUTH_HMAC192_SHA256", "USM_AUTH_HMAC256_SHA384", "USM_AUTH_HMAC384_SHA512",
                 "USM_AUTH_NONE", "USM_PRIV_CBC56_DES", "USM_PRIV_CBC168_3DES", "USM_PRIV_CFB128_AES",
                 "USM_PRIV_CFB192_AES", "USM_PRIV_CFB256_AES", "USM_PRIV_NONE"):
        setattr(hlapi, name, name)
    hlapi.CommunityData = MagicMock()
    hlapi.UsmUserData = MagicMock()
    hlapi.SnmpEngine = _StubSnmpEngine
    for name in ("ContextData", "ObjectIdentity", "ObjectType", "UdpTransportTarget", "bulk_cmd", "get_cmd"):
        setattr(hlapi, name, MagicMock())
    rfc1902 = types.ModuleType("pysnmp.proto.rfc1902")
    rfc1902.OctetString = _StubOctetString
    rfc1905 = types.ModuleType("pysnmp.proto.rfc1905")
    for name in ("EndOfMibView", "NoSuchInstance", "NoSuchObject"):
        setattr(rfc1905, name, type(name, (), {}))
    for mod_name, mod in {
        "pysnmp.hlapi.v3arch": types.ModuleType("pysnmp.hlapi.v3arch"),
        "pysnmp.hlapi.v3arch.asyncio": hlapi,
        "pysnmp.proto": types.ModuleType("pysnmp.proto"),
        "pysnmp.proto.rfc1902": rfc1902,
        "pysnmp.proto.rfc1905": rfc1905,
    }.items():
        monkeypatch.setitem(sys.modules, mod_name, mod)

    spec = importlib.util.spec_from_file_location("_real_snmp_scanner_stp", BACKEND / "snmp_scanner.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _install_fakes(scanner, monkeypatch, sys_descr="generic switch", stp_scalars=None,
                   walks=None, get_values_exc=None, sys_oid="1.3.6.1.4.1.8072.3.2.10"):
    calls = {"get_values": 0, "walked": []}

    async def fake_get(ip, port, auth, *oids, **kw):
        return {
            scanner.OID_SYS_NAME: "sw1",
            scanner.OID_SYS_DESCR: sys_descr,
            scanner.OID_SYS_OBJECT_ID: sys_oid,
        }

    async def fake_get_raw(ip, port, auth, *oids, **kw):
        return {}

    async def fake_get_values(ip, port, auth, *oids, **kw):
        calls["get_values"] += 1
        calls["get_values_oids"] = oids
        if get_values_exc:
            raise get_values_exc
        return dict(stp_scalars or {})

    async def fake_walk(ip, port, auth, oid, **kw):
        calls["walked"].append(oid)
        return list((walks or {}).get(oid, []))

    async def fake_walk_raw(ip, port, auth, oid, **kw):
        return []

    monkeypatch.setattr(scanner, "snmp_get", fake_get)
    monkeypatch.setattr(scanner, "snmp_get_raw", fake_get_raw)
    monkeypatch.setattr(scanner, "snmp_get_values", fake_get_values)
    monkeypatch.setattr(scanner, "snmp_bulk_walk", fake_walk)
    monkeypatch.setattr(scanner, "snmp_bulk_walk_raw", fake_walk_raw)
    return calls


def _iface_walks(scanner):
    return {
        scanner.OID_IF_DESCR: [(f"{scanner.OID_IF_DESCR}.101", "1/1/1"),
                               (f"{scanner.OID_IF_DESCR}.102", "1/1/2")],
        scanner.OID_DOT1D_BASE_PORT_IF_INDEX: [(f"{scanner.OID_DOT1D_BASE_PORT_IF_INDEX}.1", "101"),
                                               (f"{scanner.OID_DOT1D_BASE_PORT_IF_INDEX}.2", "102")],
    }


def test_scan_collects_stp_and_vlan_names(scanner, monkeypatch):
    walks = _iface_walks(scanner)
    walks[scanner.OID_DOT1D_STP_PORT_STATE] = [(f"{scanner.OID_DOT1D_STP_PORT_STATE}.1", "5"),
                                               (f"{scanner.OID_DOT1D_STP_PORT_STATE}.2", "2")]
    walks[scanner.OID_DOT1D_STP_PORT_PATH_COST] = [(f"{scanner.OID_DOT1D_STP_PORT_PATH_COST}.1", "2000"),
                                                   (f"{scanner.OID_DOT1D_STP_PORT_PATH_COST}.2", "2000")]
    walks[scanner.OID_DOT1Q_VLAN_STATIC_NAME] = [(f"{scanner.OID_DOT1Q_VLAN_STATIC_NAME}.1", "default"),
                                                 (f"{scanner.OID_DOT1Q_VLAN_STATIC_NAME}.30", "VoIP")]
    scalars = {
        scanner.OID_DOT1D_STP_PRIORITY: 32768,
        scanner.OID_DOT1D_BASE_BRIDGE_ADDRESS: _StubOctetString(bytes.fromhex("aabbccddeeff")),
        scanner.OID_DOT1D_STP_DESIGNATED_ROOT: _StubOctetString(bytes.fromhex("1000001122334455")),
        scanner.OID_DOT1D_STP_ROOT_COST: 2000,
        scanner.OID_DOT1D_STP_ROOT_PORT: 1,
        scanner.OID_DOT1D_STP_VERSION: 2,
    }
    calls = _install_fakes(scanner, monkeypatch, stp_scalars=scalars, walks=walks)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="ports"))

    assert calls["get_values"] == 1
    assert set(calls["get_values_oids"]) == set(scanner.STP_SCALAR_OIDS)
    assert sw.stp == {
        "protocol": "rstp", "bridge_id": "8000.aabbccddeeff", "root_id": "1000.001122334455",
        "root_cost": 2000, "root_port": "1/1/1",
    }
    assert sw.vlan_names == {"1": "default", "30": "VoIP"}
    p1, p2 = sw.interfaces[101], sw.interfaces[102]
    assert (p1.stp_state, p1.stp_role, p1.stp_path_cost) == ("forwarding", "root", 2000)
    assert (p2.stp_state, p2.stp_role, p2.stp_path_cost) == ("blocking", "blocked", 2000)


def test_scan_without_stp_mib_leaves_none(scanner, monkeypatch):
    calls = _install_fakes(scanner, monkeypatch, stp_scalars={}, walks=_iface_walks(scanner))
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="ports"))
    assert sw is not None
    assert sw.stp is None and sw.vlan_names == {}
    assert all(i.stp_state is None and i.stp_role is None for i in sw.interfaces.values())
    # Per-port STP walks are skipped when no STP scalar answered
    assert scanner.OID_DOT1D_STP_PORT_STATE not in calls["walked"]


def test_scan_stp_errors_never_fail_scan(scanner, monkeypatch):
    _install_fakes(scanner, monkeypatch, walks=_iface_walks(scanner),
                   get_values_exc=RuntimeError("timeout"))
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="ports"))
    assert sw is not None and sw.stp is None and len(sw.interfaces) == 2


def test_scan_opnsense_skips_stp(scanner, monkeypatch):
    calls = _install_fakes(scanner, monkeypatch, sys_descr="OPNsense 24.1 FreeBSD 13.2",
                           stp_scalars={scanner.OID_DOT1D_STP_ROOT_COST: 0})
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="links"))
    assert sw.vendor == "opnsense"
    assert calls["get_values"] == 0
    assert sw.stp is None


def test_scan_discovery_skips_stp(scanner, monkeypatch):
    calls = _install_fakes(scanner, monkeypatch)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="discovery"))
    assert calls["get_values"] == 0 and sw.stp is None


def test_scan_mikrotik_reads_firmware_from_vendor_mib(scanner, monkeypatch):
    _install_fakes(scanner, monkeypatch, sys_descr="RouterOS CRS326-24G-2S+", sys_oid="1.3.6.1.4.1.14988.1")
    lic_version = "1.3.6.1.4.1.14988.1.1.4.4.0"

    async def fake_get(ip, port, auth, *oids, **kw):
        if lic_version in oids:
            return {lic_version: " 7.12.1 "}
        return {scanner.OID_SYS_NAME: "crs", scanner.OID_SYS_DESCR: "RouterOS CRS326-24G-2S+",
                scanner.OID_SYS_OBJECT_ID: "1.3.6.1.4.1.14988.1"}

    monkeypatch.setattr(scanner, "snmp_get", fake_get)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="discovery"))
    assert (sw.vendor, sw.device_type, sw.firmware) == ("mikrotik", "switch", "7.12.1")


def test_scan_watchguard_is_firewall_without_stp(scanner, monkeypatch):
    calls = _install_fakes(scanner, monkeypatch, sys_descr="WatchGuard Fireware v12.10.3",
                           sys_oid="1.3.6.1.4.1.3097.1.5", stp_scalars={scanner.OID_DOT1D_STP_ROOT_COST: 0})
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="links"))
    assert (sw.vendor, sw.device_type, sw.firmware) == ("watchguard", "firewall", "12.10.3")
    assert calls["get_values"] == 0 and sw.stp is None


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

_DEVICE_BASE = {"id": 1, "sys_name": "sw", "ip": "10.0.0.1", "last_seen": "2026-01-01T00:00:00"}


def test_device_out_without_stp():
    out = DeviceOut.model_validate(dict(_DEVICE_BASE, vlan_names=None)).model_dump(mode="json")
    assert out["stp"] is None
    assert out["vlan_names"] == {}
    # Raw STP columns stay hidden; stp_instances is the only stp_* output field.
    assert [k for k in out if k.startswith("stp_")] == ["stp_instances"]
    assert out["stp_instances"] == []


def test_device_out_with_stp_from_columns():
    out = DeviceOut.model_validate(dict(
        _DEVICE_BASE,
        stp_protocol="rstp", stp_bridge_id="8000.aabbccddeeff", stp_root_id="1000.001122334455",
        stp_root_cost=2000, stp_root_port="1/1/49", vlan_names={10: "Management"},
    )).model_dump(mode="json")
    assert out["stp"] == {
        "protocol": "rstp", "bridge_id": "8000.aabbccddeeff", "root_id": "1000.001122334455",
        "root_cost": 2000, "root_port": "1/1/49", "is_root": False,
    }
    assert out["vlan_names"] == {"10": "Management"}
    # Round trip (FastAPI response_model re-validation) keeps the value
    assert DeviceOut.model_validate(dict(_DEVICE_BASE, **{"stp": out["stp"]})).stp.root_port == "1/1/49"


@pytest.mark.parametrize("bridge_id, root_id, root_port, root_cost, expected", [
    ("8000.aabbccddeeff", "8000.aabbccddeeff", None, 0, True),
    ("8000.aabbccddeeff", "8000.aabbccddeeff", None, None, True),
    (None, "1000.001122334455", None, 0, True),
    ("8000.aabbccddeeff", "1000.001122334455", "1/1/1", 4, False),
    ("8000.aabbccddeeff", "1000.001122334455", None, 4, False),
])
def test_device_out_is_root(bridge_id, root_id, root_port, root_cost, expected):
    out = DeviceOut.model_validate(dict(
        _DEVICE_BASE, stp_protocol="stp", stp_bridge_id=bridge_id, stp_root_id=root_id,
        stp_root_port=root_port, stp_root_cost=root_cost,
    ))
    assert isinstance(out.stp, StpInfo)
    assert out.stp.is_root is expected


def test_device_out_from_orm(db):
    dev = Device(ip="10.0.0.2", sys_name="sw2", stp_protocol="mstp",
                 stp_bridge_id="8000.aabbccddeeff", stp_root_id="8000.aabbccddeeff",
                 stp_root_cost=0, vlan_names={"20": "Clients"})
    db.add(dev)
    db.flush()
    db.add(Port(device_id=dev.id, if_index=1, if_descr="1/1/1", stp_state="forwarding",
                stp_role="designated", stp_path_cost=20000))
    db.commit()
    db.refresh(dev)
    out = DeviceOut.model_validate(dev).model_dump(mode="json")
    assert out["stp"]["is_root"] is True and out["stp"]["protocol"] == "mstp"
    assert out["vlan_names"] == {"20": "Clients"}
    assert out["ports"][0]["stp_state"] == "forwarding"
    assert out["ports"][0]["stp_role"] == "designated"


def test_port_out_stp_defaults():
    out = PortOut.model_validate({"id": 1}).model_dump()
    assert out["stp_state"] is None and out["stp_role"] is None and out["stp_path_cost"] is None


def test_topology_endpoint_includes_stp(client, auth_headers, db):
    dev = Device(ip="10.0.0.3", sys_name="sw3", stp_protocol="rstp",
                 stp_bridge_id="8000.aabbccddeeff", stp_root_id="1000.001122334455",
                 stp_root_cost=4, stp_root_port="1/1/2", vlan_names={"1": "default"})
    db.add(dev)
    db.add(Device(ip="10.0.0.4", sys_name="sw4"))
    db.commit()
    import routers.topology as topo
    topo._set_topo_cache({})
    r = client.get("/api/v1/topology", headers=auth_headers)
    assert r.status_code == 200, r.text
    nodes = {n["ip"]: n for n in r.json()["nodes"]}
    assert nodes["10.0.0.3"]["stp"]["root_port"] == "1/1/2"
    assert nodes["10.0.0.3"]["vlan_names"] == {"1": "default"}
    assert nodes["10.0.0.4"]["stp"] is None
    assert nodes["10.0.0.4"]["vlan_names"] == {}


# ---------------------------------------------------------------------------
# Executor persistence
# ---------------------------------------------------------------------------

@pytest.fixture()
def executor_mod(monkeypatch):
    """Import the real scan_engine.executor despite the conftest package mock."""
    saved = {k: v for k, v in sys.modules.items() if k == "scan_engine" or k.startswith("scan_engine.")}
    for k in list(saved):
        sys.modules.pop(k, None)
    mod = importlib.import_module("scan_engine.executor")
    monkeypatch.setattr(mod, "extract_model", lambda descr, vendor: "")
    monkeypatch.setattr(mod, "auto_layout", lambda ips: {})
    monkeypatch.setattr(mod, "is_virtual", lambda descr, vendor: False)
    try:
        yield mod
    finally:
        for k in [k for k in sys.modules if k == "scan_engine" or k.startswith("scan_engine.")]:
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _iface(index, descr, state=None, role=None, cost=None):
    return types.SimpleNamespace(
        index=index, descr=descr, alias="", speed_mbps=1000, oper_status=1, vlan=1,
        tagged_vlans=[], stp_state=state, stp_role=role, stp_path_cost=cost,
    )


def _sw(ip, stp=None, vlan_names=None, interfaces=None):
    return types.SimpleNamespace(
        ip=ip, sys_name="sw", sys_descr="d", location="", firmware="", vendor="generic",
        interfaces=interfaces or {}, lldp_neighbors=[], arp_table={}, mac_ifindex={},
        engine_id="", stp=stp, vlan_names=vlan_names or {},
    )


def _finalize(executor_mod, db, switch_data, scan_mode):
    return executor_mod._finalize_scan_db(
        db,
        dry_run=False, scan_mode=scan_mode, corr="test", cancel_event=None,
        switch_data=switch_data,
        ping_by_ip={ip: (True, 1) for ip in switch_data},
        range_found_ips=[], range_matched_profile={}, range_no_profile_ips=[],
        errors=[], status="finished", total_duration_ms=1, scanned=len(switch_data),
        workers=1, switch_metrics=[], lock_token=None,
    )


_STP = {"protocol": "rstp", "bridge_id": "8000.aabbccddeeff", "root_id": "1000.001122334455",
        "root_cost": 2000, "root_port": "1/1/1"}


def test_executor_persists_stp_and_vlan_names(db, executor_mod):
    db.add(Device(ip="10.2.2.2", sys_name="sw"))
    db.commit()
    sw = _sw("10.2.2.2", stp=dict(_STP), vlan_names={"10": "Management"}, interfaces={
        1: _iface(1, "1/1/1", "forwarding", "root", 2000),
        2: _iface(2, "1/1/2", "blocking", "blocked", 2000),
        3: _iface(3, "1/1/3"),
    })
    _finalize(executor_mod, db, {"10.2.2.2": sw}, "ports")
    dev = db.query(Device).filter(Device.ip == "10.2.2.2").one()
    db.refresh(dev)
    assert (dev.stp_protocol, dev.stp_bridge_id, dev.stp_root_id, dev.stp_root_cost, dev.stp_root_port) == (
        "rstp", "8000.aabbccddeeff", "1000.001122334455", 2000, "1/1/1")
    assert dev.vlan_names == {"10": "Management"}
    ports = {p.if_descr: p for p in db.query(Port).filter(Port.device_id == dev.id).all()}
    assert (ports["1/1/1"].stp_state, ports["1/1/1"].stp_role, ports["1/1/1"].stp_path_cost) == (
        "forwarding", "root", 2000)
    assert ports["1/1/2"].stp_role == "blocked"
    assert ports["1/1/3"].stp_state is None and ports["1/1/3"].stp_role is None


def test_executor_creates_new_device_with_stp(db, executor_mod):
    _finalize(executor_mod, db, {"10.2.2.5": _sw("10.2.2.5", stp=dict(_STP), vlan_names={"1": "default"})},
              "links")
    dev = db.query(Device).filter(Device.ip == "10.2.2.5").one()
    assert dev.stp_bridge_id == "8000.aabbccddeeff" and dev.vlan_names == {"1": "default"}


def test_executor_clears_stale_stp(db, executor_mod):
    db.add(Device(ip="10.2.2.3", sys_name="sw", stp_protocol="stp", stp_bridge_id="8000.aabbccddeeff",
                  stp_root_id="8000.aabbccddeeff", stp_root_cost=0, stp_root_port="x",
                  vlan_names={"1": "default"}))
    db.commit()
    _finalize(executor_mod, db, {"10.2.2.3": _sw("10.2.2.3")}, "links")
    dev = db.query(Device).filter(Device.ip == "10.2.2.3").one()
    db.refresh(dev)
    assert dev.stp_protocol is None and dev.stp_bridge_id is None and dev.stp_root_id is None
    assert dev.stp_root_cost is None and dev.stp_root_port is None
    assert dev.vlan_names == {}


def test_executor_discovery_keeps_stp(db, executor_mod):
    db.add(Device(ip="10.2.2.4", sys_name="sw", stp_protocol="rstp", vlan_names={"1": "default"}))
    db.commit()
    _finalize(executor_mod, db, {"10.2.2.4": _sw("10.2.2.4")}, "discovery")
    dev = db.query(Device).filter(Device.ip == "10.2.2.4").one()
    db.refresh(dev)
    assert dev.stp_protocol == "rstp" and dev.vlan_names == {"1": "default"}


# ---------------------------------------------------------------------------
# Migration 019
# ---------------------------------------------------------------------------

def test_migration_019_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location(
        "_mig019", BACKEND / "alembic" / "versions" / "019_stp_vlan_names.py"
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "019" and mig.down_revision == "018"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY, ip VARCHAR)"))
        conn.execute(sa.text("CREATE TABLE ports (id INTEGER PRIMARY KEY, if_index INTEGER)"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        dev_cols = {c["name"] for c in sa.inspect(conn).get_columns("devices")}
        port_cols = {c["name"] for c in sa.inspect(conn).get_columns("ports")}
        assert {"stp_protocol", "stp_bridge_id", "stp_root_id", "stp_root_cost",
                "stp_root_port", "vlan_names"} <= dev_cols
        assert {"stp_state", "stp_role", "stp_path_cost"} <= port_cols
        mig.downgrade()
        assert {c["name"] for c in sa.inspect(conn).get_columns("devices")} == {"id", "ip"}
        assert {c["name"] for c in sa.inspect(conn).get_columns("ports")} == {"id", "if_index"}


def test_alembic_single_head():
    from alembic.script import ScriptDirectory

    script = ScriptDirectory(str(BACKEND / "alembic"))
    assert len(script.get_heads()) == 1
