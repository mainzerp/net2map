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

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_CISCO.search(sys_descr or "")
        return m.group(1) if m else ""

    def extract_version(self, sys_descr: str | None) -> str:
        m = _VERSION_CISCO.search(sys_descr or "")
        return m.group(1) if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        d = if_descr.lower()
        return any(p in d for p in _VIRTUAL_CISCO)

    def fdb_strategy(self) -> str:
        return "dot1d"
