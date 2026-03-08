"""Vendor scanner plugin registry."""
from scanners.aruba_cx import ArubaCXScanner
from scanners.fs_scanner import FSScanner
from scanners.unifi import UniFiScanner
from scanners.opnsense import OPNsenseScanner
from scanners.generic import GenericScanner
from scanners.base import VendorScanner

SCANNER_REGISTRY = {
    "aruba_cx": ArubaCXScanner,
    "fs":       FSScanner,
    "unifi":    UniFiScanner,
    "opnsense": OPNsenseScanner,
    "generic":  GenericScanner,
}

_scanner_cache: dict[str, VendorScanner] = {}


def get_scanner(vendor: str) -> VendorScanner:
    """Return a scanner instance for the given vendor (cached singletons)."""
    if vendor not in _scanner_cache:
        cls = SCANNER_REGISTRY.get(vendor, GenericScanner)
        _scanner_cache[vendor] = cls()
    return _scanner_cache[vendor]
