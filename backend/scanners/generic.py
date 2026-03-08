"""Generic / fallback vendor scanner for unknown vendors."""
import re

from scanners.base import VendorScanner

_MODEL_GENERIC = re.compile(
    r"(Aruba\s+CX\s+[\w\-]+|HPE?\s+[\w\-]+|Cisco\s+[\w\-]+|FS\s+[\w\-]+|FSOS\s+[\w\-]+)",
    re.IGNORECASE,
)

_VIRTUAL_GENERIC = (
    "loopback", "tunnel", "null", "vlan", "management", "mgmt",
    "bridge", "cpu", "stack", "oob",
)


class GenericScanner(VendorScanner):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_GENERIC.search(sys_descr or "")
        return m.group(1) if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        d = if_descr.lower()
        return any(p in d for p in _VIRTUAL_GENERIC)

    def fdb_strategy(self) -> str:
        return "dot1d"
