"""Phase T1: Scanner plugin tests -- registry, parse/transform, edge cases."""
import pytest

from scanners import SCANNER_REGISTRY, get_scanner
from scanners.aruba_cx import ArubaCXScanner
from scanners.base import VendorScanner
from scanners.cisco import CiscoScanner
from scanners.fs_scanner import FSScanner
from scanners.generic import GenericScanner
from scanners.mikrotik import MikroTikScanner
from scanners.opnsense import OPNsenseScanner
from scanners.unifi import UniFiScanner
from scanners.watchguard import WatchGuardScanner

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

    def test_extract_version_match(self):
        result = self.scanner.extract_version(
            "ArubaOS-CX, Aruba CX 6300 48G, SW: FL.10.12.0010"
        )
        assert result == "FL.10.12.0010"

    def test_extract_version_no_match(self):
        assert self.scanner.extract_version("Some other device") == ""

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

    def test_extract_version_base_default(self):
        result = self.scanner.extract_version("FSOS, Version 2.5.1 build 123")
        assert result == "2.5.1"

    def test_extract_version_no_match(self):
        assert self.scanner.extract_version("Unknown device") == ""

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

    def test_extract_version_match(self):
        result = self.scanner.extract_version("USW-Pro-48-PoE, 6.5.59.14722, Linux 4.4.253")
        assert result == "6.5.59.14722"

    def test_extract_version_no_match(self):
        assert self.scanner.extract_version("Random AP") == ""

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

    def test_extract_version_base_default_v_prefix(self):
        assert self.scanner.extract_version("OPNsense firmware v23.7.1") == "23.7.1"

    def test_extract_version_no_match(self):
        assert self.scanner.extract_version("Linux router") == ""

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
# MikroTik Scanner
# ---------------------------------------------------------------------------

class TestMikroTikScanner:
    scanner = MikroTikScanner()

    def test_extract_model(self):
        assert self.scanner.extract_model("RouterOS CRS326-24G-2S+") == "CRS326-24G-2S+"
        assert self.scanner.extract_model("RouterOS RB4011iGS+") == "RB4011iGS+"
        assert self.scanner.extract_model("RouterOS 7.12.1 (stable)") == ""
        assert self.scanner.extract_model("Linux router") == ""

    def test_extract_version(self):
        assert self.scanner.extract_version("RouterOS 7.12.1 (stable)") == "7.12.1"
        assert self.scanner.extract_version("RouterOS CRS326-24G-2S+") == ""

    def test_firmware_oids_from_mikrotik_mib(self):
        assert self.scanner.FIRMWARE_OIDS[0] == "1.3.6.1.4.1.14988.1.1.4.4.0"

    def test_is_virtual_port(self):
        for name in ("bridge", "vlan10", "pppoe-out1", "lo", "wireguard1", "bonding1", "eoip-tunnel1"):
            assert self.scanner.is_virtual_port(name) is True, name
        for name in ("ether1", "sfp-sfpplus1", "qsfp28-1-1", "combo1", "wlan1"):
            assert self.scanner.is_virtual_port(name) is False, name

    def test_hooks(self):
        assert self.scanner.vendor_id == "mikrotik"
        assert self.scanner.device_type() == "switch"
        assert self.scanner.supports_stp() is True


# ---------------------------------------------------------------------------
# WatchGuard Scanner
# ---------------------------------------------------------------------------

class TestWatchGuardScanner:
    scanner = WatchGuardScanner()

    def test_extract_model(self):
        assert self.scanner.extract_model("WatchGuard Firebox M370 Fireware v12.8.2") == "Firebox M370"
        assert self.scanner.extract_model("T85-PoE Fireware v12.10") == "T85-PoE"
        assert self.scanner.extract_model("WatchGuard XTM 330") == "XTM 330"
        assert self.scanner.extract_model("Linux router") == ""

    def test_extract_version(self):
        assert self.scanner.extract_version("WatchGuard Fireware v12.10.3.B690003") == "12.10.3.B690003"
        assert self.scanner.extract_version("Fireware OS Version 12.8.2") == "12.8.2"
        assert self.scanner.extract_version("WatchGuard Firebox") == ""

    def test_is_virtual_port(self):
        for name in ("lo", "vlan10", "br0", "bvi0", "ppp0", "tun0", "sslvpn0"):
            assert self.scanner.is_virtual_port(name) is True, name
        for name in ("eth0", "eth7"):
            assert self.scanner.is_virtual_port(name) is False, name

    def test_hooks(self):
        assert self.scanner.vendor_id == "watchguard"
        assert self.scanner.device_type() == "firewall"
        assert self.scanner.supports_stp() is False


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

    def test_extract_version_base_default_sw(self):
        assert self.scanner.extract_version("Some switch, SW: 1.2.3") == "1.2.3"

    def test_extract_version_no_match(self):
        assert self.scanner.extract_version("Telecom device") == ""

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
# Cisco Scanner
# ---------------------------------------------------------------------------

class TestCiscoScanner:
    scanner = CiscoScanner()

    def test_extract_model_match(self):
        result = self.scanner.extract_model("Cisco WS-C2960X-48FPD-L Switch")
        assert "Cisco" in result

    def test_extract_model_no_match(self):
        assert self.scanner.extract_model("Random appliance") == ""

    def test_extract_version_match(self):
        result = self.scanner.extract_version(
            "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), "
            "Version 15.2(7)E4, RELEASE SOFTWARE (fc1)"
        )
        assert result == "15.2(7)E4"

    def test_extract_version_no_match(self):
        assert self.scanner.extract_version("Random appliance") == ""

    def test_is_virtual_port_virtual(self):
        assert self.scanner.is_virtual_port("Loopback0") is True
        assert self.scanner.is_virtual_port("Vlan100") is True
        assert self.scanner.is_virtual_port("Port-channel1") is True
        assert self.scanner.is_virtual_port("Null0") is True

    def test_is_virtual_port_physical(self):
        assert self.scanner.is_virtual_port("GigabitEthernet1/0/1") is False
        assert self.scanner.is_virtual_port("TenGigabitEthernet1/1/1") is False

    def test_vendor_id(self):
        assert self.scanner.vendor_id == "cisco"


# ---------------------------------------------------------------------------
# fdb_strategy -- parametrized across all scanners
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scanner_cls,expected", [
    (ArubaCXScanner, "dot1d"),
    (FSScanner, "dot1d"),
    (UniFiScanner, "qbridge"),
    (OPNsenseScanner, "dot1d"),
    (CiscoScanner, "dot1d"),
    (GenericScanner, "dot1d"),
    (MikroTikScanner, "dot1d"),
    (WatchGuardScanner, "dot1d"),
])
def test_fdb_strategy(scanner_cls, expected):
    assert scanner_cls().fdb_strategy() == expected


# ---------------------------------------------------------------------------
# Registry & edge cases
# ---------------------------------------------------------------------------

EXPECTED_VENDOR_IDS = {"aruba_cx", "fs", "unifi", "opnsense", "cisco", "generic", "mikrotik", "watchguard"}

ALL_SCANNERS = [
    ArubaCXScanner, FSScanner, UniFiScanner, OPNsenseScanner, CiscoScanner, GenericScanner,
    MikroTikScanner, WatchGuardScanner,
]


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
def test_extract_version_none_input(scanner_cls):
    assert scanner_cls().extract_version(None) == ""


@pytest.mark.parametrize("scanner_cls", ALL_SCANNERS)
def test_extract_version_empty_string(scanner_cls):
    assert scanner_cls().extract_version("") == ""


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
