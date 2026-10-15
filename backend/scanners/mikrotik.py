"""MikroTik RouterOS / SwOS vendor scanner."""
import re

from scanners.base import VendorScanner

# RouterOS sysDescr is "RouterOS <board name>", e.g. "RouterOS CRS326-24G-2S+".
_MODEL_MIKROTIK = re.compile(r"\b(?:RouterOS|SwOS)\s+([A-Za-z][\w+\-]*)")

# Some builds put the version into sysDescr ("RouterOS 7.12.1 (stable) ...").
_VERSION_MIKROTIK = re.compile(r"\b(?:RouterOS|SwOS)\s+v?(\d+\.\d+[\w.]*)", re.IGNORECASE)

# MIKROTIK-MIB: mtxrLicVersion (RouterOS version), mtxrFirmwareVersion
# (RouterBOOT version, only used when the former is missing).
_FIRMWARE_OIDS_MIKROTIK = (
    "1.3.6.1.4.1.14988.1.1.4.4.0",
    "1.3.6.1.4.1.14988.1.1.7.4.0",
)

# RouterOS interface names keep the default type prefix unless renamed
# (ether1, sfp-sfpplus1 stay physical; bridge, vlan10, pppoe-out1 are virtual).
_VIRTUAL_MIKROTIK = (
    "lo", "bridge", "vlan", "bond", "pppoe", "pptp", "l2tp", "sstp", "ovpn",
    "gre", "eoip", "ipip", "6to4", "vrrp", "wireguard", "wg", "veth", "vxlan",
    "zerotier", "container",
)


class MikroTikScanner(VendorScanner, vendor_id="mikrotik"):
    MODEL_PATTERN = _MODEL_MIKROTIK
    VERSION_PATTERN = _VERSION_MIKROTIK
    FIRMWARE_OIDS = _FIRMWARE_OIDS_MIKROTIK
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_MIKROTIK
    # Prefix matching avoids false positives like "sfp-sfpplus1" matching "lo".
    VIRTUAL_PORT_MATCH = "prefix"

    def fdb_strategy(self) -> str:
        # Bridge hosts are exposed via BRIDGE-MIB; the scan falls back to
        # Q-BRIDGE-MIB when the dot1d walk is empty.
        return "dot1d"
