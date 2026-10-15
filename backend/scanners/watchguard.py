"""WatchGuard Firebox (Fireware OS) vendor scanner."""
import re

from scanners.base import VendorScanner

# Firebox models: T-series (T45, T85-PoE), M-series (M370, M4800), legacy XTM
# (XTM 330) and virtual FireboxV / Firebox Cloud.
_MODEL_WATCHGUARD = re.compile(
    r"\b((?:Firebox\s*)?(?:XTM\s*\d{2,4}\w*|[MT]\d{2,4}(?:-[\w]+)?|FireboxV\w*|Firebox\s+Cloud))",
    re.IGNORECASE,
)

# e.g. "WatchGuard Fireware v12.10.3.B690003" or "Fireware OS Version 12.8.2"
_VERSION_WATCHGUARD = re.compile(
    r"(?:Fireware(?:\s+OS)?\s+(?:Version\s+)?v?|Version\s+|\bv)(\d+\.\d+[\w.]*)",
    re.IGNORECASE,
)

# Fireware (Linux based) interface names: eth0..ethN are physical; VLANs,
# bridges, VPN and tunnel interfaces are virtual.
_VIRTUAL_WATCHGUARD = (
    "lo", "vlan", "br", "bvi", "bond", "ppp", "tun", "tap", "gre", "ipsec",
    "sslvpn", "bovpn", "mvpn", "wg", "vif", "dummy",
)


class WatchGuardScanner(VendorScanner, vendor_id="watchguard"):
    MODEL_PATTERN = _MODEL_WATCHGUARD
    MODEL_STRIP = True
    VERSION_PATTERN = _VERSION_WATCHGUARD
    VIRTUAL_PORT_PATTERNS = _VIRTUAL_WATCHGUARD
    VIRTUAL_PORT_MATCH = "prefix"

    def fdb_strategy(self) -> str:
        return "dot1d"

    def supports_stp(self) -> bool:
        # Firewall: no bridge spanning tree to report.
        return False

    def device_type(self) -> str:
        return "firewall"
