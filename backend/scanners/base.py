"""Abstract base class for vendor-specific SNMP scanners."""
from abc import ABC, abstractmethod


class VendorScanner(ABC):
    """Base class that every vendor scanner must implement."""

    @abstractmethod
    def extract_model(self, sys_descr: str) -> str:
        """Extract the device model string from sysDescr."""

    @abstractmethod
    def is_virtual_port(self, if_descr: str) -> bool:
        """Return True if the interface is virtual / should be filtered out."""

    @abstractmethod
    def fdb_strategy(self) -> str:
        """Return the FDB walk strategy: 'dot1d' or 'qbridge'."""
