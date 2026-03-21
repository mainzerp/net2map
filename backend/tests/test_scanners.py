"""Phase T1: Scanner plugin tests -- registry, parse/transform, edge cases."""
import pytest

from scanners import SCANNER_REGISTRY, get_scanner
from scanners.aruba_cx import ArubaCXScanner
from scanners.base import VendorScanner
from scanners.fs_scanner import FSScanner
from scanners.generic import GenericScanner
from scanners.opnsense import OPNsenseScanner
from scanners.unifi import UniFiScanner

# ---------------------------------------------------------------------------
# ArubaCX Scanner
# ---------------------------------------------------------------------------

class TestArubaCXScanner:
    scanner = ArubaCXScanner()

    def test_extract_model_match(self):
        result = self.scanner.extract_model(
            "ArubaOS-CX, Aruba CX 6300 48G, SW: FL.10.12.0010"
        )
        assert result == "Aruba CX 6300 48G"

    def test_extract_model_no_match(self):
        assert self.scanner.extract_model("Some other device") == ""

    def test_is_virtual_port_virtual(self):
        assert self.scanner.is_virtual_port("loopback0") is True
        assert self.scanner.is_virtual_port("vlan100") is True
        assert self.scanner.is_virtual_port("tunnel0") is True
        assert self.scanner.is_virtual_port("mgmt") is True

    def test_is_virtual_port_physical(self):
        assert self.scanner.is_virtual_port("1/1/1") is False
        assert self.scanner.is_virtual_port("GigabitEthernet0/1") is False

    def test_vendor_id(self):
        assert self.scanner.vendor_id == "aruba_cx"


# ---------------------------------------------------------------------------
# FS Scanner
# ---------------------------------------------------------------------------

class TestFSScanner:
    scanner = FSScanner()

    def test_extract_model_match(self):
        result = self.scanner.extract_model("FS S5860-20SQ some extra info")
        assert result == "FS S5860-20SQ"

    def test_extract_model_no_match(self):
        assert self.scanner.extract_model("Unknown device") == ""

    def test_is_virtual_port_virtual(self):
        assert self.scanner.is_virtual_port("loopback0") is True
        assert self.scanner.is_virtual_port("vlan10") is True
        assert self.scanner.is_virtual_port("null0") is True

    def test_is_virtual_port_physical(self):
        assert self.scanner.is_virtual_port("GE0/1") is False
        assert self.scanner.is_virtual_port("TenGigabitEthernet0/1") is False

    def test_vendor_id(self):
        assert self.scanner.vendor_id == "fs"


# ---------------------------------------------------------------------------
# UniFi Scanner
# ---------------------------------------------------------------------------

class TestUniFiScanner:
    scanner = UniFiScanner()

    def test_extract_model_match(self):
        assert self.scanner.extract_model("USW-Pro-48-PoE") == "USW-Pro-48-PoE"

    def test_extract_model_no_match(self):
        assert self.scanner.extract_model("Random AP") == ""

    def test_is_virtual_port_virtual(self):
        assert self.scanner.is_virtual_port("bridge0") is True
        assert self.scanner.is_virtual_port("cpu") is True
        assert self.scanner.is_virtual_port("vlan1") is True

    def test_is_virtual_port_physical(self):
        assert self.scanner.is_virtual_port("eth0") is False
        assert self.scanner.is_virtual_port("swp1") is False

    def test_vendor_id(self):
        assert self.scanner.vendor_id == "unifi"


# ---------------------------------------------------------------------------
# OPNsense Scanner
# ---------------------------------------------------------------------------

class TestOPNsenseScanner:
    scanner = OPNsenseScanner()

    def test_extract_model_match(self):
        result = self.scanner.extract_model("OPNsense 23.7")
        assert "OPNsense" in result

    def test_extract_model_no_match(self):
        assert self.scanner.extract_model("Linux router") == ""

    def test_is_virtual_port_virtual(self):
        assert self.scanner.is_virtual_port("loopback0") is True
        assert self.scanner.is_virtual_port("vlan100") is True
        assert self.scanner.is_virtual_port("tun0") is True
        assert self.scanner.is_virtual_port("ovpns1") is True

    def test_is_virtual_port_physical(self):
        assert self.scanner.is_virtual_port("em0") is False
        assert self.scanner.is_virtual_port("igb0") is False

    def test_is_virtual_port_startswith_no_false_positive(self):
        # OPNsense uses startswith -- "mlxen0" must NOT match "lo"
        assert self.scanner.is_virtual_port("mlxen0") is False

    def test_vendor_id(self):
        assert self.scanner.vendor_id == "opnsense"


# ---------------------------------------------------------------------------
# Generic Scanner
# ---------------------------------------------------------------------------

class TestGenericScanner:
    scanner = GenericScanner()

    def test_extract_model_match(self):
        result = self.scanner.extract_model("Cisco WS-C2960X Switch")
        assert "Cisco" in result

    def test_extract_model_no_match(self):
        assert self.scanner.extract_model("Telecom device") == ""

    def test_is_virtual_port_virtual(self):
        assert self.scanner.is_virtual_port("tunnel0") is True
        assert self.scanner.is_virtual_port("loopback1") is True
        assert self.scanner.is_virtual_port("vlan200") is True

    def test_is_virtual_port_physical(self):
        assert self.scanner.is_virtual_port("Gi1/0/1") is False
        assert self.scanner.is_virtual_port("FastEthernet0/1") is False

    def test_vendor_id(self):
        assert self.scanner.vendor_id == "generic"


# ---------------------------------------------------------------------------
# fdb_strategy -- parametrized across all scanners
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scanner_cls,expected", [
    (ArubaCXScanner, "dot1d"),
    (FSScanner, "dot1d"),
    (UniFiScanner, "qbridge"),
    (OPNsenseScanner, "dot1d"),
    (GenericScanner, "dot1d"),
])
def test_fdb_strategy(scanner_cls, expected):
    assert scanner_cls().fdb_strategy() == expected


# ---------------------------------------------------------------------------
# Registry & edge cases
# ---------------------------------------------------------------------------

EXPECTED_VENDOR_IDS = {"aruba_cx", "fs", "unifi", "opnsense", "generic"}

ALL_SCANNERS = [ArubaCXScanner, FSScanner, UniFiScanner, OPNsenseScanner, GenericScanner]


def test_vendor_registry_all_registered():
    assert set(VendorScanner._registry.keys()) >= EXPECTED_VENDOR_IDS
    assert set(SCANNER_REGISTRY.keys()) >= EXPECTED_VENDOR_IDS


@pytest.mark.parametrize("scanner_cls", ALL_SCANNERS)
def test_extract_model_none_input(scanner_cls):
    assert scanner_cls().extract_model(None) == ""


@pytest.mark.parametrize("scanner_cls", ALL_SCANNERS)
def test_extract_model_empty_string(scanner_cls):
    assert scanner_cls().extract_model("") == ""


@pytest.mark.parametrize("scanner_cls", ALL_SCANNERS)
def test_is_virtual_port_empty_string(scanner_cls):
    assert scanner_cls().is_virtual_port("") is False


def test_get_scanner_returns_cached_instance():
    s1 = get_scanner("aruba_cx")
    s2 = get_scanner("aruba_cx")
    assert s1 is s2
    assert isinstance(s1, ArubaCXScanner)


def test_get_scanner_unknown_vendor_falls_back_to_generic():
    s = get_scanner("nonexistent_vendor_xyz")
    assert isinstance(s, GenericScanner)
