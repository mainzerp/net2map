"""Interface name cache and configurable GETBULK size."""
import asyncio
from datetime import datetime, timedelta, timezone

from database import Device
from tests.test_stp_vlan import _finalize, _iface, _install_fakes, _sw, executor_mod, scanner  # noqa: F401


def _status_walks(scanner, indexes):  # noqa: F811
    return {
        scanner.OID_IF_OPER_STATUS: [(f"{scanner.OID_IF_OPER_STATUS}.{i}", "1") for i in indexes],
        scanner.OID_IF_HIGH_SPEED: [(f"{scanner.OID_IF_HIGH_SPEED}.{i}", "1000") for i in indexes],
        scanner.OID_IF_DESCR: [(f"{scanner.OID_IF_DESCR}.{i}", f"walked-{i}") for i in indexes],
        scanner.OID_IF_ALIAS: [(f"{scanner.OID_IF_ALIAS}.{i}", "") for i in indexes],
    }


def test_cached_names_skip_descr_and_alias_walks(scanner, monkeypatch):  # noqa: F811
    calls = _install_fakes(scanner, monkeypatch, walks=_status_walks(scanner, [101, 102]))
    cache = {101: ("1/1/1", "uplink"), 102: ("1/1/2", "")}

    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs", if_names=cache))

    assert scanner.OID_IF_DESCR not in calls["walked"]
    assert scanner.OID_IF_ALIAS not in calls["walked"]
    assert scanner.OID_IF_OPER_STATUS in calls["walked"]
    assert sw.interfaces[101].descr == "1/1/1" and sw.interfaces[101].alias == "uplink"
    assert sw.interfaces[102].speed_mbps == 1000
    assert sw.if_names_refreshed is False


def test_unknown_ifindex_walks_names_again(scanner, monkeypatch):  # noqa: F811
    calls = _install_fakes(scanner, monkeypatch, walks=_status_walks(scanner, [101, 103]))

    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="links", if_names={101: ("1/1/1", "")}))

    assert scanner.OID_IF_DESCR in calls["walked"] and scanner.OID_IF_ALIAS in calls["walked"]
    assert sw.interfaces[103].descr == "walked-103"
    assert sw.if_names_refreshed is True


def test_without_cache_names_are_walked(scanner, monkeypatch):  # noqa: F811
    calls = _install_fakes(scanner, monkeypatch, walks=_status_walks(scanner, [101]))

    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs"))

    assert scanner.OID_IF_DESCR in calls["walked"]
    assert sw.if_names_refreshed is True


def test_bulk_size_applies_per_scan_and_is_clamped(scanner, monkeypatch):  # noqa: F811
    _install_fakes(scanner, monkeypatch, walks=_status_walks(scanner, [101]))
    seen = []

    async def recording_walk(ip, port, auth, oid, **kw):
        seen.append(scanner._BULK_SIZE.get())
        return []

    monkeypatch.setattr(scanner, "snmp_bulk_walk", recording_walk)

    asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs", bulk_size=60))
    assert seen and set(seen) == {60}
    assert scanner._BULK_SIZE.get() == scanner.BULK_SIZE_DEFAULT

    seen.clear()
    asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs", bulk_size=500))
    assert set(seen) == {scanner.BULK_SIZE_MAX}
    assert scanner.clamp_bulk_size("x") == scanner.BULK_SIZE_DEFAULT


def test_finalize_stores_refreshed_names_and_cache_loads_them(db, executor_mod, monkeypatch):  # noqa: F811
    monkeypatch.setattr(executor_mod, "_read_db_setting", lambda key, default: "1800")
    db.add(Device(ip="10.3.3.3", sys_name="sw"))
    db.commit()
    sw = _sw("10.3.3.3", interfaces={1: _iface(1, "1/1/1"), 2: _iface(2, "1/1/2")})
    sw.if_names_refreshed = True

    _finalize(executor_mod, db, {"10.3.3.3": sw}, "ports")

    device = db.query(Device).filter_by(ip="10.3.3.3").one()
    assert device.if_names == {"1": ["1/1/1", ""], "2": ["1/1/2", ""]}
    assert executor_mod._load_if_name_cache(db) == {"10.3.3.3": {1: ("1/1/1", ""), 2: ("1/1/2", "")}}

    device.if_names_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
    db.commit()
    assert executor_mod._load_if_name_cache(db) == {}


def test_cache_kept_when_names_not_refreshed(db, executor_mod):  # noqa: F811
    stamp = datetime(2026, 1, 1)
    db.add(Device(ip="10.4.4.4", sys_name="sw", if_names={"1": ["a", ""]}, if_names_at=stamp))
    db.commit()

    _finalize(executor_mod, db, {"10.4.4.4": _sw("10.4.4.4", interfaces={1: _iface(1, "a")})}, "ports")

    device = db.query(Device).filter_by(ip="10.4.4.4").one()
    assert device.if_names == {"1": ["a", ""]} and device.if_names_at == stamp


# ---------------------------------------------------------------------------
# Separate VLAN / STP refresh intervals
# ---------------------------------------------------------------------------

def test_scan_skips_vlan_and_stp_when_not_requested(scanner, monkeypatch):  # noqa: F811
    calls = _install_fakes(scanner, monkeypatch, walks=_status_walks(scanner, [101]))

    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs", collect_vlan=False, collect_stp=False))

    for oid in (scanner.OID_DOT1Q_PVID, scanner.OID_DOT1Q_VLAN_STATIC_NAME,
                scanner.OID_DOT1D_STP_PORT_STATE, scanner.OID_DOT1D_STP_PORT_PATH_COST):
        assert oid not in calls["walked"]
    assert calls["get_values"] == 0
    assert sw.vlan_collected is False and sw.stp_collected is False


def test_scan_collects_only_requested_part(scanner, monkeypatch):  # noqa: F811
    calls = _install_fakes(scanner, monkeypatch, walks=_status_walks(scanner, [101]))

    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="macs", collect_vlan=True, collect_stp=False))

    assert scanner.OID_DOT1Q_PVID in calls["walked"]
    assert scanner.OID_DOT1Q_VLAN_STATIC_NAME in calls["walked"]
    assert calls["get_values"] == 0
    assert sw.vlan_collected is True and sw.stp_collected is False


def test_plan_vlan_stp_collection(db, executor_mod, monkeypatch):  # noqa: F811
    settings = {"vlan_update_interval_sec": "1800", "stp_update_interval_sec": "300"}
    monkeypatch.setattr(executor_mod, "_read_db_setting", lambda key, default: settings.get(key, default))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add_all([
        Device(ip="10.5.0.1", sys_name="fresh", vlan_at=now, stp_at=now),
        Device(ip="10.5.0.2", sys_name="stale", vlan_at=now - timedelta(hours=1), stp_at=now - timedelta(minutes=10)),
        Device(ip="10.5.0.3", sys_name="never"),
    ])
    db.commit()

    plan = executor_mod._plan_vlan_stp_collection(db, "macs")
    assert plan["10.5.0.1"] == (False, False)
    assert plan["10.5.0.2"] == (True, True)
    assert plan["10.5.0.3"] == (True, True)
    assert executor_mod._plan_vlan_stp_collection(db, "full") == {}
    assert set(executor_mod._plan_vlan_stp_collection(db, "links").values()) == {(False, False)}

    settings["vlan_update_interval_sec"] = "0"
    assert executor_mod._plan_vlan_stp_collection(db, "macs")["10.5.0.3"] == (False, True)


def test_finalize_keeps_stored_vlan_and_stp_when_not_collected(db, executor_mod):  # noqa: F811
    from database import Port

    stamp = datetime(2026, 1, 1)
    device = Device(ip="10.6.6.6", sys_name="sw", stp_protocol="rstp", stp_root_port="1/1/1",
                    vlan_names={"10": "Mgmt"}, vlan_at=stamp, stp_at=stamp)
    db.add(device)
    db.flush()
    db.add(Port(device_id=device.id, if_index=1, if_descr="1/1/1", vlan=10, tagged_vlans=[20, 30],
                stp_state="forwarding", stp_role="root", stp_path_cost=2000))
    db.commit()

    iface = _iface(1, "1/1/1")
    iface.vlan, iface.tagged_vlans = 0, []
    sw = _sw("10.6.6.6", interfaces={1: iface})
    sw.vlan_collected = False
    sw.stp_collected = False

    _finalize(executor_mod, db, {"10.6.6.6": sw}, "macs")

    db.expire_all()
    device = db.query(Device).filter_by(ip="10.6.6.6").one()
    port = db.query(Port).filter_by(device_id=device.id, if_index=1).one()
    assert (port.vlan, port.tagged_vlans) == (10, [20, 30])
    assert (port.stp_state, port.stp_role, port.stp_path_cost) == ("forwarding", "root", 2000)
    assert device.stp_protocol == "rstp" and device.vlan_names == {"10": "Mgmt"}
    assert device.vlan_at == stamp and device.stp_at == stamp


def test_finalize_overwrites_and_stamps_when_collected(db, executor_mod):  # noqa: F811
    db.add(Device(ip="10.7.7.7", sys_name="sw", stp_protocol="rstp", vlan_names={"10": "Mgmt"}))
    db.commit()

    _finalize(executor_mod, db, {"10.7.7.7": _sw("10.7.7.7", vlan_names={"30": "VoIP"})}, "macs")

    device = db.query(Device).filter_by(ip="10.7.7.7").one()
    assert device.stp_protocol is None and device.vlan_names == {"30": "VoIP"}
    assert device.vlan_at is not None and device.stp_at is not None
