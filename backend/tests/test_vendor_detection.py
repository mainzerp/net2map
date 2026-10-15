"""Tests for scanners.detection (vendor detection) and scanners.parsing.

Both modules are deliberately free of pysnmp dependencies so they can be
imported directly in the test environment (pysnmp is mocked/broken there).
"""
from scanners.detection import VENDOR_OIDS, detect_vendor, oid_has_prefix
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


class TestDetectVendorOidBoundaries:
    """sysObjectID prefixes must match on OID arc boundaries only."""

    def test_enterprise_9999_is_not_cisco(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.9999.1.2") == "generic"

    def test_enterprise_90_is_not_cisco(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.90") == "generic"

    def test_enterprise_9999_falls_back_to_keywords(self):
        assert detect_vendor("FS S5860-20SQ Switch", "1.3.6.1.4.1.9999.1") == "fs"

    def test_cisco_subtree_still_cisco(self):
        assert detect_vendor("some switch", "1.3.6.1.4.1.9.1.2695") == "cisco"

    def test_exact_prefix_equality_matches(self):
        for prefix, vendor in VENDOR_OIDS.items():
            assert detect_vendor("", prefix) == vendor

    def test_longer_enterprise_numbers_do_not_match(self):
        for prefix in VENDOR_OIDS:
            # A nested prefix (232.165 under 232) falls back to its parent root.
            parents = [p for p in VENDOR_OIDS if p != prefix and oid_has_prefix(prefix, p)]
            expected = VENDOR_OIDS[max(parents, key=len)] if parents else "generic"
            assert detect_vendor("", prefix + "7.1") == expected

    def test_leading_dot_and_whitespace_normalized(self):
        assert detect_vendor("", " .1.3.6.1.4.1.9.1.1208 ") == "cisco"
        assert detect_vendor("", ".1.3.6.1.4.1.9999.1") == "generic"

    def test_every_vendor_detected_by_representative_oid(self):
        representative = {
            "aruba_cx": "1.3.6.1.4.1.47196.4.1.1.1.100",
            "fs": "1.3.6.1.4.1.52642.2.1.45.1",
            "unifi": "1.3.6.1.4.1.41112.1.6",
            "cisco": "1.3.6.1.4.1.9.1.1208",
            "eaton": "1.3.6.1.4.1.534.1",
            "hpe_ups": "1.3.6.1.4.1.232.165.3",
            "hpe_ilo": "1.3.6.1.4.1.232.9.4.11",
            "mikrotik": "1.3.6.1.4.1.14988.1",
            "watchguard": "1.3.6.1.4.1.3097.1.5.70",
        }
        assert set(representative) == set(VENDOR_OIDS.values())
        for vendor, oid in representative.items():
            assert detect_vendor("Mysterious black box", oid) == vendor

    def test_oid_takes_precedence_over_keywords(self):
        assert detect_vendor("Cisco IOS Software", "1.3.6.1.4.1.47196.1") == "aruba_cx"


class TestDetectUpsAndServerVendors:
    def test_eaton_enterprise_oid(self):
        assert detect_vendor("Network Management Card", "1.3.6.1.4.1.534.6.6.7") == "eaton"

    def test_mge_enterprise_oid_is_eaton(self):
        assert detect_vendor("Network Management Card", "1.3.6.1.4.1.705.1") == "eaton"

    def test_hpe_ups_branch_wins_over_server_root(self):
        assert detect_vendor("UPS Network Module", "1.3.6.1.4.1.232.165.3") == "hpe_ups"

    def test_hpe_server_management_oid(self):
        assert detect_vendor("Integrated Lights-Out 5 2.72", "1.3.6.1.4.1.232.9.4.11") == "hpe_ilo"

    def test_hp_root_11_still_not_mapped(self):
        """HPE/Aruba switches live under .11: never classified as a server or UPS."""
        assert detect_vendor("HP J9772A 2530-48G-PoE+", "1.3.6.1.4.1.11.2.3.7.11.153") == "generic"

    def test_enterprise_2320_is_not_hpe(self):
        assert detect_vendor("", "1.3.6.1.4.1.2320.1") == "generic"

    def test_eaton_keyword(self):
        assert detect_vendor("Eaton 5PX 1500 Network-M2", "") == "eaton"

    def test_ilo_keywords(self):
        assert detect_vendor("Integrated Lights-Out 6 1.55", "") == "hpe_ilo"
        assert detect_vendor("HPE iLO 5", "") == "hpe_ilo"
        assert detect_vendor("ProLiant DL380 Gen10", "") == "hpe_ilo"

    def test_ilo_keyword_word_boundary(self):
        assert detect_vendor("Philosophy appliance", "") == "generic"


class TestOidHasPrefix:
    def test_equal(self):
        assert oid_has_prefix("1.3.6.1.4.1.9", "1.3.6.1.4.1.9")

    def test_child(self):
        assert oid_has_prefix("1.3.6.1.4.1.9.1", "1.3.6.1.4.1.9")

    def test_not_on_boundary(self):
        assert not oid_has_prefix("1.3.6.1.4.1.9999", "1.3.6.1.4.1.9")

    def test_shorter_oid(self):
        assert not oid_has_prefix("1.3.6.1.4.1", "1.3.6.1.4.1.9")

    def test_empty_inputs(self):
        assert not oid_has_prefix("", "1.3.6.1.4.1.9")
        assert not oid_has_prefix("1.3.6.1.4.1.9", "")
        assert not oid_has_prefix(None, "1.3.6.1.4.1.9")

    def test_longest_prefix_wins(self, monkeypatch):
        import scanners.detection as detection

        monkeypatch.setattr(
            detection,
            "VENDOR_OIDS",
            {"1.3.6.1.4.1.9": "cisco", "1.3.6.1.4.1.9.6": "cisco_sb"},
        )
        assert detection.detect_vendor("", "1.3.6.1.4.1.9.6.1.95") == "cisco_sb"
        assert detection.detect_vendor("", "1.3.6.1.4.1.9.1.1208") == "cisco"


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

    def test_mikrotik_keyword_and_oid(self):
        assert detect_vendor("RouterOS CRS326-24G-2S+", "") == "mikrotik"
        assert detect_vendor("", "1.3.6.1.4.1.14988.1") == "mikrotik"

    def test_watchguard_keyword_and_oid(self):
        assert detect_vendor("WatchGuard Fireware v12.10.3", "") == "watchguard"
        assert detect_vendor("", "1.3.6.1.4.1.3097.1.5.70") == "watchguard"
        assert detect_vendor("", "1.3.6.1.4.1.30970.1") == "generic"

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
