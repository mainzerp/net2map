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


class GenericScanner(VendorScanner, vendor_id="generic"):
    MODEL_PATTERN = _MODEL_GENERIC
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_GENERIC

    def fdb_strategy(self) -> str:
        return "dot1d"
