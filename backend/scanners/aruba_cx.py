"""Aruba CX vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_ARUBA = re.compile(
    r"(Aruba(?:\s+CX)?\s+[\d]{4}[A-Za-z\-]*(?:\s+\d+[A-Za-z]+)?)",
    re.IGNORECASE,
)

# ArubaOS-CX sysDescr carries the firmware after "SW:", e.g. "SW: FL.10.12.0010"
_VERSION_ARUBA = re.compile(r"SW:\s*([0-9A-Za-z.\-_]+)", re.IGNORECASE)

_VIRTUAL_ARUBA = ("loopback", "vlan", "tunnel", "mgmt", "oobm", "lag")


class ArubaCXScanner(VendorScanner, vendor_id="aruba_cx"):
    MODEL_PATTERN = _MODEL_ARUBA
    VERSION_PATTERN = _VERSION_ARUBA
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_ARUBA

    def fdb_strategy(self) -> str:
        return "dot1d"
