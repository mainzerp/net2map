"""Cisco (IOS / IOS-XE / NX-OS) vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_CISCO = re.compile(
    r"(Cisco\s+[\w\-]+|WS-C[\w\-]+|C9[23]\d{2}[\w\-]*)",
    re.IGNORECASE,
)

# IOS / IOS-XE sysDescr carries the firmware after "Version", including the
# parenthesized train suffix, e.g. "Version 15.2(7)E4, RELEASE SOFTWARE (fc1)"
_VERSION_CISCO = re.compile(r"Version\s+([0-9A-Za-z.\-_()]+)", re.IGNORECASE)

_VIRTUAL_CISCO = (
    "loopback", "vlan", "tunnel", "null", "mgmt", "management",
    "port-channel", "stackport", "stack-sub", "nve",
)


class CiscoScanner(VendorScanner, vendor_id="cisco"):
    MODEL_PATTERN = _MODEL_CISCO
    VERSION_PATTERN = _VERSION_CISCO
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_CISCO

    def fdb_strategy(self) -> str:
        return "dot1d"

    def supports_stp(self) -> bool:
        # Only the default instance is read via the plain community / context.
        # PVST+ / Rapid-PVST+ per-VLAN instances need community@vlan (v2c) or
        # context "vlan-<id>" (v3) and are out of scope.
        return True
