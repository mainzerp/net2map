"""SNMP scanner - SNMPv2c / SNMPv3, vendor-aware (Aruba CX + FS.com + generic).

Fully async: all SNMP I/O uses pysnmp.hlapi.asyncio so the event loop is
never blocked. scan_switch() is now a coroutine; call it with await.
"""
import asyncio
import logging
import math
import re
import socket
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# Auth / privacy constants (sync module exports these, async module does not)
from pysnmp.hlapi import (
    CommunityData, UsmUserData,
    usmNoAuthProtocol, usmNoPrivProtocol,
    usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
    usmHMAC128SHA224AuthProtocol, usmHMAC192SHA256AuthProtocol,
    usmHMAC256SHA384AuthProtocol, usmHMAC384SHA512AuthProtocol,
    usmDESPrivProtocol, usm3DESEDEPrivProtocol,
    usmAesCfb128Protocol, usmAesCfb192Protocol, usmAesCfb256Protocol,
)
# Async SNMP command generators
from pysnmp.hlapi.asyncio import (
    ContextData, ObjectIdentity, ObjectType,
    SnmpEngine, UdpTransportTarget,
    bulkCmd, getCmd,
)

log = logging.getLogger(__name__)

# --- Protocol maps ------------------------------------------------------------

AUTH_PROTOCOLS = {
    "MD5":    usmHMACMD5AuthProtocol,
    "SHA":    usmHMACSHAAuthProtocol,
    "SHA-224": usmHMAC128SHA224AuthProtocol,
    "SHA-256": usmHMAC192SHA256AuthProtocol,  # "192" in the constant name refers to HMAC key size, not hash size
    "SHA-384": usmHMAC256SHA384AuthProtocol,
    "SHA-512": usmHMAC384SHA512AuthProtocol,
}

PRIV_PROTOCOLS = {
    "DES":    usmDESPrivProtocol,
    "3DES":   usm3DESEDEPrivProtocol,
    "AES-128": usmAesCfb128Protocol,
    "AES-192": usmAesCfb192Protocol,
    "AES-256": usmAesCfb256Protocol,
}

# --- OID constants ------------------------------------------------------------

OID_SYS_NAME      = "1.3.6.1.2.1.1.5.0"
OID_SYS_DESCR     = "1.3.6.1.2.1.1.1.0"
OID_SYS_LOCATION  = "1.3.6.1.2.1.1.6.0"
OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"

OID_IF_DESCR       = "1.3.6.1.2.1.2.2.1.2"     # ifDescr
OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8"     # 1=up, 2=down
OID_IF_HIGH_SPEED  = "1.3.6.1.2.1.31.1.1.1.15" # ifHighSpeed Mbps
OID_IF_ALIAS       = "1.3.6.1.2.1.31.1.1.1.18" # ifAlias

# LLDP remote table
OID_LLDP_REM_SYS_NAME  = "1.0.8802.1.1.2.1.4.1.1.9"
OID_LLDP_REM_PORT_ID   = "1.0.8802.1.1.2.1.4.1.1.7"
OID_LLDP_REM_PORT_DESC = "1.0.8802.1.1.2.1.4.1.1.8"

# ARP table
OID_ARP_MAC = "1.3.6.1.2.1.4.22.1.2"
OID_ARP_IP  = "1.3.6.1.2.1.4.22.1.3"

# BRIDGE-MIB forwarding database (MAC -> bridge port -> ifIndex)
OID_DOT1D_TP_FDB_PORT        = "1.3.6.1.2.1.17.4.3.1.2"
OID_DOT1D_BASE_PORT_IF_INDEX = "1.3.6.1.2.1.17.1.4.1.2"

# --- Vendor enterprise OIDs ---------------------------------------------------
VENDOR_OIDS: Dict[str, str] = {
    "1.3.6.1.4.1.47196": "aruba_cx",  # Aruba Networks (CX)
    "1.3.6.1.4.1.11":    "aruba_cx",  # Hewlett-Packard (legacy Aruba/HPE)
    "1.3.6.1.4.1.25506": "aruba_cx",  # H3C (some HPE rebrand)
    "1.3.6.1.4.1.52642": "fs",        # FS.COM (FSOS)
    "1.3.6.1.4.1.41112": "unifi",     # Ubiquiti / UniFi
}

# sysDescr keywords per vendor (case-insensitive)
VENDOR_KEYWORDS: Dict[str, List[str]] = {
    "aruba_cx": ["arubaos-cx", "aruba cx", "arubacx"],
    "fs":       ["fsos", "fs s", "fs.com", " fss"],
    "unifi":    ["unifi", "ubiquiti", "usw-", "u7", "udm", "uxg"],
}


# --- Data classes -------------------------------------------------------------

@dataclass
class IfInfo:
    index:       int
    descr:       str = ""
    alias:       str = ""
    speed_mbps:  int = 0
    oper_status: int = 2


@dataclass
class LldpNeighbor:
    local_port_idx:  int
    local_port_desc: str = ""
    remote_sys:      str = ""
    remote_port:     str = ""
    remote_ip:       str = ""


@dataclass
class SwitchData:
    ip:             str
    sys_name:       str = ""
    sys_descr:      str = ""
    location:       str = ""
    vendor:         str = "generic"   # "aruba_cx" | "fs" | "generic"
    interfaces:     Dict[int, IfInfo]  = field(default_factory=dict)
    lldp_neighbors: List[LldpNeighbor] = field(default_factory=list)
    arp_table:      Dict[str, str]     = field(default_factory=dict)  # mac -> ip
    mac_ifindex:    Dict[str, int]     = field(default_factory=dict)  # mac -> ifIndex


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
):
    """Return a pysnmp auth object (CommunityData or UsmUserData)."""
    if snmp_version == "v2c":
        return CommunityData(community, mpModel=1)  # mpModel=1 -> SNMPv2c

    # SNMPv3
    sl = v3_security_level
    if sl == "noAuthNoPriv":
        return UsmUserData(
            v3_username,
            authProtocol=usmNoAuthProtocol,
            privProtocol=usmNoPrivProtocol,
        )
    if sl == "authNoPriv":
        return UsmUserData(
            v3_username,
            authKey=v3_auth_password,
            authProtocol=AUTH_PROTOCOLS.get(v3_auth_protocol, usmHMACSHAAuthProtocol),
            privProtocol=usmNoPrivProtocol,
        )
    # authPriv (default)
    return UsmUserData(
        v3_username,
        authKey=v3_auth_password,
        privKey=v3_priv_password,
        authProtocol=AUTH_PROTOCOLS.get(v3_auth_protocol, usmHMACSHAAuthProtocol),
        privProtocol=PRIV_PROTOCOLS.get(v3_priv_protocol, usmAesCfb128Protocol),
    )


# --- Low-level async SNMP helpers ---------------------------------------------

def _transport(ip: str, port: int = 161, timeout: int = 3, retries: int = 1):
    return UdpTransportTarget((ip, port), timeout=timeout, retries=retries)


async def snmp_get(ip: str, port: int, auth,
                   *oids: str,
                   timeout: int = 3,
                   retries: int = 1) -> Dict[str, str]:
    """Async GET one or more scalar OIDs. Returns {oid_str: value_str}."""
    result: Dict[str, str] = {}
    objects = [ObjectType(ObjectIdentity(o)) for o in oids]
    engine = SnmpEngine()
    try:
        error_indication, error_status, _, var_binds = await getCmd(
            engine, auth, _transport(ip, port, timeout, retries), ContextData(), *objects
        )
        if error_indication or error_status:
            return result
        for row in var_binds:
            # pysnmp-lextudio 5.x: each row is [ObjectType]; older versions: ObjectType
            vb = row[0] if isinstance(row, (list, tuple)) else row
            result[str(vb[0])] = str(vb[1])
    except Exception as exc:
        exc_type = type(exc).__name__
        if "Authentication" in exc_type or "auth" in str(exc).lower():
            log.warning("snmp_get %s: authentication error: %s", ip, exc)
        elif "Connection" in exc_type or "timeout" in str(exc).lower():
            log.warning("snmp_get %s: connection error: %s", ip, exc)
        else:
            log.debug("snmp_get %s: %s: %s", ip, exc_type, exc)
    finally:
        try:
            engine.transportDispatcher.closeDispatcher()
        except Exception:
            pass
    return result


async def snmp_bulk_walk(ip: str, port: int, auth,
                         oid: str, max_rows: int = 500,
                         timeout: int = 3,
                         retries: int = 1) -> List[Tuple[str, str]]:
    """Async SNMPv2c/v3 GETBULK walk. Returns [(oid_str, value_str)].

    pysnmp-lextudio 5.x changed bulkCmd to return a single awaitable future
    per call (not an async iterator). Each element in var_binds is a list
    containing one ObjectType. We loop manually, advancing the start OID with
    each successful response until we leave the requested subtree or reach
    max_rows.
    """
    rows: List[Tuple[str, str]] = []
    current_oid = oid
    bulk_size = 25
    engine = SnmpEngine()
    try:
        while len(rows) < max_rows:
            try:
                error_indication, error_status, _, var_binds = await bulkCmd(
                    engine, auth, _transport(ip, port, timeout, retries), ContextData(),
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
            # In pysnmp-lextudio 5.x var_binds is a list of lists (one sub-list
            # per repetition), each sub-list containing one ObjectType instance.
            for row in var_binds:
                # row is either [ObjectType] or ObjectType depending on version
                vb = row[0] if isinstance(row, (list, tuple)) else row
                vb_oid = str(vb[0])
                vb_val = str(vb[1])
                # Stop if we have left the requested subtree
                if not vb_oid.startswith(oid + ".") and vb_oid != oid:
                    return rows
                rows.append((vb_oid, vb_val))
                current_oid = vb_oid  # advance cursor to last received OID
                advanced = True
                if len(rows) >= max_rows:
                    return rows

            if not advanced:
                break
    finally:
        try:
            engine.transportDispatcher.closeDispatcher()
        except Exception:
            pass
    return rows


# --- Vendor detection ---------------------------------------------------------

def detect_vendor(sys_descr: str, sys_object_id: str) -> str:
    """Identify vendor from sysDescr and sysObjectID."""
    for prefix, vendor in VENDOR_OIDS.items():
        if sys_object_id.startswith(prefix):
            return vendor
    descr_lower = sys_descr.lower()
    for vendor, keywords in VENDOR_KEYWORDS.items():
        if any(k in descr_lower for k in keywords):
            return vendor
    return "generic"


# --- Vendor-specific model extraction ----------------------------------------

_MODEL_ARUBA = re.compile(
    r"(Aruba(?:\s+CX)?\s+[\d]{4}[A-Za-z\-]*(?:\s+\d+[A-Za-z]+)?)",
    re.IGNORECASE,
)
_MODEL_FS = re.compile(
    r"(FS\s+[A-Z]\d+[\w\-]*)",
    re.IGNORECASE,
)
_MODEL_UNIFI = re.compile(
    r"((?:UniFi|Ubiquiti)\s+[\w\- ]+|USW\-[\w\-]+)",
    re.IGNORECASE,
)
_MODEL_GENERIC = re.compile(
    r"(Aruba\s+CX\s+[\w\-]+|HPE?\s+[\w\-]+|Cisco\s+[\w\-]+|FS\s+[\w\-]+|FSOS\s+[\w\-]+)",
    re.IGNORECASE,
)


def extract_model(sys_descr: str, vendor: str) -> str:
    if vendor == "aruba_cx":
        m = _MODEL_ARUBA.search(sys_descr)
        return m.group(1) if m else ""
    if vendor == "fs":
        m = _MODEL_FS.search(sys_descr)
        return m.group(1) if m else ""
    if vendor == "unifi":
        m = _MODEL_UNIFI.search(sys_descr)
        return m.group(1) if m else ""
    m = _MODEL_GENERIC.search(sys_descr or "")
    return m.group(1) if m else ""


# --- Port filter helpers ------------------------------------------------------

_VIRTUAL_GENERIC = ("loopback", "tunnel", "null", "vlan", "management", "mgmt",
                    "bridge", "cpu", "stack", "oob")
_VIRTUAL_ARUBA = ("loopback", "vlan", "tunnel", "mgmt", "oobm")
_VIRTUAL_FS = ("loopback", "vlan", "mgmt", "null", "stack")
_VIRTUAL_UNIFI = ("loopback", "vlan", "bridge", "cpu", "mgmt")


def is_virtual(if_descr: str, vendor: str) -> bool:
    d = if_descr.lower()
    patterns = {
        "aruba_cx": _VIRTUAL_ARUBA,
        "fs":       _VIRTUAL_FS,
        "unifi":    _VIRTUAL_UNIFI,
    }.get(vendor, _VIRTUAL_GENERIC)
    return any(p in d for p in patterns)


# --- Speed label helper -------------------------------------------------------

# NOTE: This logic is mirrored in frontend/src/api.js speedLabel().
# Any changes here must be reflected there too.
def speed_label(mbps: int) -> str:
    if mbps >= 100_000: return "100G"
    if mbps >= 40_000:  return "40G"
    if mbps >= 25_000:  return "25G"
    if mbps >= 10_000:  return "10G"
    if mbps >= 1_000:   return "1G"
    if mbps >= 100:     return "100M"
    return "10M"


# --- Helper: last N OID components -------------------------------------------

def _last_n(oid_str: str, n: int = 1) -> List[str]:
    return oid_str.rstrip(".").split(".")[-n:]


def _hex_to_mac(hex_str: str) -> str:
    clean = hex_str.replace("0x", "").replace(" ", "").replace(":", "")
    try:
        pairs = [clean[i:i+2] for i in range(0, len(clean), 2)]
        return ":".join(pairs).lower()
    except Exception:
        return hex_str


def _oid_to_mac(oid_str: str) -> str:
    """Extract MAC from last 6 OID components (decimal bytes)."""
    try:
        parts = oid_str.rstrip(".").split(".")
        octets = [int(x) for x in parts[-6:]]
        if len(octets) != 6 or any(o < 0 or o > 255 for o in octets):
            return ""
        return ":".join(f"{o:02x}" for o in octets)
    except Exception:
        return ""


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
) -> Optional[SwitchData]:
    """Async full SNMP scan of one switch. Returns SwitchData or None on failure."""

    scan_mode = scan_type if scan_type in {"discovery", "ports", "links", "macs", "full"} else "full"

    auth = build_auth(
        snmp_version=snmp_version,
        community=community,
        v3_security_level=v3_security_level,
        v3_username=v3_username,
        v3_auth_protocol=v3_auth_protocol,
        v3_auth_password=v3_auth_password,
        v3_priv_protocol=v3_priv_protocol,
        v3_priv_password=v3_priv_password,
    )

    # -- 1. System scalars ----------------------------------------------------
    scalars = await snmp_get(
        ip, snmp_port, auth,
        OID_SYS_NAME, OID_SYS_DESCR,
        OID_SYS_LOCATION, OID_SYS_OBJECT_ID,
        timeout=snmp_timeout,
        retries=snmp_retries,
    )
    if not scalars:
        log.warning("No SNMP response from %s", ip)
        return None

    vals = list(scalars.values())
    sw = SwitchData(
        ip        = ip,
        sys_name  = (vals[0] if len(vals) > 0 else "").strip(),
        sys_descr = (vals[1] if len(vals) > 1 else "").strip(),
        location  = (vals[2] if len(vals) > 2 else "").strip(),
    )
    sys_oid = (vals[3] if len(vals) > 3 else "").strip()

    # -- 2. Vendor detection --------------------------------------------------
    sw.vendor = detect_vendor(sw.sys_descr, sys_oid)
    log.info("Detected vendor=%s for %s (%s)", sw.vendor, ip, sw.sys_name)

    if scan_mode == "discovery":
        return sw

    # -- 3. Interface table (all four walks in parallel) ----------------------
    descr_rows, status_rows, hspeed_rows, alias_rows = await asyncio.gather(
        snmp_bulk_walk(ip, snmp_port, auth, OID_IF_DESCR, timeout=snmp_timeout, retries=snmp_retries),
        snmp_bulk_walk(ip, snmp_port, auth, OID_IF_OPER_STATUS, timeout=snmp_timeout, retries=snmp_retries),
        snmp_bulk_walk(ip, snmp_port, auth, OID_IF_HIGH_SPEED, timeout=snmp_timeout, retries=snmp_retries),
        snmp_bulk_walk(ip, snmp_port, auth, OID_IF_ALIAS, timeout=snmp_timeout, retries=snmp_retries),
    )

    def _idx(oid_s: str) -> Optional[int]:
        try:
            return int(_last_n(oid_s, 1)[0])
        except ValueError:
            return None

    for oid_s, val in descr_rows:
        idx = _idx(oid_s)
        if idx is None: continue
        sw.interfaces.setdefault(idx, IfInfo(index=idx)).descr = val

    for oid_s, val in status_rows:
        idx = _idx(oid_s)
        if idx is None: continue
        try:
            sw.interfaces.setdefault(idx, IfInfo(index=idx)).oper_status = int(val)
        except ValueError:
            pass

    for oid_s, val in hspeed_rows:
        idx = _idx(oid_s)
        if idx is None: continue
        try:
            sw.interfaces.setdefault(idx, IfInfo(index=idx)).speed_mbps = int(val)
        except ValueError:
            pass

    for oid_s, val in alias_rows:
        idx = _idx(oid_s)
        if idx is None: continue
        sw.interfaces.setdefault(idx, IfInfo(index=idx)).alias = val

    wants_links = scan_mode in {"full", "ports", "links"}
    wants_macs = scan_mode in {"full", "ports", "macs"}

    if wants_links:
        # -- 4. LLDP neighbor table (all three walks in parallel) -------------
        sys_rows, port_rows, pdesc_rows = await asyncio.gather(
            snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_SYS_NAME, timeout=snmp_timeout, retries=snmp_retries),
            snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_PORT_ID, timeout=snmp_timeout, retries=snmp_retries),
            snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_PORT_DESC, timeout=snmp_timeout, retries=snmp_retries),
        )

        nbr_map: Dict[Tuple[int, int], LldpNeighbor] = {}

        def _lldp_key(oid_s: str) -> Optional[Tuple[int, int]]:
            parts = oid_s.split(".")
            try:
                return int(parts[-2]), int(parts[-1])
            except (ValueError, IndexError):
                return None

        for oid_s, val in sys_rows:
            k = _lldp_key(oid_s)
            if k is None: continue
            local_port, _ = k
            nbr_map.setdefault(k, LldpNeighbor(local_port_idx=local_port)).remote_sys = val

        for oid_s, val in port_rows:
            k = _lldp_key(oid_s)
            if k and k in nbr_map:
                nbr_map[k].remote_port = val

        for oid_s, val in pdesc_rows:
            k = _lldp_key(oid_s)
            if k and k in nbr_map:
                local_port = k[0]
                if not nbr_map[k].remote_port:
                    nbr_map[k].remote_port = val
                if local_port in sw.interfaces:
                    nbr_map[k].local_port_desc = sw.interfaces[local_port].descr

        sw.lldp_neighbors = list(nbr_map.values())

    if wants_macs:
        # -- 5. ARP + BRIDGE-MIB in parallel ---------------------------------
        (arp_mac_rows, arp_ip_rows,
         base_port_rows, fdb_rows) = await asyncio.gather(
            snmp_bulk_walk(ip, snmp_port, auth, OID_ARP_MAC, timeout=snmp_timeout, retries=snmp_retries),
            snmp_bulk_walk(ip, snmp_port, auth, OID_ARP_IP, timeout=snmp_timeout, retries=snmp_retries),
            snmp_bulk_walk(ip, snmp_port, auth, OID_DOT1D_BASE_PORT_IF_INDEX, timeout=snmp_timeout, retries=snmp_retries),
            snmp_bulk_walk(ip, snmp_port, auth, OID_DOT1D_TP_FDB_PORT, timeout=snmp_timeout, retries=snmp_retries),
        )

        ip_by_suffix: Dict[str, str] = {}
        for oid_s, val in arp_ip_rows:
            suffix = ".".join(oid_s.split(".")[-5:])
            ip_by_suffix[suffix] = val
        for oid_s, mac_val in arp_mac_rows:
            suffix = ".".join(oid_s.split(".")[-5:])
            arp_ip = ip_by_suffix.get(suffix, "")
            mac = _hex_to_mac(mac_val)
            if mac and arp_ip:
                sw.arp_table[mac] = arp_ip

        bridge_to_ifindex: Dict[int, int] = {}
        for oid_s, ifindex_val in base_port_rows:
            try:
                bridge_port = int(_last_n(oid_s, 1)[0])
                bridge_to_ifindex[bridge_port] = int(ifindex_val)
            except ValueError:
                continue

        for oid_s, bridge_port_val in fdb_rows:
            mac = _oid_to_mac(oid_s)
            if not mac:
                continue
            try:
                bridge_port = int(bridge_port_val)
            except ValueError:
                continue
            ifindex = bridge_to_ifindex.get(bridge_port)
            if ifindex is not None:
                sw.mac_ifindex[mac] = ifindex

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
