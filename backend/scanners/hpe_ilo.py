"""HPE ProLiant server management vendor scanner (iLO / Insight agents, enterprise 232)."""
import re

from scanners.base import VendorScanner
from scanners.health import collect_server_health

_MODEL_HPE_ILO = re.compile(
    r"(ProLiant\s+[\w\-]+(?:\s+Gen\d+)?|Synergy\s+[\w\-]+(?:\s+Gen\d+)?|Apollo\s+[\w\-]+)",
    re.IGNORECASE,
)


class HpeIloScanner(VendorScanner, vendor_id="hpe_ilo"):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_HPE_ILO.search(sys_descr or "")
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
        return "server"

    async def collect_health(self, snmp_get, snmp_walk) -> dict | None:
        return await collect_server_health(snmp_get, snmp_walk)
