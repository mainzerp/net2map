"""Aruba CX vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_ARUBA = re.compile(
    r"(Aruba(?:\s+CX)?\s+[\d]{4}[A-Za-z\-]*(?:\s+\d+[A-Za-z]+)?)",
    re.IGNORECASE,
)

_VIRTUAL_ARUBA = ("loopback", "vlan", "tunnel", "mgmt", "oobm", "lag")


class ArubaCXScanner(VendorScanner, vendor_id="aruba_cx"):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_ARUBA.search(sys_descr or "")
        return m.group(1) if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        d = if_descr.lower()
        return any(p in d for p in _VIRTUAL_ARUBA)

    def fdb_strategy(self) -> str:
        return "dot1d"
