"""SNMP engine ID discovery, persistence and manual override.

conftest mocks pysnmp and snmp_scanner wholesale, so the real snmp_scanner
module is loaded here against small pysnmp stand-ins (the real PySNMP
behaviour is covered by tests/_snmp_driver_probe.py on CI).
"""
import asyncio
import importlib
import importlib.util
import logging
import sys
import types
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa

from database import AuditLog, Credential, Device
from schemas import CredentialCreate, CredentialUpdate, normalize_engine_id

BACKEND = Path(__file__).resolve().parents[1]
ENGINE_HEX = "80000b85030011223344ff"


# ---------------------------------------------------------------------------
# Schema normalization / validation
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw, expected", [
    (ENGINE_HEX, ENGINE_HEX),
    ("0x80000B85030011223344FF", ENGINE_HEX),
    ("80:00:0b:85:03:00:11:22:33:44:ff", ENGINE_HEX),
    ("80 00 0b 85 03 00 11 22 33 44 ff", ENGINE_HEX),
    ("0102030405", "0102030405"),          # 5 octets (minimum)
    ("ab" * 32, "ab" * 32),                 # 32 octets (maximum)
    ("", None),
    ("  ", None),
    ("0x", None),
    (None, None),
])
def test_normalize_engine_id_valid(raw, expected):
    assert normalize_engine_id(raw) == expected


@pytest.mark.parametrize("raw", [
    "800000000",        # odd length
    "01020304",         # 4 octets: too short
    "ab" * 33,          # 33 octets: too long
    "80000b85zz",       # non-hex
    "0x0x0102030405",   # double prefix
])
def test_normalize_engine_id_invalid(raw):
    with pytest.raises(ValueError):
        normalize_engine_id(raw)


def test_schema_models_normalize_engine_id():
    c = CredentialCreate(label="a", ip="10.0.0.1", snmp_version="v3", v3_engine_id="0x80:00:0B:85:03")
    assert c.v3_engine_id == "80000b8503"
    u = CredentialUpdate(v3_engine_id="")
    assert u.v3_engine_id is None
    assert "v3_engine_id" in u.model_dump(exclude_unset=True)


@pytest.fixture()
def _no_rate_limit():
    import routers.credentials as _c
    _c.limiter.reset()
    yield
    _c.limiter.reset()


def test_api_engine_id_roundtrip(client, auth_headers, _no_rate_limit):
    r = client.post("/api/v1/credentials", json={
        "label": "v3", "ip": "10.0.0.5", "snmp_version": "v3",
        "v3_engine_id": "0x80:00:0B:85:03:00:11:22:33:44:FF",
    }, headers=auth_headers)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["v3_engine_id"] == ENGINE_HEX
    assert data["discovered_engine_id"] is None
    assert data["engine_id_seen_at"] is None

    # Discovered fields are read-only (ignored on update), override can be cleared.
    r = client.put(f"/api/v1/credentials/{data['id']}", json={
        "v3_engine_id": "", "discovered_engine_id": "deadbeefdead",
    }, headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["v3_engine_id"] is None
    assert r.json()["discovered_engine_id"] is None


@pytest.mark.parametrize("bad", ["123", "01020304", "ab" * 33, "xyz0102030405"])
def test_api_engine_id_invalid_rejected(client, auth_headers, _no_rate_limit, bad):
    r = client.post("/api/v1/credentials", json={
        "label": "v3", "ip": "10.0.0.6", "snmp_version": "v3", "v3_engine_id": bad,
    }, headers=auth_headers)
    assert r.status_code == 422, r.text

    ok = client.post("/api/v1/credentials", json={"label": "x", "ip": "10.0.0.7"}, headers=auth_headers)
    r = client.put(f"/api/v1/credentials/{ok.json()['id']}", json={"v3_engine_id": bad}, headers=auth_headers)
    assert r.status_code == 422, r.text


# ---------------------------------------------------------------------------
# Migration 018 on SQLite
# ---------------------------------------------------------------------------

def test_migration_018_upgrade_downgrade_sqlite():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    spec = importlib.util.spec_from_file_location(
        "_mig018", BACKEND / "alembic" / "versions" / "018_credential_engine_id.py"
    )
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "018" and mig.down_revision == "017"

    eng = sa.create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE credentials (id INTEGER PRIMARY KEY, ip VARCHAR)"))
        ops = Operations(MigrationContext.configure(conn))
        mig.op = ops
        mig.upgrade()
        cols = {c["name"] for c in sa.inspect(conn).get_columns("credentials")}
        assert {"v3_engine_id", "discovered_engine_id", "engine_id_seen_at"} <= cols
        mig.downgrade()
        cols = {c["name"] for c in sa.inspect(conn).get_columns("credentials")}
        assert cols == {"id", "ip"}


# ---------------------------------------------------------------------------
# Real snmp_scanner against pysnmp stand-ins
# ---------------------------------------------------------------------------

class _StubOctetString:
    def __init__(self, value=b"", hexValue=None):
        self._raw = bytes.fromhex(hexValue) if hexValue is not None else bytes(value)

    def __bytes__(self):
        return self._raw


class _StubUsmUserData:
    def __init__(self, userName, authKey=None, privKey=None, authProtocol=None,
                 privProtocol=None, securityEngineId=None, **kw):
        self.userName = userName
        self.authKey = authKey
        self.privKey = privKey
        self.authProtocol = authProtocol
        self.privProtocol = privProtocol
        self.securityEngineId = securityEngineId


class _StubCommunityData:
    def __init__(self, community, mpModel=1):
        self.communityName = community
        self.mpModel = mpModel


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
    hlapi.CommunityData = _StubCommunityData
    hlapi.UsmUserData = _StubUsmUserData
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

    spec = importlib.util.spec_from_file_location("_real_snmp_scanner", BACKEND / "snmp_scanner.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_auth_passes_security_engine_id(scanner):
    for level in ("noAuthNoPriv", "authNoPriv", "authPriv"):
        auth = scanner.build_auth("v3", v3_username="u", v3_security_level=level,
                                  v3_auth_password="a" * 8, v3_priv_password="p" * 8,
                                  v3_engine_id=ENGINE_HEX)
        assert isinstance(auth, _StubUsmUserData)
        assert bytes(auth.securityEngineId) == bytes.fromhex(ENGINE_HEX)


def test_build_auth_without_override_has_no_engine_id(scanner):
    auth = scanner.build_auth("v3", v3_username="u", v3_auth_password="a" * 8, v3_priv_password="p" * 8)
    assert auth.securityEngineId is None
    v2 = scanner.build_auth("v2c", community="c", v3_engine_id=ENGINE_HEX)
    assert isinstance(v2, _StubCommunityData)


def test_engine_id_to_hex(scanner):
    assert scanner.engine_id_to_hex(_StubOctetString(bytes.fromhex(ENGINE_HEX))) == ENGINE_HEX
    assert scanner.engine_id_to_hex(b"\x01\x02") == ""
    assert scanner.engine_id_to_hex(None) == ""
    assert scanner.engine_id_to_hex(b"\x01" * 33) == ""


def test_is_engine_id_error(scanner):
    assert scanner.is_engine_id_error("Unknown SNMP engine ID encountered")
    assert scanner.is_engine_id_error("SNMP message timing parameters not in windows of trust")
    assert scanner.is_engine_id_error("Wrong SNMP PDU digest")
    assert scanner.is_engine_id_error("Unknown SNMP security name encountered")
    assert not scanner.is_engine_id_error("No SNMP response received before timeout")
    assert not scanner.is_engine_id_error(None)


def _fake_scalars(scanner):
    return {
        scanner.OID_SYS_NAME: "sw1",
        scanner.OID_SYS_DESCR: "generic switch",
        scanner.OID_SYS_LOCATION: "lab",
        scanner.OID_SYS_OBJECT_ID: "1.3.6.1.4.1.9999",
    }


def test_scan_switch_reads_engine_id(scanner, monkeypatch):
    calls = {}

    async def fake_get(ip, port, auth, *oids, **kw):
        return _fake_scalars(scanner)

    async def fake_get_raw(ip, port, auth, *oids, **kw):
        calls["oids"] = oids
        calls["engine"] = kw.get("engine")
        return {scanner.OID_SNMP_ENGINE_ID: bytes(_StubOctetString(hexValue=ENGINE_HEX.upper()))}

    monkeypatch.setattr(scanner, "snmp_get", fake_get)
    monkeypatch.setattr(scanner, "snmp_get_raw", fake_get_raw)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", snmp_version="v3", v3_username="u",
                                         v3_auth_password="a" * 8, v3_priv_password="p" * 8,
                                         scan_type="discovery"))
    assert sw.engine_id == ENGINE_HEX
    assert calls["oids"] == (scanner.OID_SNMP_ENGINE_ID,)
    assert isinstance(calls["engine"], _StubSnmpEngine)  # same per-scan engine


def test_scan_switch_engine_id_missing_is_empty(scanner, monkeypatch):
    async def fake_get(ip, port, auth, *oids, **kw):
        return _fake_scalars(scanner)

    async def fake_get_raw(ip, port, auth, *oids, **kw):
        return {}

    monkeypatch.setattr(scanner, "snmp_get", fake_get)
    monkeypatch.setattr(scanner, "snmp_get_raw", fake_get_raw)
    sw = asyncio.run(scanner.scan_switch("10.0.0.1", scan_type="discovery"))
    assert sw is not None and sw.engine_id == ""


def test_scan_switch_override_failure_warns(scanner, monkeypatch, caplog):
    async def fake_get(ip, port, auth, *oids, error_sink=None, **kw):
        error_sink.append("Unknown SNMP engine ID encountered")
        return {}

    monkeypatch.setattr(scanner, "snmp_get", fake_get)
    with caplog.at_level(logging.WARNING):
        sw = asyncio.run(scanner.scan_switch("10.0.0.9", snmp_version="v3", v3_username="u",
                                             v3_auth_password="a" * 8, v3_priv_password="p" * 8,
                                             v3_engine_id=ENGINE_HEX, scan_type="discovery"))
    assert sw is None
    msgs = [r.getMessage() for r in caplog.records if "engine ID override" in r.getMessage()]
    assert len(msgs) == 1 and "10.0.0.9" in msgs[0] and "clearing" in msgs[0]


def test_scan_switch_no_override_no_engine_warning(scanner, monkeypatch, caplog):
    async def fake_get(ip, port, auth, *oids, error_sink=None, **kw):
        error_sink.append("Unknown SNMP engine ID encountered")
        return {}

    monkeypatch.setattr(scanner, "snmp_get", fake_get)
    with caplog.at_level(logging.WARNING):
        asyncio.run(scanner.scan_switch("10.0.0.9", snmp_version="v3", scan_type="discovery"))
    assert not any("engine ID override" in r.getMessage() for r in caplog.records)


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
    try:
        yield mod
    finally:
        for k in [k for k in sys.modules if k == "scan_engine" or k.startswith("scan_engine.")]:
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _sw(ip, engine_id):
    return types.SimpleNamespace(
        ip=ip, sys_name="sw", sys_descr="d", location="", firmware="", vendor="generic",
        interfaces={}, lldp_neighbors=[], arp_table={}, mac_ifindex={}, engine_id=engine_id,
    )


def _finalize(executor_mod, db, switch_data, working):
    return executor_mod._finalize_scan_db(
        db,
        dry_run=False, scan_mode="discovery", corr="test", cancel_event=None,
        switch_data=switch_data,
        ping_by_ip={ip: (True, 1) for ip in switch_data},
        range_found_ips=[], range_matched_profile={}, range_no_profile_ips=[],
        errors=[], status="finished", total_duration_ms=1, scanned=len(switch_data),
        workers=1, switch_metrics=[], lock_token=None,
        working_cred_by_ip=working,
    )


def _setup_cred(db, ip="10.1.1.1", discovered=None):
    db.add(Device(ip=ip, sys_name="sw"))
    primary = Credential(label="p", ip=ip, priority=0, snmp_version="v3", discovered_engine_id=discovered)
    fallback = Credential(label="f", ip=ip, priority=1, snmp_version="v3")
    db.add_all([primary, fallback])
    db.commit()
    return primary, fallback


def test_executor_stores_discovered_engine_id_on_working_cred(db, executor_mod):
    primary, fallback = _setup_cred(db)
    _finalize(executor_mod, db, {"10.1.1.1": _sw("10.1.1.1", ENGINE_HEX)}, {"10.1.1.1": fallback.id})
    db.refresh(primary)
    db.refresh(fallback)
    assert fallback.discovered_engine_id == ENGINE_HEX
    assert isinstance(fallback.engine_id_seen_at, datetime)
    assert primary.discovered_engine_id is None
    assert db.query(AuditLog).count() == 0


def test_executor_engine_id_change_warns_and_audits(db, executor_mod, caplog):
    primary, _ = _setup_cred(db, discovered="8000000001020304")
    with caplog.at_level(logging.WARNING, logger="scan_engine.executor"):
        _finalize(executor_mod, db, {"10.1.1.1": _sw("10.1.1.1", ENGINE_HEX)}, {"10.1.1.1": primary.id})
    db.refresh(primary)
    assert primary.discovered_engine_id == ENGINE_HEX
    assert any(
        "SNMP engine ID changed for 10.1.1.1: 8000000001020304 -> " + ENGINE_HEX in r.getMessage()
        for r in caplog.records
    )
    audit = db.query(AuditLog).filter(AuditLog.action == "engine_id_changed").one()
    assert audit.resource == "credential" and audit.resource_id == str(primary.id)
    assert audit.details["old"] == "8000000001020304" and audit.details["new"] == ENGINE_HEX


def test_executor_unchanged_engine_id_only_updates_seen_at(db, executor_mod, caplog):
    primary, _ = _setup_cred(db, discovered=ENGINE_HEX)
    primary.engine_id_seen_at = datetime(2020, 1, 1)
    db.commit()
    with caplog.at_level(logging.WARNING, logger="scan_engine.executor"):
        _finalize(executor_mod, db, {"10.1.1.1": _sw("10.1.1.1", ENGINE_HEX)}, {"10.1.1.1": primary.id})
    db.refresh(primary)
    assert primary.discovered_engine_id == ENGINE_HEX
    assert primary.engine_id_seen_at > datetime(2020, 1, 1)
    assert not any("engine ID changed" in r.getMessage() for r in caplog.records)
    assert db.query(AuditLog).count() == 0


def test_executor_empty_engine_id_keeps_stored_value(db, executor_mod):
    primary, _ = _setup_cred(db, discovered=ENGINE_HEX)
    _finalize(executor_mod, db, {"10.1.1.1": _sw("10.1.1.1", "")}, {"10.1.1.1": primary.id})
    db.refresh(primary)
    assert primary.discovered_engine_id == ENGINE_HEX
    assert primary.engine_id_seen_at is None
