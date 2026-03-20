"""FS.com (FSOS) vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_FS = re.compile(
    r"(FS\s+[A-Z]\d+[\w\-]*)",
    re.IGNORECASE,
)

_VIRTUAL_FS = ("loopback", "vlan", "mgmt", "null", "stack")


class FSScanner(VendorScanner, vendor_id="fs"):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_FS.search(sys_descr or "")
        return m.group(1) if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        d = if_descr.lower()
        return any(p in d for p in _VIRTUAL_FS)

    def fdb_strategy(self) -> str:
        return "dot1d"
