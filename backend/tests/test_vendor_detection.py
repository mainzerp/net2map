"""Tests for scanners.detection (vendor detection) and scanners.parsing.

Both modules are deliberately free of pysnmp dependencies so they can be
imported directly in the test environment (pysnmp is mocked/broken there).
"""
from scanners.detection import detect_vendor
from scanners.parsing import _oid_to_vlan_mac_qbridge, resolve_fdb_candidates


class TestDetectVendorOids:
    def test_aruba_enterprise_oid(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.47196.1.2.3") == "aruba_cx"

    def test_fs_enterprise_oid(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.52642.1") == "fs"

    def test_unifi_enterprise_oid(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.41112.1") == "unifi"

    def test_cisco_enterprise_oid(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.9.1.1208") == "cisco"

    def test_netsnmp_oid_is_not_opnsense(self):
        """Net-SNMP (8072) is any Linux/FreeBSD host -- not automatically OPNsense."""
        assert detect_vendor("Linux router 5.15.0 #1 SMP", "1.3.6.1.4.1.8072.3.2.10") == "generic"

    def test_hp_enterprise_oid_is_not_aruba_cx(self):
        """1.3.6.1.4.1.11 covers all of HP/HPE -- ambiguous without keywords."""
        assert detect_vendor("HP ProCurve 2520G", "1.3.6.1.4.1.11.2.3.7.11.45") == "generic"

    def test_h3c_enterprise_oid_is_not_aruba_cx(self):
        assert detect_vendor("H3C S5120 Switch", "1.3.6.1.4.1.25506.1.1") == "generic"


class TestDetectVendorKeywords:
    def test_aruba_keyword(self):
        assert detect_vendor("ArubaOS-CX, Aruba CX 6300 48G, SW: FL.10.12", "") == "aruba_cx"

    def test_fs_keyword(self):
        assert detect_vendor("FS S5860-20SQ Switch", "") == "fs"

    def test_unifi_keyword(self):
        assert detect_vendor("USW-Pro-48-PoE 6.5.59", "") == "unifi"

    def test_unifi_u7_word_boundary(self):
        """The 'u7' keyword must match as a token but not inside longer strings."""
        assert detect_vendor("U7 Pro Access Point", "") == "unifi"
        assert detect_vendor("Router MTU7500 series", "") == "generic"

    def test_opnsense_keyword(self):
        assert detect_vendor("OPNsense 23.7 amd64", "1.3.6.1.4.1.8072.3.2.9") == "opnsense"

    def test_freebsd_keyword(self):
        assert detect_vendor("FreeBSD fw.local 13.2-RELEASE", "") == "opnsense"

    def test_cisco_keyword(self):
        assert detect_vendor("Cisco IOS Software, C2960X Software", "") == "cisco"

    def test_unknown_is_generic(self):
        assert detect_vendor("Mysterious black box", "") == "generic"

    def test_empty_inputs(self):
        assert detect_vendor("", "") == "generic"


class TestOidToVlanMacQbridge:
    def test_parses_vlan_and_mac(self):
        oid = "1.3.6.1.2.1.17.7.1.2.2.1.2.100.0.11.22.33.44.55"
        vlan, mac = _oid_to_vlan_mac_qbridge(oid)
        assert vlan == 100
        assert mac == "00:0b:16:21:2c:37"

    def test_invalid_oid_returns_empty(self):
        assert _oid_to_vlan_mac_qbridge("1.3.6.1") == (0, "")


class TestResolveFdbCandidates:
    def _rows(self, *entries):
        """entries: (vlan, mac_octets..., bridge_port)"""
        base = "1.3.6.1.2.1.17.7.1.2.2.1.2"
        rows = []
        for *idx, port in entries:
            oid = base + "." + ".".join(str(i) for i in idx)
            rows.append((oid, str(port)))
        return rows

    def test_same_mac_multiple_vlans_prefers_known_interface(self):
        mac_octets = (0, 11, 22, 33, 44, 55)
        rows = self._rows(
            (100, *mac_octets, 7),   # VLAN 100 -> bridge port 7 -> ifIndex 107 (unknown iface)
            (10, *mac_octets, 3),    # VLAN 10  -> bridge port 3 -> ifIndex 103 (known iface)
        )
        result = resolve_fdb_candidates(
            rows, "qbridge",
            bridge_to_ifindex={7: 107, 3: 103},
            known_ifindexes={103},
        )
        assert result == {"00:0b:16:21:2c:37": 103}

    def test_same_mac_multiple_vlans_lowest_vlan_wins_without_known_iface(self):
        mac_octets = (0, 11, 22, 33, 44, 55)
        rows = self._rows(
            (100, *mac_octets, 7),
            (10, *mac_octets, 3),
        )
        result = resolve_fdb_candidates(
            rows, "qbridge",
            bridge_to_ifindex={7: 107, 3: 103},
            known_ifindexes=set(),
        )
        # Deterministic: lowest VLAN id wins
        assert result == {"00:0b:16:21:2c:37": 103}

    def test_unmapped_bridge_port_skipped(self):
        mac_octets = (0, 11, 22, 33, 44, 55)
        rows = self._rows((10, *mac_octets, 99))
        result = resolve_fdb_candidates(rows, "qbridge", bridge_to_ifindex={}, known_ifindexes=set())
        assert result == {}

    def test_dot1d_strategy_parses_plain_mac_index(self):
        oid = "1.3.6.1.2.1.17.4.3.1.2.0.11.22.33.44.55"
        result = resolve_fdb_candidates(
            [(oid, "3")], "dot1d",
            bridge_to_ifindex={3: 103},
            known_ifindexes={103},
        )
        assert result == {"00:0b:16:21:2c:37": 103}
