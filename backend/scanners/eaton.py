"""Eaton / MGE UPS network card vendor scanner (Network-M2, Gigabit Network Card)."""
import re

from scanners.base import VendorScanner
from scanners.health import XUPS_SCALAR_OIDS, collect_ups_health

_MODEL_EATON = re.compile(
    r"((?:Eaton|MGE|Powerware)\s+[\w\-]+(?:\s+[\w\-]+)?)",
    re.IGNORECASE,
)


class EatonScanner(VendorScanner, vendor_id="eaton"):
    MODEL_PATTERN = _MODEL_EATON
    MODEL_STRIP = True
    VIRTUAL_PORT_PATTERNS = ("lo", "loopback")
    VIRTUAL_PORT_MATCH = "prefix"

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
