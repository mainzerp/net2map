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

    def extract_model(self, sys_descr: str) -> str:
        m = _MODEL_OPNSENSE.search(sys_descr or "")
        return m.group(1) if m else ""

    def is_virtual_port(self, if_descr: str) -> bool:
        # OPNsense/FreeBSD interfaces start with a fixed type prefix (lo0,
        # vlan100, tun0).  Using startswith avoids false positives like
        # "mlxen0" matching "lo".
        d = if_descr.lower()
        return any(d.startswith(p) for p in _VIRTUAL_OPNSENSE)

    def fdb_strategy(self) -> str:
        return "dot1d"
