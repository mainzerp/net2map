"""UniFi / Ubiquiti vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_UNIFI = re.compile(
    r"((?:UniFi|Ubiquiti)\s+[\w\- ]+|USW\-[\w\-]+)",
    re.IGNORECASE,
)

_VIRTUAL_UNIFI = ("loopback", "vlan", "bridge", "cpu", "mgmt")


class UniFiScanner(VendorScanner):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_UNIFI.search(sys_descr or "")
        return m.group(1) if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        d = if_descr.lower()
        return any(p in d for p in _VIRTUAL_UNIFI)

    def fdb_strategy(self) -> str:
        return "qbridge"
