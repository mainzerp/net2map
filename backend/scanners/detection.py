"""Vendor detection from sysDescr / sysObjectID.

Kept free of pysnmp dependencies so the logic stays unit-testable in
environments without pysnmp.
"""
import re
from typing import Dict, List

# --- Vendor enterprise OIDs ---------------------------------------------------
# Deliberately conservative: only unambiguous enterprise roots are mapped.
# Broad roots are NOT mapped on purpose:
#   - 1.3.6.1.4.1.8072  Net-SNMP: any Linux/FreeBSD host, not necessarily OPNsense
#   - 1.3.6.1.4.1.11    all of HP/HPE, not necessarily Aruba CX
#   - 1.3.6.1.4.1.25506 H3C, not necessarily Aruba CX
# Devices behind those roots fall through to keyword matching; ambiguous ones
# become "generic".
VENDOR_OIDS: Dict[str, str] = {
    "1.3.6.1.4.1.47196": "aruba_cx",  # Aruba Networks (CX)
    "1.3.6.1.4.1.52642": "fs",        # FS.COM (FSOS)
    "1.3.6.1.4.1.41112": "unifi",     # Ubiquiti / UniFi
    "1.3.6.1.4.1.9":     "cisco",     # Cisco Systems
}

# sysDescr keyword patterns per vendor: case-insensitive regexes anchored on
# word boundaries so short tokens (e.g. "u7") cannot match inside longer
# strings (e.g. "mtu7500").
VENDOR_KEYWORDS: Dict[str, List[str]] = {
    "aruba_cx": [r"arubaos-cx", r"aruba[ \-]?cx\b", r"\barubacx\b"],
    "fs":       [r"\bfsos\b", r"\bfs\s+s\d", r"\bfs\.com\b", r"\bfss\b"],
    "unifi":    [r"\bunifi\b", r"\bubiquiti\b", r"\busw\b", r"\bu7\b", r"\budm\b", r"\buxg\b"],
    "opnsense": [r"\bopnsense\b", r"\bfreebsd\b"],
    "cisco":    [r"\bcisco\b", r"\bios[- ]xe\b", r"\bcatalyst\b"],
}

_VENDOR_KEYWORD_RES: Dict[str, List["re.Pattern"]] = {
    vendor: [re.compile(p, re.IGNORECASE) for p in patterns]
    for vendor, patterns in VENDOR_KEYWORDS.items()
}


def _normalize_oid(oid: str) -> str:
    """Strip surrounding whitespace and a leading dot from a dotted OID."""
    return (oid or "").strip().lstrip(".")


def oid_has_prefix(oid: str, prefix: str) -> bool:
    """Return True if ``oid`` equals ``prefix`` or lies beneath it.

    Matching respects arc boundaries: ``1.3.6.1.4.1.9`` matches
    ``1.3.6.1.4.1.9`` and ``1.3.6.1.4.1.9.1.1208`` but not
    ``1.3.6.1.4.1.9999.1``.
    """
    oid = _normalize_oid(oid)
    prefix = _normalize_oid(prefix)
    if not oid or not prefix:
        return False
    return oid == prefix or oid.startswith(prefix + ".")


def _vendor_from_oid(sys_object_id: str) -> str:
    """Map a sysObjectID to a vendor via VENDOR_OIDS; longest prefix wins.

    Returns an empty string when no enterprise prefix matches.
    """
    best_prefix = ""
    best_vendor = ""
    for prefix, vendor in VENDOR_OIDS.items():
        if oid_has_prefix(sys_object_id, prefix) and len(prefix) > len(best_prefix):
            best_prefix, best_vendor = prefix, vendor
    return best_vendor


def detect_vendor(sys_descr: str, sys_object_id: str) -> str:
    """Identify vendor from sysDescr and sysObjectID.

    sysObjectID mappings are intentionally conservative (see VENDOR_OIDS) and
    matched on OID arc boundaries with longest-prefix-wins; keyword matching
    uses word-boundary-anchored regexes. Ambiguous devices fall back to
    "generic".
    """
    oid_vendor = _vendor_from_oid(sys_object_id)
    if oid_vendor:
        return oid_vendor
    for vendor, patterns in _VENDOR_KEYWORD_RES.items():
        if any(p.search(sys_descr or "") for p in patterns):
            return vendor
    return "generic"
