"""Multiple spanning tree instances (IEEE8021-MSTP-MIB): parsing, scan,
persistence, schemas and migration 030."""
import asyncio
import importlib.util

import sqlalchemy as sa

from database import Device, Port
from scanners.parsing import build_mstp_info, vlan_ranges
from schemas import DeviceOut, PortOut
from tests.test_stp_vlan import (  # noqa: F401
    BACKEND,
    _finalize,
    _iface,
    _iface_walks,
    _install_fakes,
    _StubOctetString,
    _sw,
    executor_mod,
    scanner,
)

E = "1.3.111.2.802.1.1.6.1.2.1"
S = "1.3.111.2.802.1.1.6.1.4.1.5"
R = "1.3.111.2.802.1.1.6.1.4.1.12"


def _vids(*set_bytes):
    data = bytearray(128)
    for idx, val in set_bytes:
        data[idx] = val
    return bytes(data)


TABLE_RAW = [
    (f"{E}.3.1.1", bytes.fromhex("1001aabbccddeeff")),
    (f"{E}.3.1.2", bytes.fromhex("2002aabbccddeeff")),
    (f"{E}.7.1.1", bytes.fromhex("1001aabbccddeeff")),
    (f"{E}.7.1.2", bytes.fromhex("1002001122334455")),
    (f"{E}.11.1.1", _vids((1, 0x30))),        # VLAN 10, 11
    (f"{E}.12.1.2", _vids((0, 0x02))),        # VLAN 1024 + 6
    (f"{E}.3.2.1", bytes.fromhex("9001aabbccddeeff")),  # second component: ignored
]
TABLE_ROWS = [
    (f"{E}.8.1.1", "0"), (f"{E}.9.1.1", "0"),
    (f"{E}.8.1.2", "20000"), (f"{E}.9.1.2", "2"),
]
STATE_ROWS = [(f"{S}.1.1.1", "4"), (f"{S}.1.1.2", "4"), (f"{S}.1.2.1", "5"), (f"{S}.1.2.2", "4"), (f"{S}.1.2.3", "1")]
ROLE_ROWS = [(f"{R}.1.1.1", "3"), (f"{R}.1.1.2", "3"), (f"{R}.1.2.1", "2"), (f"{R}.1.2.2", "1"), (f"{R}.1.2.3", "3")]
BP_TO_IF = {1: 101, 2: 102, 3: 103}
NAMES = {101: "1/1/1", 102: "1/1/2", 103: "1/1/3"}


def _build(**overrides):
    args = dict(table_raw=TABLE_RAW, table_rows=TABLE_ROWS, port_state_rows=STATE_ROWS, port_role_rows=ROLE_ROWS)
    args.update(overrides)
    return build_mstp_info(
        args["table_raw"], args["table_rows"], args["port_state_rows"], args["port_role_rows"], BP_TO_IF, NAMES,
        table_entry_oid=E, port_state_oid=S, port_role_oid=R,
    )


def test_vlan_ranges():
    assert vlan_ranges([30, 10, 11, 12, 12]) == "10-12,30"
    assert vlan_ranges([]) == ""


def test_build_mstp_info_instances_and_ports():
    instances, per_ifindex = _build()
    assert instances == [
        {"id": 1, "bridge_id": "1001.aabbccddeeff", "root_id": "1001.aabbccddeeff", "root_cost": 0,
         "root_port": None, "vlans": "10-11"},
        {"id": 2, "bridge_id": "2002.aabbccddeeff", "root_id": "1002.001122334455", "root_cost": 20000,
         "root_port": "1/1/2", "vlans": "1030"},
    ]
    assert per_ifindex[101] == {"1": {"state": "forwarding", "role": "designated"},
                                "2": {"state": "blocking", "role": "blocked"}}
    assert per_ifindex[102]["2"] == {"state": "forwarding", "role": "root"}
    # A disabled port is "disabled" whatever role the agent reports.
    assert per_ifindex[103] == {"2": {"state": "disabled", "role": "disabled"}}


def test_build_mstp_info_without_mib_is_empty():
    assert _build(table_raw=[], table_rows=[], port_state_rows=[], port_role_rows=[]) == ([], {})


def test_build_mstp_info_ignores_malformed_rows():
    instances, per_ifindex = _build(
        table_raw=[(f"{E}.3.1", b"x"), ("1.3.6.1.2.1.1", b"x"), (f"{E}.3.1.0", bytes(8))],
        table_rows=[(f"{E}.8.1.x", "1")],
        port_state_rows=[(f"{S}.1.1.99", "4")],  # unknown bridge port
        port_role_rows=[],
    )
    assert instances == [] and per_ifindex == {}


def test_scan_collects_mstp_instances(scanner, monkeypatch):  # noqa: F811
    walks = _iface_walks(scanner)
    walks[scanner.OID_MSTP_ENTRY] = TABLE_ROWS
    walks[scanner.OID_MSTP_PORT_STATE] = [(o, v) for o, v in STATE_ROWS if not o.endswith(".3")]
    walks[scanner.OID_MSTP_PORT_ROLE] = [(o, v) for o, v in ROLE_ROWS if not o.endswith(".3")]
    walks[scanner.OID_DOT1D_STP_PORT_STATE] = [(f"{scanner.OID_DOT1D_STP_PORT_STATE}.1", "5")]
    scalars = {
        scanner.OID_DOT1D_STP_PRIORITY: 32768,
        scanner.OID_DOT1D_BASE_BRIDGE_ADDRESS: _StubOctetString(bytes.fromhex("aabbccddeeff")),
        scanner.OID_DOT1D_STP_VERSION: 3,
    }
    calls = _install_fakes(scanner, monkeypatch, stp_scalars=scalars, walks=walks)

    async def fake_walk_raw(ip, port, auth, oid, **kw):
        return list(TABLE_RAW) if oid == scanner.OID_MSTP_ENTRY else []

    monkeypatch.setattr(scanner, "snmp_bulk_walk_raw", fake_walk_raw)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="ports"))
    assert sw.stp["protocol"] == "mstp"
    assert [i["id"] for i in sw.stp_instances] == [1, 2]
    assert sw.interfaces[101].stp_instances["2"] == {"state": "blocking", "role": "blocked"}
    assert scanner.OID_MSTP_PORT_ROLE in calls["walked"]


def test_scan_rstp_skips_mstp_walks(scanner, monkeypatch):  # noqa: F811
    scalars = {scanner.OID_DOT1D_STP_PRIORITY: 32768,
               scanner.OID_DOT1D_BASE_BRIDGE_ADDRESS: _StubOctetString(bytes.fromhex("aabbccddeeff")),
               scanner.OID_DOT1D_STP_VERSION: 2}
    calls = _install_fakes(scanner, monkeypatch, stp_scalars=scalars, walks=_iface_walks(scanner))
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="ports"))
    assert sw.stp_instances == []
    assert scanner.OID_MSTP_PORT_STATE not in calls["walked"]


def test_executor_persists_mstp_instances(db, executor_mod):  # noqa: F811
    db.add(Device(ip="10.2.3.1", sys_name="sw"))
    db.commit()
    iface = _iface(1, "1/1/1", "forwarding", "designated", 2000)
    iface.stp_instances = {"2": {"state": "blocking", "role": "blocked"}}
    sw = _sw("10.2.3.1", stp={"protocol": "mstp", "bridge_id": "8000.aabbccddeeff", "root_id": None,
                              "root_cost": None, "root_port": None}, interfaces={1: iface, 2: _iface(2, "1/1/2")})
    sw.stp_instances = [{"id": 2, "bridge_id": "2002.aabbccddeeff", "root_id": "2002.aabbccddeeff",
                         "root_cost": 0, "root_port": None, "vlans": "10-20"}]
    _finalize(executor_mod, db, {"10.2.3.1": sw}, "ports")
    dev = db.query(Device).filter(Device.ip == "10.2.3.1").one()
    db.refresh(dev)
    assert dev.stp_instances[0]["vlans"] == "10-20"
    ports = {p.if_descr: p for p in db.query(Port).filter(Port.device_id == dev.id).all()}
    assert ports["1/1/1"].stp_instances == {"2": {"state": "blocking", "role": "blocked"}}
    assert ports["1/1/2"].stp_instances is None

    out = DeviceOut.model_validate(dev)
    assert out.stp_instances[0].is_root is True and out.stp_instances[0].id == 2
    port_out = next(p for p in out.ports if p.if_descr == "1/1/1")
    assert port_out.stp_instances["2"].role == "blocked"

    # Not reported anymore -> cleared
    _finalize(executor_mod, db, {"10.2.3.1": _sw("10.2.3.1")}, "links")
    db.refresh(dev)
    assert dev.stp_instances is None


def test_schemas_tolerate_bad_stp_instances():
    base = {"id": 1, "sys_name": "sw", "ip": "10.0.0.1", "last_seen": "2026-01-01T00:00:00"}
    assert DeviceOut.model_validate({**base, "stp_instances": None}).stp_instances == []
    assert DeviceOut.model_validate({**base, "stp_instances": [{"x": 1}, "y"]}).stp_instances == []
    assert PortOut.model_validate({"id": 1, "stp_instances": ["bad"]}).stp_instances is None


def test_migration_030_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location("_mig030", BACKEND / "alembic" / "versions" / "030_mstp_instances.py")
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "030" and mig.down_revision == "029"
    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE devices (id INTEGER PRIMARY KEY)"))
        conn.execute(sa.text("CREATE TABLE ports (id INTEGER PRIMARY KEY)"))
        mig.op = Operations(MigrationContext.configure(conn))
        mig.upgrade()
        assert "stp_instances" in {c["name"] for c in sa.inspect(conn).get_columns("devices")}
        assert "stp_instances" in {c["name"] for c in sa.inspect(conn).get_columns("ports")}
        mig.downgrade()
        assert {c["name"] for c in sa.inspect(conn).get_columns("ports")} == {"id"}
