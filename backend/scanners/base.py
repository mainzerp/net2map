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

    def __init_subclass__(cls, vendor_id: str = "", **kwargs):
        super().__init_subclass__(**kwargs)
        if vendor_id:
            cls.vendor_id = vendor_id
            VendorScanner._registry[vendor_id] = cls

    @abstractmethod
    def extract_model(self, sys_descr: str) -> str:
        """Extract the device model string from sysDescr."""

    def extract_version(self, sys_descr: str | None) -> str:
        """Extract the firmware/software version from sysDescr.

        Default implementation tries common version patterns; vendors with a
        known sysDescr format override this with a tighter regex.
        """
        text = sys_descr or ""
        for pattern in _VERSION_PATTERNS:
            m = pattern.search(text)
            if m:
                return m.group(1)
        return ""

    @abstractmethod
    def is_virtual_port(self, if_descr: str) -> bool:
        """Return True if the interface is virtual / should be filtered out."""

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
