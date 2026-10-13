"""Eaton / MGE UPS network card vendor scanner (Network-M2, Gigabit Network Card)."""
import re

from scanners.base import VendorScanner
from scanners.health import XUPS_SCALAR_OIDS, collect_ups_health

_MODEL_EATON = re.compile(
    r"((?:Eaton|MGE|Powerware)\s+[\w\-]+(?:\s+[\w\-]+)?)",
    re.IGNORECASE,
)


class EatonScanner(VendorScanner, vendor_id="eaton"):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_EATON.search(sys_descr or "")
        return m.group(1).strip() if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        return (if_descr or "").lower().startswith(("lo", "loopback"))

    def fdb_strategy(self) -> str:
        return "dot1d"

    def supports_stp(self) -> bool:
        return False

    def supports_fdb(self) -> bool:
        return False

    def device_type(self) -> str:
        return "ups"

    async def collect_health(self, snmp_get, snmp_walk) -> dict | None:
        # RFC 1628 first; the Eaton XUPS-MIB fills values the card omits.
        return await collect_ups_health(snmp_get, snmp_walk, extra_oids=XUPS_SCALAR_OIDS)
