"""Vendor scanner plugin registry with auto-discovery."""
import importlib
import pkgutil
from pathlib import Path

from scanners.base import VendorScanner

# Auto-import all modules in the scanners package to trigger __init_subclass__
_pkg_path = str(Path(__file__).parent)
for _importer, _modname, _ispkg in pkgutil.iter_modules([_pkg_path]):
    if _modname != "base":
        importlib.import_module(f"scanners.{_modname}")

SCANNER_REGISTRY = VendorScanner._registry

_scanner_cache: dict[str, VendorScanner] = {}


def get_scanner(vendor: str) -> VendorScanner:
    """Return a scanner instance for the given vendor (cached singletons)."""
    if vendor not in _scanner_cache:
        cls = SCANNER_REGISTRY.get(vendor) or SCANNER_REGISTRY.get("generic")
        _scanner_cache[vendor] = cls()
    return _scanner_cache[vendor]
