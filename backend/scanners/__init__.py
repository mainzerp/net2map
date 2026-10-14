"""Vendor scanner plugin registry with auto-discovery."""
import importlib
import logging
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

log = logging.getLogger(__name__)


class _FallbackScanner(VendorScanner):
    """Minimal scanner used when neither the vendor nor "generic" is registered.

    Not registered itself (no vendor_id): it only keeps scans running with
    neutral defaults (no model extraction, no virtual port filtering).
    """

    def fdb_strategy(self) -> str:
        return "dot1d"


def get_scanner(vendor: str) -> VendorScanner:
    """Return a scanner instance for the given vendor (cached singletons).

    Unknown vendors use the "generic" scanner; if that is missing too (e.g. a
    plugin module failed to import), a minimal fallback scanner is returned
    instead of failing with a TypeError on ``None()``.
    """
    if vendor not in _scanner_cache:
        cls = SCANNER_REGISTRY.get(vendor) or SCANNER_REGISTRY.get("generic")
        if cls is None:
            log.error("No scanner registered for vendor %r and no generic scanner; using fallback", vendor)
            cls = _FallbackScanner
        _scanner_cache[vendor] = cls()
    return _scanner_cache[vendor]
