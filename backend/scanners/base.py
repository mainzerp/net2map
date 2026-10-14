"""Abstract base class for vendor-specific SNMP scanners."""
import re
from abc import ABC, abstractmethod

_VERSION_PATTERNS = (
    re.compile(r"Version\s+([0-9A-Za-z.\-_]+)", re.IGNORECASE),
    re.compile(r"SW:\s*(\S+)", re.IGNORECASE),
    re.compile(r"\bv(\d+\.\d+[\d.]*)", re.IGNORECASE),
)


class VendorScanner(ABC):
    """Base class that every vendor scanner must implement."""
    _registry: dict[str, type["VendorScanner"]] = {}
    vendor_id: str = ""

    # Model regex applied to sysDescr by extract_model (group 1 is the model);
    # None means "no model extraction". MODEL_STRIP trims the match.
    MODEL_PATTERN: re.Pattern | None = None
    MODEL_STRIP: bool = False
    # Version regex for extract_version (group 1); None uses _VERSION_PATTERNS.
    VERSION_PATTERN: re.Pattern | None = None
    # Lowercase markers of virtual interfaces for is_virtual_port.
    # VIRTUAL_PORT_MATCH is "contains" (marker anywhere in ifDescr) or
    # "prefix" (ifDescr starts with the marker).
    VIRTUAL_PORT_PATTERNS: tuple[str, ...] = ()
    VIRTUAL_PORT_MATCH: str = "contains"

    def __init_subclass__(cls, vendor_id: str = "", **kwargs):
        super().__init_subclass__(**kwargs)
        if vendor_id:
            cls.vendor_id = vendor_id
            VendorScanner._registry[vendor_id] = cls

    def extract_model(self, sys_descr: str) -> str:
        """Extract the device model string from sysDescr (via MODEL_PATTERN)."""
        if self.MODEL_PATTERN is None:
            return ""
        m = self.MODEL_PATTERN.search(sys_descr or "")
        if not m:
            return ""
        return m.group(1).strip() if self.MODEL_STRIP else m.group(1)

    def extract_version(self, sys_descr: str | None) -> str:
        """Extract the firmware/software version from sysDescr.

        Default implementation tries common version patterns; vendors with a
        known sysDescr format set VERSION_PATTERN to a tighter regex.
        """
        text = sys_descr or ""
        if self.VERSION_PATTERN is not None:
            m = self.VERSION_PATTERN.search(text)
            return m.group(1) if m else ""
        for pattern in _VERSION_PATTERNS:
            m = pattern.search(text)
            if m:
                return m.group(1)
        return ""

    def is_virtual_port(self, if_descr: str) -> bool:
        """Return True if the interface is virtual / should be filtered out.

        Matches the lowercased ifDescr against VIRTUAL_PORT_PATTERNS, either
        as substrings or as prefixes (VIRTUAL_PORT_MATCH).
        """
        d = (if_descr or "").lower()
        if self.VIRTUAL_PORT_MATCH == "prefix":
            return d.startswith(self.VIRTUAL_PORT_PATTERNS)
        return any(p in d for p in self.VIRTUAL_PORT_PATTERNS)

    @abstractmethod
    def fdb_strategy(self) -> str:
        """Return the FDB walk strategy: 'dot1d' or 'qbridge'."""

    def supports_stp(self) -> bool:
        """Return True if spanning tree data (BRIDGE-MIB dot1dStp) should be read.

        Only the default instance is read; vendors that never run a bridge
        spanning tree (e.g. firewalls) override this to skip the requests.
        """
        return True

    def supports_fdb(self) -> bool:
        """Return True if the bridge forwarding database (FDB) should be walked.

        Devices without a switching fabric (UPS network cards, server
        management controllers) override this to skip the pointless walks.
        """
        return True

    def device_type(self) -> str:
        """Return the device kind: "switch" | "firewall" | "ups" | "server"."""
        return "switch"

    async def collect_health(self, snmp_get, snmp_walk) -> dict | None:
        """Collect a normalized health snapshot (see scanners.health).

        ``snmp_get(*oids)`` returns ``{oid: value_str}`` and ``snmp_walk(oid)``
        returns ``[(oid, value_str)]``. Called once per non-discovery scan;
        implementations must return None on failure and never raise. The
        default (switches, firewalls) collects nothing.
        """
        return None
