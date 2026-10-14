"""Pure OID / MAC parsing helpers for SNMP walk results.

Kept free of pysnmp dependencies so the logic stays unit-testable in
environments without pysnmp.
"""
from typing import Dict, List, Optional, Tuple

_HEX_DIGITS = frozenset("0123456789abcdef")


def _hex_to_mac(hex_str: str) -> str:
    """Normalize a hex MAC rendering to "aa:bb:cc:dd:ee:ff".

    Accepts an optional "0x" prefix and ":", "-", "." or space separators.
    Returns "" unless exactly 12 hex digits remain, so decoded text (e.g. an
    OCTET STRING rendered as ASCII) never turns into a pseudo-MAC.
    """
    if not isinstance(hex_str, str):
        return ""
    clean = hex_str.strip().lower()
    if clean.startswith("0x"):
        clean = clean[2:]
    for sep in (":", "-", ".", " "):
        clean = clean.replace(sep, "")
    if len(clean) != 12 or not set(clean) <= _HEX_DIGITS:
        return ""
    return ":".join(clean[i:i + 2] for i in range(0, 12, 2))


def mac_from_octets(value) -> str:
    """Convert a MAC-typed SNMP value (PhysAddress / MacAddress) to "aa:bb:cc:dd:ee:ff".

    Raw 6-byte values always decode from the bytes, even when every byte is
    printable ASCII. Other byte lengths are treated as a textual hex rendering
    (some agents return "00:11:22:33:44:55" as text); strings go through
    _hex_to_mac. Returns "" when no valid MAC can be derived.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return _hex_to_mac(value)
    try:
        raw = bytes(value)
    except Exception:
        return ""
    if len(raw) == 6:
        return ":".join(f"{b:02x}" for b in raw)
    try:
        return _hex_to_mac(raw.decode("ascii"))
    except UnicodeDecodeError:
        return ""


# LLDP-MIB LldpPortIdSubtype values used for local port mapping
_LLDP_PORT_ID_INTERFACE_ALIAS = 1
_LLDP_PORT_ID_INTERFACE_NAME = 5
_LLDP_PORT_ID_LOCAL = 7


def _last_index(oid_str: str) -> Optional[int]:
    try:
        return int(oid_str.rstrip(".").split(".")[-1])
    except (ValueError, IndexError):
        return None


def _unique_name_index(names: Dict[int, str]) -> Dict[str, int]:
    """Build {normalized name: ifIndex}, dropping empty and ambiguous names."""
    seen: Dict[str, int] = {}
    ambiguous: set = set()
    for idx, name in names.items():
        key = (name or "").strip().lower()
        if not key:
            continue
        if key in seen and seen[key] != idx:
            ambiguous.add(key)
        seen[key] = idx
    return {k: v for k, v in seen.items() if k not in ambiguous}


def map_lldp_local_ports(
    subtype_rows: List[Tuple[str, str]],
    port_id_rows: List[Tuple[str, str]],
    port_desc_rows: List[Tuple[str, str]],
    if_descr: Dict[int, str],
    if_name: Optional[Dict[int, str]] = None,
    if_alias: Optional[Dict[int, str]] = None,
) -> Dict[int, int]:
    """Map lldpLocPortNum -> ifIndex from the lldpLocPortTable walks.

    lldpRemLocalPortNum refers to lldpLocPortNum, which is not necessarily
    the ifIndex. Resolution order per local port:
      1. subtype local(7) with a numeric port id equal to a known ifIndex;
      2. port id matched against ifName, then ifDescr (ifAlias only for
         subtype interfaceAlias(1));
      3. lldpLocPortDesc matched against ifDescr, then ifName.
    Names that are empty or shared by several interfaces never match. Ports
    without a match are omitted; callers fall back to treating the port
    number as the ifIndex (legacy behavior).
    """
    if_name = if_name or {}
    if_alias = if_alias or {}
    known = set(if_descr) | set(if_name) | set(if_alias)
    by_descr = _unique_name_index(if_descr)
    by_name = _unique_name_index(if_name)
    by_alias = _unique_name_index(if_alias)

    subtypes: Dict[int, int] = {}
    for oid_s, val in subtype_rows:
        num = _last_index(oid_s)
        sub = _to_int(val)
        if num is not None and sub is not None:
            subtypes[num] = sub
    port_ids = {n: (v or "").strip() for n, v in ((_last_index(o), v) for o, v in port_id_rows) if n is not None}
    port_descs = {n: (v or "").strip() for n, v in ((_last_index(o), v) for o, v in port_desc_rows) if n is not None}

    result: Dict[int, int] = {}
    for num in set(subtypes) | set(port_ids) | set(port_descs):
        subtype = subtypes.get(num)
        port_id = port_ids.get(num, "")
        port_desc = port_descs.get(num, "")
        key_id = port_id.lower()
        key_desc = port_desc.lower()

        if subtype == _LLDP_PORT_ID_LOCAL and port_id.isdigit() and int(port_id) in known:
            result[num] = int(port_id)
            continue
        candidates = []
        if key_id:
            if subtype == _LLDP_PORT_ID_INTERFACE_ALIAS:
                candidates.append(by_alias.get(key_id))
            candidates.extend((by_name.get(key_id), by_descr.get(key_id)))
        if key_desc:
            candidates.extend((by_descr.get(key_desc), by_name.get(key_desc)))
        match = next((c for c in candidates if c is not None), None)
        if match is not None:
            result[num] = match
    return result


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
