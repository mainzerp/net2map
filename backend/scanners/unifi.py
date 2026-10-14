"""UniFi / Ubiquiti vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_UNIFI = re.compile(
    r"((?:UniFi|Ubiquiti)\s+[\w\- ]+|USW\-[\w\-]+)",
    re.IGNORECASE,
)

# UniFi sysDescr carries a four-part dotted firmware version, e.g.
# "USW-Pro-48-PoE, 6.5.59.14722, Linux 4.4.253"
_VERSION_UNIFI = re.compile(r"\b(\d+\.\d+\.\d+\.\d+)\b")

_VIRTUAL_UNIFI = ("loopback", "vlan", "bridge", "cpu", "mgmt")


class UniFiScanner(VendorScanner, vendor_id="unifi"):
    MODEL_PATTERN = _MODEL_UNIFI
    VERSION_PATTERN = _VERSION_UNIFI
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_UNIFI

    def fdb_strategy(self) -> str:
        return "qbridge"
