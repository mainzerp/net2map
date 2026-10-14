"""OPNsense / FreeBSD vendor scanner."""
import re

from scanners.base import VendorScanner

_MODEL_OPNSENSE = re.compile(
    r"(OPNsense[\w\.\- ]*|FreeBSD[\w\.\- ]*)",
    re.IGNORECASE,
)

_VIRTUAL_OPNSENSE = (
    "lo", "loopback", "vlan", "pppoe", "lagg", "enc", "pflog",
    "pfsync", "tun", "tap", "ovpn", "openvpn", "wg", "ng",
    "ipsec", "gif", "gre", "bridge", "vxlan", "carp",
)


class OPNsenseScanner(VendorScanner, vendor_id="opnsense"):
    MODEL_PATTERN = _MODEL_OPNSENSE
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_OPNSENSE
    # OPNsense/FreeBSD interfaces start with a fixed type prefix (lo0,
    # vlan100, tun0).  Using startswith avoids false positives like
    # "mlxen0" matching "lo".
    VIRTUAL_PORT_MATCH = "prefix"

    def fdb_strategy(self) -> str:
        return "dot1d"

    def supports_stp(self) -> bool:
        # Firewall: no bridge spanning tree to report.
        return False

    def device_type(self) -> str:
        return "firewall"
