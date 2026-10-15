"""SNMP scanner - SNMPv2c / SNMPv3, vendor-aware (Aruba CX + FS.com + generic).

Fully async: all SNMP I/O uses pysnmp.hlapi.v3arch.asyncio so the event loop is
never blocked. scan_switch() is now a coroutine; call it with await.
"""
import asyncio
import logging
import math
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

from pysnmp.hlapi.v3arch.asyncio import (
    USM_AUTH_HMAC96_MD5,
    USM_AUTH_HMAC96_SHA,
    USM_AUTH_HMAC128_SHA224,
    USM_AUTH_HMAC192_SHA256,
    USM_AUTH_HMAC256_SHA384,
    USM_AUTH_HMAC384_SHA512,
    USM_AUTH_NONE,
    USM_PRIV_CBC56_DES,
    USM_PRIV_CBC168_3DES,
    USM_PRIV_CFB128_AES,
    USM_PRIV_CFB192_AES,
    USM_PRIV_CFB256_AES,
    USM_PRIV_NONE,
    CommunityData,
    ContextData,
    ObjectIdentity,
    ObjectType,
    SnmpEngine,
    UdpTransportTarget,
    UsmUserData,
    bulk_cmd,
    get_cmd,
)
from pysnmp.proto.rfc1902 import OctetString
from pysnmp.proto.rfc1905 import EndOfMibView, NoSuchInstance, NoSuchObject

# Vendor detection and pure parsing helpers live in pysnmp-free modules so
# they stay unit-testable without pysnmp.
from scanners.detection import detect_vendor
from scanners.health import OID_UPS_IDENT_MANUFACTURER, collect_ups_health
from scanners.parsing import (
    build_mstp_info,
    build_stp_info,
    mac_from_octets,
    map_lldp_local_ports,
    parse_vlan_names,
    resolve_fdb_candidates,
)

log = logging.getLogger(__name__)


# --- SNMP enums ---------------------------------------------------------------

class SnmpVersion(str, Enum):
    V2C = "v2c"
    V3 = "v3"


class SecurityLevel(str, Enum):
    NO_AUTH_NO_PRIV = "noAuthNoPriv"
    AUTH_NO_PRIV = "authNoPriv"
    AUTH_PRIV = "authPriv"


class Vendor(str, Enum):
    ARUBA_CX = "aruba_cx"
    FS = "fs"
    UNIFI = "unifi"
    OPNSENSE = "opnsense"
    CISCO = "cisco"
    MIKROTIK = "mikrotik"
    WATCHGUARD = "watchguard"
    EATON = "eaton"
    HPE_UPS = "hpe_ups"
    HPE_ILO = "hpe_ilo"
    GENERIC = "generic"


# --- Protocol maps ------------------------------------------------------------

AUTH_PROTOCOLS = {
    "MD5":    USM_AUTH_HMAC96_MD5,
    "SHA":    USM_AUTH_HMAC96_SHA,
    "SHA-224": USM_AUTH_HMAC128_SHA224,
    "SHA-256": USM_AUTH_HMAC192_SHA256,  # "192" in the constant name refers to HMAC key size, not hash size
    "SHA-384": USM_AUTH_HMAC256_SHA384,
    "SHA-512": USM_AUTH_HMAC384_SHA512,
}

PRIV_PROTOCOLS = {
    "DES":    USM_PRIV_CBC56_DES,
    "3DES":   USM_PRIV_CBC168_3DES,
    "AES-128": USM_PRIV_CFB128_AES,
    "AES-192": USM_PRIV_CFB192_AES,
    "AES-256": USM_PRIV_CFB256_AES,
}

# --- OID constants ------------------------------------------------------------

OID_SYS_NAME      = "1.3.6.1.2.1.1.5.0"
OID_SYS_DESCR     = "1.3.6.1.2.1.1.1.0"
OID_SYS_LOCATION  = "1.3.6.1.2.1.1.6.0"
OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"

# SNMP-FRAMEWORK-MIB::snmpEngineID.0 -- the agent's authoritative engine ID.
OID_SNMP_ENGINE_ID = "1.3.6.1.6.3.10.2.1.1.0"

# Substrings of PySNMP error indications that point at a wrong / stale
# authoritative engine ID (unknownEngineID, notInTimeWindow, wrongDigest).
# With an override set, PySNMP 7 still discovers the agent's real engine ID
# and then fails locally with unknownSecurityName when no USM user is bound
# to that ID (verified against a loopback PySNMP 7.1.30 agent), so that
# indication counts as an engine ID mismatch too. Only evaluated when an
# override is configured.
_ENGINE_ID_ERROR_MARKERS = (
    "unknown snmp engine id",
    "not in windows of trust",
    "wrong snmp pdu digest",
    "unknown snmp security name",
    "unknownengineid",
    "notintimewindow",
    "wrongdigest",
    "unknownsecurityname",
)

# ENTITY-MIB for the main chassis entry (index 1). Most switches report the
# running OS image in entPhysicalSoftwareRev (.10); entPhysicalFirmwareRev (.9)
# typically holds boot-ROM/CPLD firmware and is often empty.
OID_ENT_PHYSICAL_SOFTWARE_REV = "1.3.6.1.2.1.47.1.1.1.1.10.1"
OID_ENT_PHYSICAL_FIRMWARE_REV = "1.3.6.1.2.1.47.1.1.1.1.9.1"

OID_IF_DESCR       = "1.3.6.1.2.1.2.2.1.2"     # ifDescr
OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8"     # 1=up, 2=down
OID_IF_HIGH_SPEED  = "1.3.6.1.2.1.31.1.1.1.15" # ifHighSpeed Mbps
OID_IF_ALIAS       = "1.3.6.1.2.1.31.1.1.1.18" # ifAlias
OID_IF_NAME        = "1.3.6.1.2.1.31.1.1.1.1"  # ifName

# LLDP remote table
OID_LLDP_REM_SYS_NAME  = "1.0.8802.1.1.2.1.4.1.1.9"
OID_LLDP_REM_PORT_ID   = "1.0.8802.1.1.2.1.4.1.1.7"
OID_LLDP_REM_PORT_DESC = "1.0.8802.1.1.2.1.4.1.1.8"

# LLDP local port table (index = lldpLocPortNum, which lldpRemLocalPortNum
# refers to; not necessarily the ifIndex)
OID_LLDP_LOC_PORT_ID_SUBTYPE = "1.0.8802.1.1.2.1.3.7.1.2"
OID_LLDP_LOC_PORT_ID         = "1.0.8802.1.1.2.1.3.7.1.3"
OID_LLDP_LOC_PORT_DESC       = "1.0.8802.1.1.2.1.3.7.1.4"

# ARP table
OID_ARP_MAC = "1.3.6.1.2.1.4.22.1.2"
OID_ARP_IP  = "1.3.6.1.2.1.4.22.1.3"

# BRIDGE-MIB forwarding database (MAC -> bridge port -> ifIndex)
OID_DOT1D_TP_FDB_PORT        = "1.3.6.1.2.1.17.4.3.1.2"
OID_DOT1D_BASE_PORT_IF_INDEX = "1.3.6.1.2.1.17.1.4.1.2"

# Q-Bridge-MIB (required for UniFi; OID index format: {VLAN}.{6 MAC bytes})
OID_QBRIDGE_FDB_PORT   = "1.3.6.1.2.1.17.7.1.2.2.1.2"  # MAC+VLAN -> bridge port
OID_QBRIDGE_FDB_STATUS = "1.3.6.1.2.1.17.7.1.2.2.1.3"  # 3=learned, 5=self

# IP-MIB unified neighbor table (IPv4 + IPv6, replaces legacy ARP table)
# Particularly relevant for OPNsense/FreeBSD which tracks both address families.
# Index: {ifIndex}.{addrType}.{addrLen}.{addr...}
OID_IP_NET_TO_PHYSICAL_MAC  = "1.3.6.1.2.1.4.35.1.4"  # ipNetToPhysicalPhysAddress
OID_IP_NET_TO_PHYSICAL_ADDR = "1.3.6.1.2.1.4.35.1.3"  # ipNetToPhysicalNetAddress
OID_IP_NET_TO_PHYSICAL_TYPE = "1.3.6.1.2.1.4.35.1.7"  # 3=dynamic (learned), 4=static

# Net-SNMP / OPNsense (FreeBSD) enterprise root
# OPNsense reports sysObjectID = 1.3.6.1.4.1.8072.3.2.9 (net-snmp on FreeBSD)
OID_NETSNMP_ENTERPRISE = "1.3.6.1.4.1.8072"

# VLAN (Q-BRIDGE-MIB)
OID_DOT1Q_PVID = "1.3.6.1.2.1.17.7.1.4.5.1.1"  # dot1qPvid
OID_DOT1Q_VLAN_STATIC_EGRESS   = "1.3.6.1.2.1.17.7.1.4.3.1.2"  # dot1qVlanStaticEgressPorts
OID_DOT1Q_VLAN_STATIC_UNTAGGED = "1.3.6.1.2.1.17.7.1.4.3.1.4"  # dot1qVlanStaticUntaggedPorts
OID_DOT1Q_VLAN_STATIC_NAME     = "1.3.6.1.2.1.17.7.1.4.3.1.1"  # dot1qVlanStaticName (index = VLAN id)

# Spanning tree (BRIDGE-MIB dot1dStp / RSTP-MIB), default instance only
OID_DOT1D_BASE_BRIDGE_ADDRESS   = "1.3.6.1.2.1.17.1.1.0"   # dot1dBaseBridgeAddress (6-octet MAC)
OID_DOT1D_STP_PROTOCOL_SPEC     = "1.3.6.1.2.1.17.2.1.0"   # dot1dStpProtocolSpecification (3 = ieee8021d)
OID_DOT1D_STP_PRIORITY          = "1.3.6.1.2.1.17.2.2.0"   # dot1dStpPriority
OID_DOT1D_STP_DESIGNATED_ROOT   = "1.3.6.1.2.1.17.2.5.0"   # dot1dStpDesignatedRoot (8-octet BridgeId)
OID_DOT1D_STP_ROOT_COST         = "1.3.6.1.2.1.17.2.6.0"   # dot1dStpRootCost
OID_DOT1D_STP_ROOT_PORT         = "1.3.6.1.2.1.17.2.7.0"   # dot1dStpRootPort (bridge port, 0 = root)
OID_DOT1D_STP_VERSION           = "1.3.6.1.2.1.17.2.16.0"  # RSTP-MIB dot1dStpVersion (0 stp, 2 rstp, 3 mstp)
OID_DOT1D_STP_PORT_STATE        = "1.3.6.1.2.1.17.2.15.1.3"  # dot1dStpPortState (index = bridge port)
OID_DOT1D_STP_PORT_PATH_COST    = "1.3.6.1.2.1.17.2.15.1.5"  # dot1dStpPortPathCost (index = bridge port)

# Multiple spanning tree instances (IEEE8021-MSTP-MIB), read for MSTP bridges only
OID_MSTP_ENTRY      = "1.3.111.2.802.1.1.6.1.2.1"     # ieee8021MstpEntry (index component.mstId)
OID_MSTP_PORT_STATE = "1.3.111.2.802.1.1.6.1.4.1.5"   # ieee8021MstpPortState (component.mstId.port)
OID_MSTP_PORT_ROLE  = "1.3.111.2.802.1.1.6.1.4.1.12"  # ieee8021MstpPortRole (component.mstId.port)

STP_SCALAR_OIDS = (
    OID_DOT1D_BASE_BRIDGE_ADDRESS, OID_DOT1D_STP_PROTOCOL_SPEC, OID_DOT1D_STP_PRIORITY,
    OID_DOT1D_STP_DESIGNATED_ROOT, OID_DOT1D_STP_ROOT_COST, OID_DOT1D_STP_ROOT_PORT,
    OID_DOT1D_STP_VERSION,
)


# --- Data classes -------------------------------------------------------------

@dataclass
class IfInfo:
    index:       int
    descr:       str = ""
    alias:       str = ""
    speed_mbps:  int = 0
    oper_status: int = 2
    vlan:        int = 0
    tagged_vlans: List[int] = field(default_factory=list)
    stp_state:     Optional[str] = None
    stp_role:      Optional[str] = None
    stp_path_cost: Optional[int] = None
    # MSTI id (string) -> {state, role} from IEEE8021-MSTP-MIB, None if not reported
    stp_instances: Optional[Dict[str, dict]] = None


@dataclass
class LldpNeighbor:
    local_port_idx:  int
    local_port_desc: str = ""
    remote_sys:      str = ""
    remote_port:     str = ""  # resolved: lldpRemPortDesc preferred, else lldpRemPortId
    remote_port_id:  str = ""  # raw lldpRemPortId (interface name, e.g. 'mlxen0')
    remote_ip:       str = ""


@dataclass
class SwitchData:
    ip:             str
    sys_name:       str = ""
    sys_descr:      str = ""
    location:       str = ""
    firmware:       str = ""
    vendor:         str = "generic"   # "aruba_cx" | "fs" | "generic"
    interfaces:     Dict[int, IfInfo]  = field(default_factory=dict)
    lldp_neighbors: List[LldpNeighbor] = field(default_factory=list)
    arp_table:      Dict[str, str]     = field(default_factory=dict)  # mac -> ip
    mac_ifindex:    Dict[str, int]     = field(default_factory=dict)  # mac -> ifIndex
    engine_id:      str = ""   # snmpEngineID.0 as lowercase hex ("" if unavailable)
    # Bridge-level STP summary (keys: protocol, bridge_id, root_id, root_cost,
    # root_port) or None when the device reports no STP data.
    stp:            Optional[dict] = None
    # MSTP bridges: MSTIs (keys: id, bridge_id, root_id, root_cost, root_port,
    # vlans) from IEEE8021-MSTP-MIB; empty when none are reported.
    stp_instances:  List[dict] = field(default_factory=list)
    vlan_names:     Dict[str, str] = field(default_factory=dict)  # "vlan id" -> name
    # True when ifDescr/ifAlias were walked in this scan (the caller stores
    # them as the device's interface name cache); False when served from it.
    if_names_refreshed: bool = False
    # False when the VLAN (PVID, tagged VLANs, VLAN names) or STP data was not
    # collected in this scan; the caller then keeps the previously stored values.
    vlan_collected: bool = True
    stp_collected: bool = True
    # Device kind from the vendor scanner ("switch" | "firewall" | "ups" |
    # "server"); a generic device answering RFC 1628 UPS-MIB becomes "ups".
    device_type: str = "switch"
    # Normalized health snapshot (scanners.health) or None when the device
    # reported none or health was not collected in this scan.
    health: Optional[dict] = None


# --- Credentials builder ------------------------------------------------------

def build_auth(
    snmp_version: str,
    community: str = "public",
    v3_security_level: str = "authPriv",
    v3_username: str = "",
    v3_auth_protocol: str = "SHA-256",
    v3_auth_password: str = "",
    v3_priv_protocol: str = "AES-128",
    v3_priv_password: str = "",
    v3_engine_id: str = "",
):
    """Return a pysnmp auth object (CommunityData or UsmUserData).

    ``v3_engine_id`` is an optional manual override of the authoritative
    engine ID (hex string, no 0x prefix). When set for SNMPv3 it is passed to
    UsmUserData as ``securityEngineId`` so the USM user (and its localized
    keys) is bound to that engine ID instead of the discovered one. Ignored
    for SNMPv2c.
    """
    if snmp_version in (SnmpVersion.V2C, "v2c"):
        # SNMPv2c remains available for devices configured with community credentials.
        return CommunityData(community, mpModel=1)  # nosec B508

    # SNMPv3
    extra = {}
    if v3_engine_id:
        extra["securityEngineId"] = OctetString(hexValue=v3_engine_id)

    sl = v3_security_level
    if sl in (SecurityLevel.NO_AUTH_NO_PRIV, "noAuthNoPriv"):
        # Explicit user-selected noAuthNoPriv device compatibility.
        return UsmUserData(  # nosec B509
            v3_username,
            authProtocol=USM_AUTH_NONE,
            privProtocol=USM_PRIV_NONE,
            **extra,
        )
    if sl in (SecurityLevel.AUTH_NO_PRIV, "authNoPriv"):
        # Explicit user-selected authNoPriv device compatibility.
        return UsmUserData(  # nosec B509
            v3_username,
            authKey=v3_auth_password,
            authProtocol=AUTH_PROTOCOLS.get(v3_auth_protocol, USM_AUTH_HMAC96_SHA),
            privProtocol=USM_PRIV_NONE,
            **extra,
        )
    # authPriv (default)
    # authPriv defaults to SHA-256 and AES-128; maps preserve explicit user selection.
    return UsmUserData(  # nosec B509
        v3_username,
        authKey=v3_auth_password,
        privKey=v3_priv_password,
        authProtocol=AUTH_PROTOCOLS.get(v3_auth_protocol, USM_AUTH_HMAC192_SHA256),
        privProtocol=PRIV_PROTOCOLS.get(v3_priv_protocol, USM_PRIV_CFB128_AES),
        **extra,
    )


def is_engine_id_error(error_indication) -> bool:
    """True if a PySNMP error indication points at a wrong engine ID / time window / digest."""
    if not error_indication:
        return False
    text = f"{type(error_indication).__name__} {error_indication}".lower()
    return any(marker in text for marker in _ENGINE_ID_ERROR_MARKERS)


def engine_id_to_hex(value) -> str:
    """Convert a raw snmpEngineID value (bytes / OctetString) to lowercase hex.

    Returns "" for empty values or values outside the RFC 3411 size range
    (5-32 octets), which are treated as "not available".
    """
    if value is None:
        return ""
    try:
        raw = bytes(value)
    except Exception:
        return ""
    if not 5 <= len(raw) <= 32:
        return ""
    return raw.hex()


# --- Low-level async SNMP helpers ---------------------------------------------

async def _transport(ip: str, port: int = 161, timeout: int = 3, retries: int = 1):
    return await UdpTransportTarget.create((ip, port), timeout=timeout, retries=retries)


# Row cap for GETBULK walks. Real tables exceed the former limit of 500 rows:
# the FDB / dot1qTpFdb and ARP tables of a core or large access switch, LLDP
# on dense stacks, ifTable / ifXTable on stacked 48-port chassis (hundreds of
# physical plus logical interfaces). The cap only guards against runaway
# agents; the subtree / non-increasing-OID checks end normal walks earlier.
WALK_MAX_ROWS_DEFAULT = 10000
# Hard upper bound for any per-call max_rows override.
WALK_MAX_ROWS_HARD_LIMIT = 100000

# GETBULK max-repetitions (rows per request). scan_switch() sets it per scan
# from the scan settings; tasks spawned by asyncio.gather inherit the value.
BULK_SIZE_DEFAULT = 25
BULK_SIZE_MIN = 5
BULK_SIZE_MAX = 100
_BULK_SIZE: ContextVar[int] = ContextVar("snmp_bulk_size", default=BULK_SIZE_DEFAULT)


def clamp_bulk_size(value) -> int:
    try:
        return max(BULK_SIZE_MIN, min(BULK_SIZE_MAX, int(value)))
    except (TypeError, ValueError):
        return BULK_SIZE_DEFAULT


def _clamp_walk_rows(max_rows: int) -> int:
    try:
        value = int(max_rows)
    except (TypeError, ValueError):
        value = WALK_MAX_ROWS_DEFAULT
    return max(1, min(value, WALK_MAX_ROWS_HARD_LIMIT))


def _warn_walk_truncated(func: str, ip: str, oid: str, cap: int) -> None:
    log.warning(
        "%s %s %s: walk stopped at the row cap of %d rows; the table may be truncated",
        func, ip, oid, cap,
    )


async def snmp_get(ip: str, port: int, auth,
                   *oids: str,
                   timeout: int = 3,
                   retries: int = 1,
                   engine: Optional[SnmpEngine] = None,
                   error_sink: Optional[list] = None) -> Dict[str, str]:
    """Async GET one or more scalar OIDs. Returns {oid_str: value_str}.

    If ``error_sink`` is a list, a non-empty error indication is appended to
    it so callers can inspect why an (otherwise silent) empty result occurred.
    """
    result: Dict[str, str] = {}
    objects = [ObjectType(ObjectIdentity(o)) for o in oids]
    own_engine = engine is None
    if own_engine:
        engine = SnmpEngine()
    try:
        error_indication, error_status, _, var_binds = await get_cmd(
            engine, auth, await _transport(ip, port, timeout, retries), ContextData(), *objects
        )
        if error_indication and error_sink is not None:
            error_sink.append(error_indication)
        if error_indication or error_status:
            return result
        for vb in var_binds:
            if isinstance(vb[1], (EndOfMibView, NoSuchInstance, NoSuchObject)):
                continue
            result[str(vb[0])] = _decode_snmp_str(vb[1])
    except Exception as exc:
        exc_type = type(exc).__name__
        if "Authentication" in exc_type or "auth" in str(exc).lower():
            log.warning("snmp_get %s: authentication error: %s", ip, exc)
        elif "Connection" in exc_type or "timeout" in str(exc).lower():
            log.warning("snmp_get %s: connection error: %s", ip, exc)
        else:
            log.debug("snmp_get %s: %s: %s", ip, exc_type, exc)
    finally:
        if own_engine:
            try:
                engine.close_dispatcher()
            except Exception:
                pass
    return result


OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"


async def snmp_probe_profile(ip: str, port: int, profile: dict, timeout: int = 1,
                             engine: Optional[SnmpEngine] = None) -> bool:
    """Quick SNMP pre-check: one GET of sysObjectID.0 without retries.

    ``profile`` carries the SNMP credential fields (snmp_version, community,
    v3_*). Returns True when the agent answered with a value, so the full
    discovery scan is only attempted with profiles that can work.
    """
    try:
        auth = build_auth(
            snmp_version=profile.get("snmp_version", "v2c"),
            community=profile.get("community", "public"),
            v3_security_level=profile.get("v3_security_level", "authPriv"),
            v3_username=profile.get("v3_username", ""),
            v3_auth_protocol=profile.get("v3_auth_protocol", "SHA-256"),
            v3_auth_password=profile.get("v3_auth_password", ""),
            v3_priv_protocol=profile.get("v3_priv_protocol", "AES-128"),
            v3_priv_password=profile.get("v3_priv_password", ""),
        )
    except Exception as exc:
        log.debug("snmp_probe_profile %s: invalid profile: %s", ip, exc)
        return False
    result = await snmp_get(ip, port, auth, OID_SYS_OBJECT_ID, timeout=timeout, retries=0, engine=engine)
    return bool(result)


async def snmp_get_raw(ip: str, port: int, auth,
                       *oids: str,
                       timeout: int = 3,
                       retries: int = 1,
                       engine: Optional[SnmpEngine] = None) -> Dict[str, bytes]:
    """Async GET returning raw bytes values (for binary OCTET STRINGs such as
    snmpEngineID). Errors and missing objects yield an empty / partial dict."""
    result: Dict[str, bytes] = {}
    objects = [ObjectType(ObjectIdentity(o)) for o in oids]
    own_engine = engine is None
    if own_engine:
        engine = SnmpEngine()
    try:
        error_indication, error_status, _, var_binds = await get_cmd(
            engine, auth, await _transport(ip, port, timeout, retries), ContextData(), *objects
        )
        if error_indication or error_status:
            return result
        for vb in var_binds:
            if isinstance(vb[1], (EndOfMibView, NoSuchInstance, NoSuchObject)):
                continue
            try:
                result[str(vb[0])] = bytes(vb[1])
            except Exception:
                continue
    except Exception as exc:
        log.debug("snmp_get_raw %s: %s: %s", ip, type(exc).__name__, exc)
    finally:
        if own_engine:
            try:
                engine.close_dispatcher()
            except Exception:
                pass
    return result


async def snmp_get_values(ip: str, port: int, auth,
                          *oids: str,
                          timeout: int = 3,
                          retries: int = 1,
                          engine: Optional[SnmpEngine] = None) -> Dict[str, object]:
    """Async GET returning the undecoded pysnmp values, for requests that mix
    INTEGER and binary OCTET STRING objects (e.g. BRIDGE-MIB STP scalars).
    Errors and missing objects yield an empty / partial dict."""
    result: Dict[str, object] = {}
    objects = [ObjectType(ObjectIdentity(o)) for o in oids]
    own_engine = engine is None
    if own_engine:
        engine = SnmpEngine()
    try:
        error_indication, error_status, _, var_binds = await get_cmd(
            engine, auth, await _transport(ip, port, timeout, retries), ContextData(), *objects
        )
        if error_indication or error_status:
            return result
        for vb in var_binds:
            if isinstance(vb[1], (EndOfMibView, NoSuchInstance, NoSuchObject)):
                continue
            result[str(vb[0])] = vb[1]
    except Exception as exc:
        log.debug("snmp_get_values %s: %s: %s", ip, type(exc).__name__, exc)
    finally:
        if own_engine:
            try:
                engine.close_dispatcher()
            except Exception:
                pass
    return result


async def snmp_bulk_walk(ip: str, port: int, auth,
                         oid: str, max_rows: int = WALK_MAX_ROWS_DEFAULT,
                         timeout: int = 3,
                         retries: int = 1,
                         engine: Optional[SnmpEngine] = None) -> List[Tuple[str, str]]:
    """Async SNMPv2c/v3 GETBULK walk. Returns [(oid_str, value_str)].

    Advance the cursor through flat PySNMP ObjectType responses. Stop on an
    exhausted subtree, a non-increasing OID, or the row limit (clamped to
    WALK_MAX_ROWS_HARD_LIMIT; reaching it logs a WARNING).
    """
    max_rows = _clamp_walk_rows(max_rows)
    rows: List[Tuple[str, str]] = []
    current_oid = oid
    bulk_size = _BULK_SIZE.get()
    own_engine = engine is None
    if own_engine:
        engine = SnmpEngine()
    try:
        while len(rows) < max_rows:
            try:
                error_indication, error_status, _, var_binds = await bulk_cmd(
                    engine, auth, await _transport(ip, port, timeout, retries), ContextData(),
                    0, bulk_size,
                    ObjectType(ObjectIdentity(current_oid)),
                )
            except Exception as exc:
                log.debug("snmp_bulk_walk %s %s: %s", ip, oid, exc)
                break

            if error_indication or error_status:
                break

            if not var_binds:
                break

            advanced = False
            for vb in var_binds:
                if isinstance(vb[1], (EndOfMibView, NoSuchInstance, NoSuchObject)):
                    return rows
                vb_oid = str(vb[0])
                if tuple(map(int, vb_oid.split('.'))) <= tuple(map(int, current_oid.split('.'))):
                    return rows
                vb_val = _decode_snmp_str(vb[1])
                # Stop if we have left the requested subtree
                if not vb_oid.startswith(oid + ".") and vb_oid != oid:
                    return rows
                rows.append((vb_oid, vb_val))
                current_oid = vb_oid  # advance cursor to last received OID
                advanced = True
                if len(rows) >= max_rows:
                    _warn_walk_truncated("snmp_bulk_walk", ip, oid, max_rows)
                    return rows

            if not advanced:
                break
    finally:
        if own_engine:
            try:
                engine.close_dispatcher()
            except Exception:
                pass
    return rows


async def snmp_bulk_walk_raw(ip: str, port: int, auth,
                             oid: str, max_rows: int = WALK_MAX_ROWS_DEFAULT,
                             timeout: int = 3,
                             retries: int = 1,
                             engine: Optional[SnmpEngine] = None) -> List[Tuple[str, bytes]]:
    """Async GETBULK walk returning raw bytes values (for OCTET STRING bitmasks).

    Identical to snmp_bulk_walk() except values are returned as raw bytes
    instead of decoded strings, preserving binary bitmask data.
    """
    max_rows = _clamp_walk_rows(max_rows)
    rows: List[Tuple[str, bytes]] = []
    current_oid = oid
    bulk_size = _BULK_SIZE.get()
    own_engine = engine is None
    if own_engine:
        engine = SnmpEngine()
    try:
        while len(rows) < max_rows:
            try:
                error_indication, error_status, _, var_binds = await bulk_cmd(
                    engine, auth, await _transport(ip, port, timeout, retries), ContextData(),
                    0, bulk_size,
                    ObjectType(ObjectIdentity(current_oid)),
                )
            except Exception as exc:
                log.debug("snmp_bulk_walk_raw %s %s: %s", ip, oid, exc)
                break

            if error_indication or error_status:
                break

            if not var_binds:
                break

            advanced = False
            for vb in var_binds:
                if isinstance(vb[1], (EndOfMibView, NoSuchInstance, NoSuchObject)):
                    return rows
                vb_oid = str(vb[0])
                if tuple(map(int, vb_oid.split('.'))) <= tuple(map(int, current_oid.split('.'))):
                    return rows
                try:
                    vb_val = bytes(vb[1])
                except Exception:
                    vb_val = b""
                if not vb_oid.startswith(oid + ".") and vb_oid != oid:
                    return rows
                rows.append((vb_oid, vb_val))
                current_oid = vb_oid
                advanced = True
                if len(rows) >= max_rows:
                    _warn_walk_truncated("snmp_bulk_walk_raw", ip, oid, max_rows)
                    return rows

            if not advanced:
                break
    finally:
        if own_engine:
            try:
                engine.close_dispatcher()
            except Exception:
                pass
    return rows


def parse_port_bitmask(data: bytes) -> set:
    """Parse Q-BRIDGE OCTET STRING port bitmask into set of bridge port numbers (1-indexed).

    Byte 0 bit 7 (MSB) = bridge port 1, byte 0 bit 6 = port 2, ...,
    byte 0 bit 0 = port 8, byte 1 bit 7 = port 9, etc.
    """
    ports = set()
    for byte_idx, byte_val in enumerate(data):
        for bit in range(8):
            if byte_val & (0x80 >> bit):
                ports.add(byte_idx * 8 + bit + 1)
    return ports


# --- Vendor detection ---------------------------------------------------------

# detect_vendor() lives in scanners.detection (imported above) so it stays
# unit-testable without pysnmp.


# --- Vendor-aware helpers (delegated to scanners plugin) ----------------------

from scanners import get_scanner


def extract_model(sys_descr: str, vendor: str) -> str:
    """Extract model from sysDescr using the vendor scanner plugin."""
    return get_scanner(vendor).extract_model(sys_descr)


def extract_version(sys_descr: str, vendor: str) -> str:
    """Extract firmware version from sysDescr using the vendor scanner plugin."""
    return get_scanner(vendor).extract_version(sys_descr)


def is_virtual(if_descr: str, vendor: str) -> bool:
    """Check if an interface is virtual using the vendor scanner plugin."""
    return get_scanner(vendor).is_virtual_port(if_descr)


# --- Speed label helper -------------------------------------------------------

# NOTE: This logic is mirrored in frontend/src/api.js speedLabel().
# Any changes here must be reflected there too.
def speed_label(mbps: int) -> str:
    if mbps >= 100_000:
        return "100G"
    if mbps >= 40_000:
        return "40G"
    if mbps >= 25_000:
        return "25G"
    if mbps >= 10_000:
        return "10G"
    if mbps >= 1_000:
        return "1G"
    if mbps >= 100:
        return "100M"
    return "10M"


def _last_n(oid_str: str, n: int = 1) -> List[str]:
    return oid_str.rstrip(".").split(".")[-n:]


def _decode_snmp_str(val) -> str:
    """Safely decode a pysnmp value to a clean Unicode string.

    OctetString.__str__() silently decodes bytes as Latin-1, producing garbage
    for non-ASCII sequences.  Non-OctetString types (Integer, Counter32/64,
    Gauge32, TimeTicks …) must go through str() directly — bytes() on those
    returns null-padded binary representations (e.g. Integer(1) -> b'\\x00').
    """
    from pysnmp.proto.rfc1902 import OctetString as _OctetString

    # Non-string SNMP types: use str() which gives the correct decimal value.
    if not isinstance(val, _OctetString):
        return str(val).strip()

    # OctetString: decode raw bytes, trying UTF-8 then Latin-1.
    try:
        raw: bytes = bytes(val)
    except Exception:
        return str(val).strip()

    # 6-byte OctetStrings are almost always binary MAC addresses (e.g. LLDP
    # portId subtype 3).  Convert to human-readable xx:xx:xx:xx:xx:xx form.
    if len(raw) == 6 and any(b > 0x7E for b in raw):
        return ":".join(f"{b:02x}" for b in raw)

    for enc in ("utf-8", "latin-1"):
        try:
            decoded = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        return ""

    # Strip C0/C1 control characters
    cleaned = "".join(c for c in decoded if c >= " " or c in "\t\n\r")
    cleaned = cleaned.strip()

    # Reject strings where more than 25% of chars are non-ASCII (binary garbage).
    # Legitimate strings (port names, sys names) are almost always pure ASCII.
    # Using 25% to catch binary sequences like binary-encoded MAC addresses.
    if cleaned and sum(ord(c) > 127 for c in cleaned) / len(cleaned) > 0.25:
        return ""

    return cleaned


# --- Engine ID discovery ------------------------------------------------------

async def _read_engine_id(ip: str, snmp_port: int, auth, snmp_timeout: int,
                          snmp_retries: int, engine: SnmpEngine) -> str:
    """Read SNMP-FRAMEWORK-MIB::snmpEngineID.0 and return it as lowercase hex.

    Uses the per-scan SnmpEngine, so for SNMPv3 this runs after PySNMP has
    already performed USM discovery for the first request. Returns "" when the
    agent does not expose the object or the request fails (never raises).
    """
    try:
        raw = await snmp_get_raw(
            ip, snmp_port, auth, OID_SNMP_ENGINE_ID,
            timeout=snmp_timeout, retries=snmp_retries, engine=engine,
        )
    except Exception as exc:
        log.debug("snmpEngineID read failed for %s: %s", ip, exc)
        return ""
    return engine_id_to_hex(raw.get(OID_SNMP_ENGINE_ID))


async def _read_vendor_firmware(vendor: str, ip: str, snmp_port: int, auth, snmp_timeout: int,
                                snmp_retries: int, engine: SnmpEngine) -> str:
    """Read the vendor scanner's FIRMWARE_OIDS; first non-empty value wins.

    Returns "" when the vendor defines none or the agent answers none (never
    raises).
    """
    oids = get_scanner(vendor).FIRMWARE_OIDS
    if not oids:
        return ""
    try:
        values = await snmp_get(
            ip, snmp_port, auth, *oids,
            timeout=snmp_timeout, retries=snmp_retries, engine=engine,
        )
    except Exception as exc:
        log.debug("Vendor firmware read failed for %s: %s", ip, exc)
        return ""
    for oid in oids:
        value = (values.get(oid) or "").strip()
        if value:
            return value
    return ""


# --- Device type / health -----------------------------------------------------

async def _probe_generic_ups(ip: str, snmp_port: int, auth, snmp_timeout: int,
                             snmp_retries: int, engine: SnmpEngine) -> bool:
    """Return True when a generic device answers RFC 1628 upsIdentManufacturer.

    One GET, only issued for devices whose vendor resolved to "generic".
    Never raises.
    """
    try:
        values = await snmp_get(
            ip, snmp_port, auth, OID_UPS_IDENT_MANUFACTURER,
            timeout=snmp_timeout, retries=snmp_retries, engine=engine,
        )
    except Exception as exc:
        log.debug("UPS-MIB probe failed for %s: %s", ip, exc)
        return False
    return bool((values.get(OID_UPS_IDENT_MANUFACTURER) or "").strip())


async def _collect_health(sw: SwitchData, ip: str, snmp_port: int, auth, snmp_timeout: int,
                          snmp_retries: int, engine: SnmpEngine) -> Optional[dict]:
    """Collect the vendor scanner's health snapshot; None on any failure."""
    async def _get(*oids: str):
        return await snmp_get(ip, snmp_port, auth, *oids, timeout=snmp_timeout, retries=snmp_retries, engine=engine)

    async def _walk(oid: str):
        return await snmp_bulk_walk(ip, snmp_port, auth, oid, timeout=snmp_timeout, retries=snmp_retries, engine=engine)

    try:
        if sw.vendor == "generic" and sw.device_type == "ups":
            return await collect_ups_health(_get, _walk)
        return await get_scanner(sw.vendor).collect_health(_get, _walk)
    except Exception as exc:
        log.debug("Health collection failed for %s: %s", ip, exc)
        return None


# --- Spanning tree / VLAN names -----------------------------------------------

async def _collect_stp_and_vlan_names(
    sw: SwitchData,
    ip: str,
    snmp_port: int,
    auth,
    snmp_timeout: int,
    snmp_retries: int,
    engine: SnmpEngine,
    bridge_to_ifindex: Dict[int, int],
    collect_stp: bool = True,
    collect_vlan_names: bool = True,
) -> None:
    """Fill sw.stp, sw.vlan_names and the per-interface STP fields.

    ``collect_stp`` / ``collect_vlan_names`` skip the respective reads.

    Best effort: missing MIBs, noSuchObject and timeouts leave the fields at
    their defaults (None / {}); this never raises. One GET reads the STP
    scalars (in parallel with the VLAN name walk); the two per-port STP walks
    only run when the device answered at least one STP scalar.

    Only the default spanning tree instance is read with the plain
    community / context. Cisco PVST+ / Rapid-PVST+ per-VLAN instances would
    require community@vlan (v2c) or context "vlan-<id>" (v3) and are out of
    scope.
    """
    async def _const(value):
        return value

    try:
        want_stp = collect_stp and get_scanner(sw.vendor).supports_stp()
        stp_scalars, name_rows = await asyncio.gather(
            snmp_get_values(
                ip, snmp_port, auth, *STP_SCALAR_OIDS,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            ) if want_stp else _const({}),
            snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1Q_VLAN_STATIC_NAME,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            ) if collect_vlan_names else _const([]),
        )
        if collect_vlan_names:
            sw.vlan_names = parse_vlan_names(name_rows)
    except Exception:
        log.debug("STP scalar / VLAN name read failed for %s", ip)
        return

    if not stp_scalars:
        return

    try:
        state_rows, cost_rows = await asyncio.gather(
            snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1D_STP_PORT_STATE,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            ),
            snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1D_STP_PORT_PATH_COST,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            ),
        )
        if (state_rows or cost_rows) and not bridge_to_ifindex:
            bp_rows = await snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1D_BASE_PORT_IF_INDEX,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            )
            for oid_s, ifindex_val in bp_rows:
                try:
                    bridge_to_ifindex[int(_last_n(oid_s, 1)[0])] = int(ifindex_val)
                except ValueError:
                    continue

        port_names = {idx: iface.descr for idx, iface in sw.interfaces.items() if iface.descr}
        sw.stp, per_ifindex = build_stp_info(
            stp_scalars, state_rows, cost_rows, bridge_to_ifindex, port_names,
            oid_priority=OID_DOT1D_STP_PRIORITY,
            oid_base_address=OID_DOT1D_BASE_BRIDGE_ADDRESS,
            oid_designated_root=OID_DOT1D_STP_DESIGNATED_ROOT,
            oid_root_cost=OID_DOT1D_STP_ROOT_COST,
            oid_root_port=OID_DOT1D_STP_ROOT_PORT,
            oid_version=OID_DOT1D_STP_VERSION,
            oid_protocol_spec=OID_DOT1D_STP_PROTOCOL_SPEC,
        )
        for ifindex, info in per_ifindex.items():
            iface = sw.interfaces.get(ifindex)
            if iface is None:
                continue
            iface.stp_state = info["state"]
            iface.stp_role = info["role"]
            iface.stp_path_cost = info["path_cost"]
        log.debug("STP for %s: %s, %d ports", ip, sw.stp, len(per_ifindex))
    except Exception:
        log.debug("STP walk failed for %s (BRIDGE-MIB dot1dStp not supported)", ip)
        return

    if (sw.stp or {}).get("protocol") == "mstp":
        await _collect_mstp_instances(sw, ip, snmp_port, auth, snmp_timeout, snmp_retries, engine, bridge_to_ifindex)


async def _collect_mstp_instances(
    sw: SwitchData,
    ip: str,
    snmp_port: int,
    auth,
    snmp_timeout: int,
    snmp_retries: int,
    engine: SnmpEngine,
    bridge_to_ifindex: Dict[int, int],
) -> None:
    """Fill sw.stp_instances and the per-interface MSTI data (best effort).

    Reads IEEE8021-MSTP-MIB ieee8021MstpTable (raw for the bridge IDs and VLAN
    bitmaps, decoded for cost / root port) and the port state / role columns.
    Agents without the MIB leave everything empty; this never raises.
    """
    kw = {"timeout": snmp_timeout, "retries": snmp_retries, "engine": engine}
    try:
        table_raw, table_rows, state_rows, role_rows = await asyncio.gather(
            snmp_bulk_walk_raw(ip, snmp_port, auth, OID_MSTP_ENTRY, **kw),
            snmp_bulk_walk(ip, snmp_port, auth, OID_MSTP_ENTRY, **kw),
            snmp_bulk_walk(ip, snmp_port, auth, OID_MSTP_PORT_STATE, **kw),
            snmp_bulk_walk(ip, snmp_port, auth, OID_MSTP_PORT_ROLE, **kw),
        )
        port_names = {idx: iface.descr for idx, iface in sw.interfaces.items() if iface.descr}
        sw.stp_instances, per_ifindex = build_mstp_info(
            table_raw, table_rows, state_rows, role_rows, bridge_to_ifindex, port_names,
            table_entry_oid=OID_MSTP_ENTRY,
            port_state_oid=OID_MSTP_PORT_STATE,
            port_role_oid=OID_MSTP_PORT_ROLE,
        )
        for ifindex, data in per_ifindex.items():
            iface = sw.interfaces.get(ifindex)
            if iface is not None:
                iface.stp_instances = data
        log.debug("MSTP for %s: %d instances", ip, len(sw.stp_instances))
    except Exception:
        log.debug("MSTP walk failed for %s (IEEE8021-MSTP-MIB not supported)", ip)


# --- LLDP local port mapping ---------------------------------------------------

async def _map_lldp_local_ports(sw: SwitchData, walk) -> Tuple[Dict[int, int], Dict[int, str], Dict[int, str]]:
    """Walk lldpLocPortTable (+ ifName) and map lldpLocPortNum -> ifIndex.

    Returns ``(port_map, port_ids, port_descs)``; the latter two are keyed by
    lldpLocPortNum and serve as local port name fallbacks. Best effort: any
    failure yields empty maps so callers keep the legacy 1:1 interpretation.
    """
    try:
        subtype_rows, id_rows, desc_rows, name_rows = await asyncio.gather(
            walk(OID_LLDP_LOC_PORT_ID_SUBTYPE), walk(OID_LLDP_LOC_PORT_ID),
            walk(OID_LLDP_LOC_PORT_DESC), walk(OID_IF_NAME),
        )
    except Exception as exc:
        log.debug("LLDP local port table walk failed for %s: %s", sw.ip, exc)
        return {}, {}, {}

    def _by_num(rows) -> Dict[int, str]:
        out: Dict[int, str] = {}
        for oid_s, val in rows:
            try:
                out[int(_last_n(oid_s, 1)[0])] = (val or "").strip()
            except ValueError:
                continue
        return out

    if_name = {i: n for i, n in _by_num(name_rows).items() if i in sw.interfaces}
    port_map = map_lldp_local_ports(
        subtype_rows, id_rows, desc_rows,
        {i: iface.descr for i, iface in sw.interfaces.items()},
        if_name,
        {i: iface.alias for i, iface in sw.interfaces.items()},
    )
    return port_map, _by_num(id_rows), _by_num(desc_rows)


# --- Main async scan function -------------------------------------------------


async def scan_switch(
    ip: str,
    snmp_version: str = "v2c",
    community: str = "public",
    snmp_port: int = 161,
    snmp_timeout: int = 3,
    snmp_retries: int = 1,
    v3_security_level: str = "authPriv",
    v3_username: str = "",
    v3_auth_protocol: str = "SHA-256",
    v3_auth_password: str = "",
    v3_priv_protocol: str = "AES-128",
    v3_priv_password: str = "",
    scan_type: str = "full",
    v3_engine_id: str = "",
    bulk_size: int = BULK_SIZE_DEFAULT,
    if_names: Optional[Dict[int, Tuple[str, str]]] = None,
    collect_vlan: bool = True,
    collect_stp: bool = True,
) -> Optional[SwitchData]:
    """Async full SNMP scan of one switch. Returns SwitchData or None on failure.

    ``if_names`` is a cached ifIndex -> (ifDescr, ifAlias) map. When given,
    the two name walks are skipped as long as every reported ifIndex is in the
    cache; an unknown ifIndex triggers a fresh walk of both columns.
    ``collect_vlan`` / ``collect_stp`` skip the VLAN and spanning tree walks
    (the result then reports ``vlan_collected`` / ``stp_collected`` False).
    """

    if scan_type in {"ranges", "ranges_all"}:
        # Range probes only need the discovery data set.
        scan_type = "discovery"
    scan_mode = scan_type if scan_type in {"discovery", "ports", "links", "macs", "full"} else "full"
    is_v3 = snmp_version not in (SnmpVersion.V2C, "v2c")
    engine_id_override = (v3_engine_id or "") if is_v3 else ""

    auth = build_auth(
        snmp_version=snmp_version,
        community=community,
        v3_security_level=v3_security_level,
        v3_username=v3_username,
        v3_auth_protocol=v3_auth_protocol,
        v3_auth_password=v3_auth_password,
        v3_priv_protocol=v3_priv_protocol,
        v3_priv_password=v3_priv_password,
        v3_engine_id=engine_id_override,
    )

    # Per-session SnmpEngine reuse: create once, pass to all SNMP calls
    session_engine = SnmpEngine()
    bulk_token = _BULK_SIZE.set(clamp_bulk_size(bulk_size))
    try:
        return await _scan_switch_inner(
            ip, snmp_port, auth, snmp_timeout, snmp_retries, scan_mode, session_engine,
            engine_id_override=engine_id_override, if_names=if_names,
            collect_vlan=collect_vlan, collect_stp=collect_stp,
        )
    finally:
        _BULK_SIZE.reset(bulk_token)
        try:
            session_engine.close_dispatcher()
        except Exception:
            pass


async def _scan_switch_inner(
    ip: str,
    snmp_port: int,
    auth,
    snmp_timeout: int,
    snmp_retries: int,
    scan_mode: str,
    engine: SnmpEngine,
    engine_id_override: str = "",
    if_names: Optional[Dict[int, Tuple[str, str]]] = None,
    collect_vlan: bool = True,
    collect_stp: bool = True,
) -> Optional[SwitchData]:
    """Inner scan logic using a pre-created SnmpEngine."""

    # -- 1. System scalars ----------------------------------------------------
    scalar_errors: list = []
    scalars = await snmp_get(
        ip, snmp_port, auth,
        OID_SYS_NAME, OID_SYS_DESCR,
        OID_SYS_LOCATION, OID_SYS_OBJECT_ID,
        OID_ENT_PHYSICAL_SOFTWARE_REV, OID_ENT_PHYSICAL_FIRMWARE_REV,
        timeout=snmp_timeout,
        retries=snmp_retries,
        engine=engine,
        error_sink=scalar_errors,
    )
    if not scalars:
        if engine_id_override and any(is_engine_id_error(e) for e in scalar_errors):
            # Explicit configuration wins: no auto-clear, no retry without it.
            log.warning(
                "SNMPv3 request to %s failed with engine ID override %s (%s); "
                "the override may be wrong or stale -- consider clearing it to use automatic discovery",
                ip, engine_id_override, scalar_errors[0],
            )
        log.warning("No SNMP response from %s", ip)
        return None

    sw = SwitchData(
        ip        = ip,
        sys_name  = scalars.get(OID_SYS_NAME, "").strip(),
        sys_descr = scalars.get(OID_SYS_DESCR, "").strip(),
        location  = scalars.get(OID_SYS_LOCATION, "").strip(),
        firmware  = (scalars.get(OID_ENT_PHYSICAL_SOFTWARE_REV)
                     or scalars.get(OID_ENT_PHYSICAL_FIRMWARE_REV) or "").strip(),
    )
    sys_oid = scalars.get(OID_SYS_OBJECT_ID, "").strip()

    # -- 1b. Authoritative engine ID (best effort, separate GET so agents that
    # reject unknown OIDs cannot break the system-scalar request above). -----
    sw.engine_id = await _read_engine_id(ip, snmp_port, auth, snmp_timeout, snmp_retries, engine)

    # -- 2. Vendor detection --------------------------------------------------
    sw.vendor = detect_vendor(sw.sys_descr, sys_oid)
    log.info("Detected vendor=%s for %s (%s)", sw.vendor, ip, sw.sys_name)
    sw.device_type = get_scanner(sw.vendor).device_type()
    if sw.vendor == "generic" and await _probe_generic_ups(
        ip, snmp_port, auth, snmp_timeout, snmp_retries, engine,
    ):
        sw.device_type = "ups"

    # Fall back to vendor MIB scalars, then to parsing sysDescr, when ENTITY-MIB
    # is not implemented
    if not sw.firmware:
        sw.firmware = await _read_vendor_firmware(sw.vendor, ip, snmp_port, auth, snmp_timeout, snmp_retries, engine)
    if not sw.firmware:
        sw.firmware = extract_version(sw.sys_descr, sw.vendor)

    if scan_mode == "discovery":
        return sw

    # -- 2b. Health snapshot (UPS / server), best effort ------------------------
    sw.health = await _collect_health(sw, ip, snmp_port, auth, snmp_timeout, snmp_retries, engine)

    # -- 3. Interface table ----------------------------------------------------
    # Status and speed change at runtime and are always walked. Names and
    # aliases are static; they come from the cache when it covers every
    # reported ifIndex, otherwise both columns are walked again.
    def _walk(oid: str):
        return snmp_bulk_walk(ip, snmp_port, auth, oid, timeout=snmp_timeout, retries=snmp_retries, engine=engine)

    def _idx(oid_s: str) -> Optional[int]:
        try:
            return int(_last_n(oid_s, 1)[0])
        except ValueError:
            return None

    if if_names:
        status_rows, hspeed_rows = await asyncio.gather(_walk(OID_IF_OPER_STATUS), _walk(OID_IF_HIGH_SPEED))
        reported = {_idx(o) for o, _ in status_rows} | {_idx(o) for o, _ in hspeed_rows}
        reported.discard(None)
        if reported and reported <= if_names.keys():
            descr_rows = [(f"{OID_IF_DESCR}.{i}", if_names[i][0]) for i in sorted(reported)]
            alias_rows = [(f"{OID_IF_ALIAS}.{i}", if_names[i][1]) for i in sorted(reported)]
        else:
            descr_rows, alias_rows = await asyncio.gather(_walk(OID_IF_DESCR), _walk(OID_IF_ALIAS))
            sw.if_names_refreshed = True
    else:
        descr_rows, status_rows, hspeed_rows, alias_rows = await asyncio.gather(
            _walk(OID_IF_DESCR), _walk(OID_IF_OPER_STATUS), _walk(OID_IF_HIGH_SPEED), _walk(OID_IF_ALIAS),
        )
        sw.if_names_refreshed = True

    for oid_s, val in descr_rows:
        idx = _idx(oid_s)
        if idx is None:
            continue
        sw.interfaces.setdefault(idx, IfInfo(index=idx)).descr = val

    for oid_s, val in status_rows:
        idx = _idx(oid_s)
        if idx is None:
            continue
        try:
            sw.interfaces.setdefault(idx, IfInfo(index=idx)).oper_status = int(val)
        except ValueError:
            pass

    for oid_s, val in hspeed_rows:
        idx = _idx(oid_s)
        if idx is None:
            continue
        try:
            sw.interfaces.setdefault(idx, IfInfo(index=idx)).speed_mbps = int(val)
        except ValueError:
            pass

    for oid_s, val in alias_rows:
        idx = _idx(oid_s)
        if idx is None:
            continue
        sw.interfaces.setdefault(idx, IfInfo(index=idx)).alias = val

    wants_links = scan_mode in {"full", "ports", "links"}
    wants_macs = scan_mode in {"full", "ports", "macs"}
    bridge_to_ifindex: Dict[int, int] = {}

    if wants_links:
        # -- 4. LLDP neighbor table (all walks in parallel) -------------------
        sys_rows, port_rows, pdesc_rows = await asyncio.gather(
            snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_SYS_NAME, timeout=snmp_timeout, retries=snmp_retries, engine=engine),
            snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_PORT_ID, timeout=snmp_timeout, retries=snmp_retries, engine=engine),
            snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_PORT_DESC, timeout=snmp_timeout, retries=snmp_retries, engine=engine),
        )
        local_port_map: Dict[int, int] = {}
        loc_ids: Dict[int, str] = {}
        loc_descs: Dict[int, str] = {}
        if sys_rows:
            local_port_map, loc_ids, loc_descs = await _map_lldp_local_ports(sw, _walk)

        nbr_map: Dict[Tuple[int, int], LldpNeighbor] = {}

        def _lldp_key(oid_s: str) -> Optional[Tuple[int, int]]:
            parts = oid_s.split(".")
            try:
                return int(parts[-2]), int(parts[-1])
            except (ValueError, IndexError):
                return None

        for oid_s, val in sys_rows:
            k = _lldp_key(oid_s)
            if k is None:
                continue
            local_port, _ = k
            # lldpRemLocalPortNum is an lldpLocPortNum; translate it to the
            # ifIndex when the local port table allows it (else legacy 1:1).
            local_idx = local_port_map.get(local_port, local_port)
            nbr_map.setdefault(k, LldpNeighbor(local_port_idx=local_idx)).remote_sys = val

        for oid_s, val in port_rows:
            k = _lldp_key(oid_s)
            if k and k in nbr_map:
                nbr_map[k].remote_port = val    # lldpRemPortId — may be overridden below
                nbr_map[k].remote_port_id = val  # keep raw portId as fallback

        for oid_s, val in pdesc_rows:
            k = _lldp_key(oid_s)
            if k and k in nbr_map:
                # Always prefer lldpRemPortDesc (human-readable interface name) over
                # lldpRemPortId which can be a binary-encoded MAC (subtype 3) or
                # other non-printable value.
                if val:
                    nbr_map[k].remote_port = val

        for (local_port, _), nbr in nbr_map.items():
            # Local port name: the resolved interface, else the LLDP local
            # port description / id (independent of lldpRemPortDesc rows).
            iface = sw.interfaces.get(nbr.local_port_idx)
            nbr.local_port_desc = (
                (iface.descr if iface else "")
                or loc_descs.get(local_port, "")
                or loc_ids.get(local_port, "")
            )

        sw.lldp_neighbors = list(nbr_map.values())

    if wants_macs:
        # -- 5. ARP + BRIDGE-MIB in parallel ---------------------------------
        scanner = get_scanner(sw.vendor)
        fdb_strategy = scanner.fdb_strategy()
        fdb_oid = OID_QBRIDGE_FDB_PORT if fdb_strategy == "qbridge" else OID_DOT1D_TP_FDB_PORT
        # Devices without a switching fabric (UPS, server management) have no
        # FDB; only the ARP tables are walked for them.
        wants_fdb = scanner.supports_fdb()
        log.debug("FDB strategy for %s (vendor=%s): %s (fdb=%s)", ip, sw.vendor, fdb_strategy, wants_fdb)

        async def _no_rows():
            return []

        (arp_mac_rows, arp_ip_rows,
         base_port_rows, fdb_rows) = await asyncio.gather(
            # MAC-typed column: walked raw so a 6-byte MAC whose bytes happen
            # to be printable is never decoded as text.
            snmp_bulk_walk_raw(ip, snmp_port, auth, OID_ARP_MAC, timeout=snmp_timeout, retries=snmp_retries, engine=engine),
            snmp_bulk_walk(ip, snmp_port, auth, OID_ARP_IP, timeout=snmp_timeout, retries=snmp_retries, engine=engine),
            snmp_bulk_walk(ip, snmp_port, auth, OID_DOT1D_BASE_PORT_IF_INDEX, timeout=snmp_timeout, retries=snmp_retries, engine=engine)
            if wants_fdb else _no_rows(),
            snmp_bulk_walk(ip, snmp_port, auth, fdb_oid, timeout=snmp_timeout, retries=snmp_retries, engine=engine)
            if wants_fdb else _no_rows(),
        )

        # If the primary FDB walk returned nothing, retry with the alternate
        # OID -- some firmwares implement only one of dot1d / qbridge, and an
        # empty primary walk would otherwise silently lose all endpoints.
        if not fdb_rows and wants_fdb:
            alt_oid = OID_DOT1D_TP_FDB_PORT if fdb_strategy == "qbridge" else OID_QBRIDGE_FDB_PORT
            log.info("Primary FDB walk (%s) empty for %s, trying alternate OID %s", fdb_strategy, ip, alt_oid)
            fdb_rows = await snmp_bulk_walk(
                ip, snmp_port, auth, alt_oid,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            )
            if fdb_rows:
                fdb_strategy = "dot1d" if fdb_strategy == "qbridge" else "qbridge"

        log.info(
            "MAC/ARP walk results for %s (%s): arp_mac=%d, arp_ip=%d, base_port=%d, fdb=%d",
            ip, sw.sys_name,
            len(arp_mac_rows), len(arp_ip_rows),
            len(base_port_rows), len(fdb_rows),
        )

        ip_by_suffix: Dict[str, str] = {}
        for oid_s, val in arp_ip_rows:
            suffix = ".".join(oid_s.split(".")[-5:])
            ip_by_suffix[suffix] = val
        for oid_s, mac_val in arp_mac_rows:
            suffix = ".".join(oid_s.split(".")[-5:])
            arp_ip = ip_by_suffix.get(suffix, "")
            mac = mac_from_octets(mac_val)
            if mac and arp_ip:
                sw.arp_table[mac] = arp_ip

        bridge_to_ifindex.clear()
        for oid_s, ifindex_val in base_port_rows:
            try:
                bridge_port = int(_last_n(oid_s, 1)[0])
                bridge_to_ifindex[bridge_port] = int(ifindex_val)
            except ValueError:
                continue

        # Q-Bridge indexes FDB entries per VLAN, so the same MAC can appear
        # several times; resolve collisions deterministically (see
        # scanners.parsing.resolve_fdb_candidates).
        sw.mac_ifindex = resolve_fdb_candidates(
            fdb_rows, fdb_strategy, bridge_to_ifindex, set(sw.interfaces.keys()),
        )

        # IP-MIB unified fallback when legacy ARP table is empty
        if not sw.arp_table:
            log.info("Legacy ARP empty for %s, trying IP-MIB unified neighbor table", ip)
            unified_rows = await snmp_bulk_walk_raw(
                ip, snmp_port, auth, OID_IP_NET_TO_PHYSICAL_MAC,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            )
            log.info("IP-MIB unified walk for %s: %d rows", ip, len(unified_rows))
            for oid_s, mac_val in unified_rows:
                mac = mac_from_octets(mac_val)
                if not mac:
                    continue
                parts = oid_s.split(".")
                try:
                    base_len = len(OID_IP_NET_TO_PHYSICAL_MAC.split("."))
                    idx_parts = parts[base_len:]
                    addr_type = int(idx_parts[1])
                    addr_len = int(idx_parts[2])
                    if addr_type == 1 and addr_len == 4:
                        peer_ip = ".".join(idx_parts[3:3+4])
                        sw.arp_table[mac] = peer_ip
                except (IndexError, ValueError):
                    continue

        log.info(
            "Endpoint tables for %s (%s): arp_table=%d entries, mac_ifindex=%d entries",
            ip, sw.sys_name,
            len(sw.arp_table), len(sw.mac_ifindex),
        )

    sw.vlan_collected = collect_vlan
    sw.stp_collected = collect_stp

    # -- 6. VLAN (dot1qPvid) - fault-tolerant --------------------------------
    if collect_vlan:
        try:
            # If bridge_to_ifindex wasn't populated (no MAC walk), fetch it now
            if not bridge_to_ifindex:
                bp_rows = await snmp_bulk_walk(
                    ip, snmp_port, auth, OID_DOT1D_BASE_PORT_IF_INDEX,
                    timeout=snmp_timeout, retries=snmp_retries, engine=engine,
                )
                for oid_s, ifindex_val in bp_rows:
                    try:
                        bp = int(_last_n(oid_s, 1)[0])
                        bridge_to_ifindex[bp] = int(ifindex_val)
                    except ValueError:
                        continue

            pvid_rows = await snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1Q_PVID,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            )
            for oid_s, val in pvid_rows:
                try:
                    bp = int(_last_n(oid_s, 1)[0])
                    pvid = int(val)
                except (ValueError, IndexError):
                    continue
                ifindex = bridge_to_ifindex.get(bp)
                if ifindex is not None and ifindex in sw.interfaces:
                    sw.interfaces[ifindex].vlan = pvid

            # -- 6b. Tagged VLANs (dot1qVlanStaticEgressPorts / UntaggedPorts) ----
            try:
                egress_rows, untagged_rows = await asyncio.gather(
                    snmp_bulk_walk_raw(
                        ip, snmp_port, auth, OID_DOT1Q_VLAN_STATIC_EGRESS,
                        timeout=snmp_timeout, retries=snmp_retries, engine=engine,
                    ),
                    snmp_bulk_walk_raw(
                        ip, snmp_port, auth, OID_DOT1Q_VLAN_STATIC_UNTAGGED,
                        timeout=snmp_timeout, retries=snmp_retries, engine=engine,
                    ),
                )

                if egress_rows:
                    egress_by_vlan = {}
                    for oid_s, raw_val in egress_rows:
                        try:
                            vlan_id = int(_last_n(oid_s, 1)[0])
                        except (ValueError, IndexError):
                            continue
                        egress_by_vlan[vlan_id] = parse_port_bitmask(raw_val)

                    untagged_by_vlan = {}
                    for oid_s, raw_val in untagged_rows:
                        try:
                            vlan_id = int(_last_n(oid_s, 1)[0])
                        except (ValueError, IndexError):
                            continue
                        untagged_by_vlan[vlan_id] = parse_port_bitmask(raw_val)

                    tagged_by_bp = {}
                    for vlan_id, egress_ports in egress_by_vlan.items():
                        untagged_ports = untagged_by_vlan.get(vlan_id, set())
                        tagged_ports = egress_ports - untagged_ports
                        for bp in tagged_ports:
                            tagged_by_bp.setdefault(bp, []).append(vlan_id)

                    for bp, vlans in tagged_by_bp.items():
                        ifindex = bridge_to_ifindex.get(bp)
                        if ifindex is not None and ifindex in sw.interfaces:
                            sw.interfaces[ifindex].tagged_vlans = sorted(vlans)

                    log.debug("Tagged VLANs for %s: %d ports have tagged VLANs",
                              ip, len(tagged_by_bp))
            except Exception:
                log.debug("Tagged VLAN walk failed for %s (static egress tables not supported)", ip)

        except Exception:
            log.debug("VLAN walk failed for %s (Q-BRIDGE-MIB not supported)", ip)

    # -- 7. Spanning tree + VLAN names - best effort ----------------------------
    if collect_stp or collect_vlan:
        await _collect_stp_and_vlan_names(
            sw, ip, snmp_port, auth, snmp_timeout, snmp_retries, engine, bridge_to_ifindex,
            collect_stp=collect_stp, collect_vlan_names=collect_vlan,
        )

    log.info("Scanned %s (%s) vendor=%s: %d ifaces, %d LLDP nbrs",
             ip, sw.sys_name, sw.vendor, len(sw.interfaces), len(sw.lldp_neighbors))
    return sw


# --- Auto-layout --------------------------------------------------------------

def auto_layout(ips: List[str]) -> Dict[str, Tuple[float, float]]:
    n = len(ips)
    if n == 0:
        return {}
    cx, cy, r = 450, 275, 240
    positions: Dict[str, Tuple[float, float]] = {}
    for i, ip in enumerate(ips):
        angle = 2 * math.pi * i / n - math.pi / 2
        positions[ip] = (cx + r * math.cos(angle), cy + r * math.sin(angle))
    return positions
