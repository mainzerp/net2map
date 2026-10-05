"""Pure OID / MAC parsing helpers for SNMP walk results.

Kept free of pysnmp dependencies so the logic stays unit-testable in
environments without pysnmp.
"""
from typing import Dict, List, Optional, Tuple


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


def _oid_to_mac_qbridge(oid_str: str) -> str:
    """Extract only the MAC portion of a Q-Bridge OID index (last 6 components).

    The Q-Bridge index format is {VLAN}.{6 MAC bytes}; the VLAN component is
    ignored here. Use _oid_to_vlan_mac_qbridge() when the VLAN matters (the
    same MAC can be learned in multiple VLANs).
    """
    try:
        parts = oid_str.rstrip(".").split(".")
        # parts[-7] = VLAN id, parts[-6:] = 6 MAC octets
        octets = [int(x) for x in parts[-6:]]
        if len(octets) != 6 or any(o < 0 or o > 255 for o in octets):
            return ""
        return ":".join(f"{o:02x}" for o in octets)
    except Exception:
        return ""


def _oid_to_vlan_mac_qbridge(oid_str: str) -> Tuple[int, str]:
    """Extract (VLAN, MAC) from a Q-Bridge OID index: last 7 components are
    {VLAN}.{6 MAC bytes}. Returns (0, "") on parse failure."""
    try:
        parts = oid_str.rstrip(".").split(".")
        vlan = int(parts[-7])
        octets = [int(x) for x in parts[-6:]]
        if len(octets) != 6 or any(o < 0 or o > 255 for o in octets):
            return 0, ""
        return vlan, ":".join(f"{o:02x}" for o in octets)
    except Exception:
        return 0, ""


def resolve_fdb_candidates(
    fdb_rows: List[Tuple[str, str]],
    fdb_strategy: str,
    bridge_to_ifindex: Dict[int, int],
    known_ifindexes,
) -> Dict[str, int]:
    """Build mac -> ifindex from FDB walk rows.

    Q-Bridge rows are indexed per VLAN, so the same MAC may appear several
    times; collisions are resolved deterministically: prefer a candidate whose
    ifIndex is a known interface of the switch, then the lowest VLAN id --
    instead of letting walk order silently overwrite entries.
    """
    candidates: Dict[str, List[Tuple[int, int]]] = {}  # mac -> [(vlan, ifindex)]
    for oid_s, bridge_port_val in fdb_rows:
        if fdb_strategy == "qbridge":
            vlan, mac = _oid_to_vlan_mac_qbridge(oid_s)
        else:
            vlan, mac = 0, _oid_to_mac(oid_s)
        if not mac:
            continue
        try:
            bridge_port = int(bridge_port_val)
        except (TypeError, ValueError):
            continue
        ifindex = bridge_to_ifindex.get(bridge_port)
        if ifindex is not None:
            candidates.setdefault(mac, []).append((vlan, ifindex))

    result: Dict[str, int] = {}
    for mac, entries in candidates.items():
        known = [c for c in entries if c[1] in known_ifindexes]
        pool = known or entries
        pool.sort(key=lambda c: (c[0], c[1]))
        result[mac] = pool[0][1]
    return result


# --- Spanning tree (BRIDGE-MIB / RSTP-MIB) and VLAN names ---------------------

# BRIDGE-MIB dot1dStpPortState. RSTP "discarding" is reported as blocking(2).
STP_PORT_STATES = {
    1: "disabled",
    2: "blocking",
    3: "listening",
    4: "learning",
    5: "forwarding",
    6: "broken",
}

# RSTP-MIB dot1dStpVersion
_STP_VERSIONS = {0: "stp", 2: "rstp", 3: "mstp"}

# BRIDGE-MIB dot1dStpProtocolSpecification: ieee8021d(3)
_STP_SPEC_IEEE8021D = 3


def _to_int(value) -> Optional[int]:
    """Convert an SNMP integer value (int, pysnmp Integer, numeric str) to int."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _to_bytes(value) -> Optional[bytes]:
    """Convert an OCTET STRING value to bytes.

    Accepts raw bytes, pysnmp OctetString (anything supporting bytes()), and
    hex string renderings as PySNMP may produce them ("0x8000aabb...",
    "80:00:aa:bb...", "80 00 aa bb ...", plain hex).
    """
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        clean = value.strip().lower()
        if clean.startswith("0x"):
            clean = clean[2:]
        clean = clean.replace(":", "").replace(" ", "").replace("-", "").replace(".", "")
        try:
            return bytes.fromhex(clean)
        except ValueError:
            return None
    try:
        return bytes(value)
    except Exception:
        return None


def format_bridge_id(priority: Optional[int], mac: bytes) -> Optional[str]:
    """Format a bridge ID as '<prio as 4 lowercase hex>.<mac as 12 lowercase hex>'."""
    if priority is None or mac is None or len(mac) != 6:
        return None
    if not 0 <= priority <= 0xFFFF:
        return None
    return f"{priority:04x}.{mac.hex()}"


def parse_bridge_id(value) -> Optional[str]:
    """Parse an 8-octet BRIDGE-MIB BridgeId (2 bytes priority + 6 bytes MAC)."""
    raw = _to_bytes(value)
    if raw is None or len(raw) != 8:
        return None
    return format_bridge_id(int.from_bytes(raw[:2], "big"), raw[2:])


def build_bridge_id(priority, base_address) -> Optional[str]:
    """Build this bridge's ID from dot1dStpPriority and dot1dBaseBridgeAddress."""
    mac = _to_bytes(base_address)
    if mac is None or len(mac) != 6:
        return None
    return format_bridge_id(_to_int(priority), mac)


def stp_protocol_from(version, protocol_spec) -> str:
    """Map RSTP-MIB dot1dStpVersion to stp|rstp|mstp, with a fallback to
    dot1dStpProtocolSpecification (ieee8021d -> stp), else 'unknown'."""
    v = _to_int(version)
    if v in _STP_VERSIONS:
        return _STP_VERSIONS[v]
    if _to_int(protocol_spec) == _STP_SPEC_IEEE8021D:
        return "stp"
    return "unknown"


def stp_state_from(value) -> Optional[str]:
    """Map a dot1dStpPortState integer to its name (None when unknown)."""
    return STP_PORT_STATES.get(_to_int(value))


def derive_stp_role(state: Optional[str], is_root_port: bool) -> Optional[str]:
    """Derive a port role from its STP state and whether it is the root port."""
    if state is None:
        return None
    if state == "disabled":
        return "disabled"
    if is_root_port:
        return "root"
    if state in ("blocking", "broken"):
        return "blocked"
    if state in ("forwarding", "learning", "listening"):
        return "designated"
    return None


def parse_vlan_names(rows: List[Tuple[str, str]]) -> Dict[str, str]:
    """Build {vlan_id_str: name} from dot1qVlanStaticName walk rows.

    The VLAN id is the last OID component; empty names are skipped.
    """
    names: Dict[str, str] = {}
    for oid_s, val in rows:
        try:
            vlan_id = int(oid_s.rstrip(".").split(".")[-1])
        except (ValueError, IndexError):
            continue
        if not 1 <= vlan_id <= 4094:
            continue
        name = (val or "").strip()
        if name:
            names[str(vlan_id)] = name
    return names


def parse_bridge_port_rows(rows: List[Tuple[str, str]]) -> Dict[int, int]:
    """Build {bridge_port: int_value} from a walk indexed by bridge port."""
    result: Dict[int, int] = {}
    for oid_s, val in rows:
        try:
            bridge_port = int(oid_s.rstrip(".").split(".")[-1])
        except (ValueError, IndexError):
            continue
        num = _to_int(val)
        if num is not None:
            result[bridge_port] = num
    return result


def build_stp_info(
    scalars: Dict[str, object],
    state_rows: List[Tuple[str, str]],
    cost_rows: List[Tuple[str, str]],
    bridge_to_ifindex: Dict[int, int],
    port_name_by_ifindex: Dict[int, str],
    *,
    oid_priority: str,
    oid_base_address: str,
    oid_designated_root: str,
    oid_root_cost: str,
    oid_root_port: str,
    oid_version: str,
    oid_protocol_spec: str,
) -> Tuple[Optional[dict], Dict[int, dict]]:
    """Combine STP scalar GET results and per-port walks.

    Returns (bridge_info, per_ifindex) where bridge_info is a dict with the
    keys protocol, bridge_id, root_id, root_cost, root_port, or None when the
    device reports no STP data at all; per_ifindex maps ifIndex -> {state,
    role, path_cost}. Never raises on malformed input.
    """
    bridge_id = build_bridge_id(scalars.get(oid_priority), scalars.get(oid_base_address))
    root_id = parse_bridge_id(scalars.get(oid_designated_root))
    root_cost = _to_int(scalars.get(oid_root_cost))
    root_bp = _to_int(scalars.get(oid_root_port))
    version = scalars.get(oid_version)
    spec = scalars.get(oid_protocol_spec)

    states = {bp: stp_state_from(v) for bp, v in parse_bridge_port_rows(state_rows).items()}
    costs = parse_bridge_port_rows(cost_rows)

    root_port_name: Optional[str] = None
    if root_bp:
        ifindex = bridge_to_ifindex.get(root_bp)
        if ifindex is not None:
            root_port_name = port_name_by_ifindex.get(ifindex) or None

    per_ifindex: Dict[int, dict] = {}
    for bp in set(states) | set(costs):
        ifindex = bridge_to_ifindex.get(bp)
        if ifindex is None:
            continue
        state = states.get(bp)
        per_ifindex[ifindex] = {
            "state": state,
            "role": derive_stp_role(state, bool(root_bp) and bp == root_bp),
            "path_cost": costs.get(bp),
        }

    has_data = any(x is not None for x in (bridge_id, root_id, _to_int(version), _to_int(spec))) \
        or bool(per_ifindex)
    if not has_data:
        return None, per_ifindex

    return {
        "protocol": stp_protocol_from(version, spec),
        "bridge_id": bridge_id,
        "root_id": root_id,
        "root_cost": root_cost,
        "root_port": root_port_name,
    }, per_ifindex
