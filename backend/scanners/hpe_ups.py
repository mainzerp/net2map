"""HPE UPS Network Module vendor scanner (CPQPOWER-MIB, enterprise 232.165)."""
import re

from scanners.base import VendorScanner
from scanners.health import CPQPOWER_UPS_SCALAR_OIDS, collect_ups_health

_MODEL_HPE_UPS = re.compile(
    r"((?:HPE?\s+)?(?:UPS\s+)?R\d{3,5}\w*|HPE?\s+UPS\s+[\w\-]+)",
    re.IGNORECASE,
)


class HpeUpsScanner(VendorScanner, vendor_id="hpe_ups"):

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_HPE_UPS.search(sys_descr or "")
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
        # RFC 1628 first; the CPQPOWER-MIB UPS branch fills missing values.
        return await collect_ups_health(snmp_get, snmp_walk, extra_oids=CPQPOWER_UPS_SCALAR_OIDS)
