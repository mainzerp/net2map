"""FS.com (FSOS) vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_FS = re.compile(
    r"(FS\s+[A-Z]\d+[\w\-]*)",
    re.IGNORECASE,
)

_VIRTUAL_FS = ("loopback", "vlan", "mgmt", "null", "stack")


class FSScanner(VendorScanner, vendor_id="fs"):
    MODEL_PATTERN = _MODEL_FS
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_FS

    def fdb_strategy(self) -> str:
        return "dot1d"
