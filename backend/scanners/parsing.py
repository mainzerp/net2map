"""Pure OID / MAC parsing helpers for SNMP walk results.

Kept free of pysnmp dependencies so the logic stays unit-testable in
environments without pysnmp.
"""
from typing import Dict, List, Tuple


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
