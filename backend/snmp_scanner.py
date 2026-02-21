"""SNMP scanner â€“ SNMPv2c / SNMPv3, vendor-aware (Aruba CX + FS.com + generic)."""
import logging
import math
import re
import socket
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from pysnmp.hlapi import (
    # transport / engine
    CommunityData, ContextData, ObjectIdentity, ObjectType,
    SnmpEngine, UdpTransportTarget,
    # v3 auth
    UsmUserData,
    usmNoAuthProtocol, usmNoPrivProtocol,
    usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
    usmHMAC128SHA224AuthProtocol, usmHMAC192SHA256AuthProtocol,
    usmHMAC256SHA384AuthProtocol, usmHMAC384SHA512AuthProtocol,
    # v3 priv
    usmDESPrivProtocol, usm3DESEDEPrivProtocol,
    usmAesCfb128Protocol, usmAesCfb192Protocol, usmAesCfb256Protocol,
    # commands
    bulkCmd, getCmd,
)

log = logging.getLogger(__name__)

# â”€â”€â”€ Protocol maps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

AUTH_PROTOCOLS = {
    "MD5":    usmHMACMD5AuthProtocol,
    "SHA":    usmHMACSHAAuthProtocol,
    "SHA-224": usmHMAC128SHA224AuthProtocol,
    "SHA-256": usmHMAC192SHA256AuthProtocol,
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

# â”€â”€â”€ OID constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

OID_SYS_NAME      = "1.3.6.1.2.1.1.5.0"
OID_SYS_DESCR     = "1.3.6.1.2.1.1.1.0"
OID_SYS_LOCATION  = "1.3.6.1.2.1.1.6.0"
OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"

OID_IF_DESCR       = "1.3.6.1.2.1.2.2.1.2"    # ifDescr
OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8"    # 1=up, 2=down
OID_IF_HIGH_SPEED  = "1.3.6.1.2.1.31.1.1.1.15" # ifHighSpeed Mbps
OID_IF_ALIAS       = "1.3.6.1.2.1.31.1.1.1.18" # ifAlias

# LLDP remote table
OID_LLDP_REM_SYS_NAME  = "1.0.8802.1.1.2.1.4.1.1.9"
OID_LLDP_REM_PORT_ID   = "1.0.8802.1.1.2.1.4.1.1.7"
OID_LLDP_REM_PORT_DESC = "1.0.8802.1.1.2.1.4.1.1.8"

# ARP table
OID_ARP_MAC = "1.3.6.1.2.1.4.22.1.2"
OID_ARP_IP  = "1.3.6.1.2.1.4.22.1.3"

# â”€â”€â”€ Vendor enterprise OIDs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Used to hard-identify vendor when sysDescr is ambiguous
VENDOR_OIDS: Dict[str, str] = {
    "1.3.6.1.4.1.47196": "aruba_cx",  # Aruba Networks (CX)
    "1.3.6.1.4.1.11":    "aruba_cx",  # Hewlett-Packard (legacy Aruba/HPE)
    "1.3.6.1.4.1.25506": "aruba_cx",  # H3C (some HPE rebrand)
    "1.3.6.1.4.1.52642": "fs",        # FS.COM (FSOS)
}

# sysDescr keywords per vendor (case-insensitive)
VENDOR_KEYWORDS: Dict[str, List[str]] = {
    "aruba_cx": ["arubaos-cx", "aruba cx", "arubacx"],
    "fs":       ["fsos", "fs s", "fs.com", " fss"],
}


# â”€â”€â”€ Data classes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    interfaces:     Dict[int, IfInfo]       = field(default_factory=dict)
    lldp_neighbors: List[LldpNeighbor]      = field(default_factory=list)
    arp_table:      Dict[str, str]          = field(default_factory=dict)  # macâ†’ip


# â”€â”€â”€ Credentials builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def build_auth(
    snmp_version: str,
    # v2c
    community: str = "public",
    # v3
    v3_security_level: str = "authPriv",
    v3_username: str = "",
    v3_auth_protocol: str = "SHA-256",
    v3_auth_password: str = "",
    v3_priv_protocol: str = "AES-128",
    v3_priv_password: str = "",
):
    """Return a pysnmp auth object (CommunityData or UsmUserData)."""
    if snmp_version == "v2c":
        return CommunityData(community, mpModel=1)  # mpModel=1 â†’ SNMPv2c

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


# â”€â”€â”€ Low-level SNMP helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _transport(ip: str, port: int = 161, timeout: int = 3, retries: int = 1):
    return UdpTransportTarget((ip, port), timeout=timeout, retries=retries)


def snmp_get(ip: str, port: int, auth, *oids: str) -> Dict[str, str]:
    """GET one or more scalar OIDs. Returns {oid_str: value_str}."""
    result: Dict[str, str] = {}
    objects = [ObjectType(ObjectIdentity(o)) for o in oids]
    try:
        error_indication, error_status, _, var_binds = next(
            getCmd(SnmpEngine(), auth, _transport(ip, port), ContextData(), *objects)
        )
        if error_indication or error_status:
            return result
        for vb in var_binds:
            result[str(vb[0])] = str(vb[1])
    except Exception as exc:
        log.debug("snmp_get %s: %s", ip, exc)
    return result


def snmp_bulk_walk(ip: str, port: int, auth,
                   oid: str, max_rows: int = 500) -> List[Tuple[str, str]]:
    """SNMPv2c/v3 GETBULK walk. Returns [(oid_str, value_str)]."""
    rows: List[Tuple[str, str]] = []
    try:
        for error_indication, error_status, _, var_binds in bulkCmd(
            SnmpEngine(), auth, _transport(ip, port), ContextData(),
            0, 25,
            ObjectType(ObjectIdentity(oid)),
            maxRows=max_rows, lexicographicMode=False,
        ):
            if error_indication or error_status:
                break
            for vb in var_binds:
                rows.append((str(vb[0]), str(vb[1])))
    except Exception as exc:
        log.debug("snmp_bulk_walk %s %s: %s", ip, oid, exc)
    return rows


# â”€â”€â”€ Vendor detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def detect_vendor(sys_descr: str, sys_object_id: str) -> str:
    """Identify vendor from sysDescr and sysObjectID."""
    # Try enterprise OID first (most reliable)
    for prefix, vendor in VENDOR_OIDS.items():
        if sys_object_id.startswith(prefix):
            return vendor
    # Fallback: sysDescr keywords
    descr_lower = sys_descr.lower()
    for vendor, keywords in VENDOR_KEYWORDS.items():
        if any(k in descr_lower for k in keywords):
            return vendor
    return "generic"


# â”€â”€â”€ Vendor-specific model extraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

_MODEL_ARUBA = re.compile(
    r"(Aruba(?:\s+CX)?\s+[\d]{4}[A-Za-z\-]*(?:\s+\d+[A-Za-z]+)?)",
    re.IGNORECASE,
)
_MODEL_FS = re.compile(
    r"(FS\s+[A-Z]\d+[\w\-]*)",
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
    m = _MODEL_GENERIC.search(sys_descr or "")
    return m.group(1) if m else ""


# â”€â”€â”€ Port filter helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

_VIRTUAL_GENERIC = ("loopback", "tunnel", "null", "vlan", "management", "mgmt",
                    "bridge", "cpu", "stack", "oob")

# Aruba CX: keep only physical 1/x/x ports. Skip VLAN, mgmt, loopback ports.
_VIRTUAL_ARUBA = ("loopback", "vlan", "tunnel", "mgmt", "oobm")

# FS.com (FSOS): keep Ethernet / GigabitEthernet / 10Ge / 25Ge / 100Ge
_VIRTUAL_FS = ("loopback", "vlan", "mgmt", "null", "stack")


def is_virtual(if_descr: str, vendor: str) -> bool:
    d = if_descr.lower()
    patterns = {
        "aruba_cx": _VIRTUAL_ARUBA,
        "fs":       _VIRTUAL_FS,
    }.get(vendor, _VIRTUAL_GENERIC)
    return any(p in d for p in patterns)


# â”€â”€â”€ Speed label helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def speed_label(mbps: int) -> str:
    if mbps >= 100_000: return "100G"
    if mbps >= 40_000:  return "40G"
    if mbps >= 25_000:  return "25G"
    if mbps >= 10_000:  return "10G"
    if mbps >= 1_000:   return "1G"
    if mbps >= 100:     return "100M"
    return "10M"


# â”€â”€â”€ Helper: last N OID components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _last_n(oid_str: str, n: int = 1) -> List[str]:
    return oid_str.rstrip(".").split(".")[-n:]


def _hex_to_mac(hex_str: str) -> str:
    clean = hex_str.replace("0x", "").replace(" ", "").replace(":", "")
    try:
        pairs = [clean[i:i+2] for i in range(0, len(clean), 2)]
        return ":".join(pairs).lower()
    except Exception:
        return hex_str


# â”€â”€â”€ Main scan function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def scan_switch(
    ip: str,
    # v2c
    snmp_version: str = "v2c",
    community: str = "public",
    snmp_port: int = 161,
    # v3
    v3_security_level: str = "authPriv",
    v3_username: str = "",
    v3_auth_protocol: str = "SHA-256",
    v3_auth_password: str = "",
    v3_priv_protocol: str = "AES-128",
    v3_priv_password: str = "",
) -> Optional[SwitchData]:
    """Full SNMP scan of one switch. Returns SwitchData or None on failure."""

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

    # â”€â”€ 1. System scalars â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    scalars = snmp_get(ip, snmp_port, auth,
                       OID_SYS_NAME, OID_SYS_DESCR,
                       OID_SYS_LOCATION, OID_SYS_OBJECT_ID)
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

    # â”€â”€ 2. Vendor detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    sw.vendor = detect_vendor(sw.sys_descr, sys_oid)
    log.info("Detected vendor=%s for %s (%s)", sw.vendor, ip, sw.sys_name)

    # â”€â”€ 3. Interface table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    descr_rows  = snmp_bulk_walk(ip, snmp_port, auth, OID_IF_DESCR)
    status_rows = snmp_bulk_walk(ip, snmp_port, auth, OID_IF_OPER_STATUS)
    hspeed_rows = snmp_bulk_walk(ip, snmp_port, auth, OID_IF_HIGH_SPEED)
    alias_rows  = snmp_bulk_walk(ip, snmp_port, auth, OID_IF_ALIAS)

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

    # â”€â”€ 4. LLDP neighbor table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    sys_rows  = snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_SYS_NAME)
    port_rows = snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_PORT_ID)
    pdesc_rows= snmp_bulk_walk(ip, snmp_port, auth, OID_LLDP_REM_PORT_DESC)

    nbr_map: Dict[Tuple[int, int], LldpNeighbor] = {}

    def _lldp_key(oid_s: str) -> Optional[Tuple[int, int]]:
        parts = oid_s.split(".")
        try:
            return int(parts[-2]), int(parts[-1])  # (localPort, remoteIndex)
        except (ValueError, IndexError):
            return None

    for oid_s, val in sys_rows:
        k = _lldp_key(oid_s)
        if k is None: continue
        local_port, remote_idx = k
        nbr_map.setdefault(k, LldpNeighbor(local_port_idx=local_port)).remote_sys = val

    for oid_s, val in port_rows:
        k = _lldp_key(oid_s)
        if k and k in nbr_map:
            nbr_map[k].remote_port = val

    for oid_s, val in pdesc_rows:
        k = _lldp_key(oid_s)
        if k and k in nbr_map:
            local_port = k[0]
            # prefer port ID; fill desc only if port not already set
            if not nbr_map[k].remote_port:
                nbr_map[k].remote_port = val
            if local_port in sw.interfaces:
                nbr_map[k].local_port_desc = sw.interfaces[local_port].descr

    sw.lldp_neighbors = list(nbr_map.values())

    # â”€â”€ 5. ARP table (best-effort) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    arp_mac_rows = snmp_bulk_walk(ip, snmp_port, auth, OID_ARP_MAC)
    arp_ip_rows  = snmp_bulk_walk(ip, snmp_port, auth, OID_ARP_IP)
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

    log.info("Scanned %s (%s) vendor=%s: %d ifaces, %d LLDP nbrs",
             ip, sw.sys_name, sw.vendor, len(sw.interfaces), len(sw.lldp_neighbors))
    return sw


# â”€â”€â”€ Auto-layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
