"""Tests for scan_engine/dns.py resolution and caching."""
import importlib
import sys
from unittest.mock import patch, MagicMock

# The conftest mocks `scan_engine` as a MagicMock. We need the real modules
# for dns tests, so remove the mock entries and import fresh.
for _key in list(sys.modules.keys()):
    if _key == "scan_engine" or _key.startswith("scan_engine."):
        del sys.modules[_key]

import scan_engine.dns as _dns_mod
# Restore the top-level mock so other tests are not affected
sys.modules.setdefault("scan_engine", MagicMock())


def test_resolve_ip_from_switch_data():
    """_resolve_ip finds IP by matching sysName in switch_data."""
    switch_data = {
        "10.0.0.1": MagicMock(sys_name="core-switch-01"),
        "10.0.0.2": MagicMock(sys_name="access-switch-02"),
    }
    result = _dns_mod._resolve_ip("core-switch-01", switch_data)
    assert result == "10.0.0.1"


def test_resolve_ip_partial_match():
    """_resolve_ip matches partial sysName (case-insensitive)."""
    switch_data = {
        "10.0.0.5": MagicMock(sys_name="MySwitch.local"),
    }
    result = _dns_mod._resolve_ip("myswitch", switch_data)
    assert result == "10.0.0.5"


def test_resolve_ip_falls_back_to_dns():
    """_resolve_ip falls back to socket.gethostbyname when not in switch_data."""
    with patch.object(_dns_mod.socket, "gethostbyname", return_value="1.2.3.4"):
        result = _dns_mod._resolve_ip("unknown-host", {})
        assert result == "1.2.3.4"


def test_resolve_ip_returns_empty_on_failure():
    """_resolve_ip returns empty string when all lookups fail."""
    with patch.object(_dns_mod.socket, "gethostbyname", side_effect=Exception("nope")):
        result = _dns_mod._resolve_ip("ghost", {})
        assert result == ""


def test_resolve_host_uses_cache():
    """_resolve_host returns cached value without calling socket."""
    cache = {"10.0.0.1": "cached.host"}
    with patch.object(_dns_mod.socket, "gethostbyaddr") as mock_dns:
        result = _dns_mod._resolve_host("10.0.0.1", cache)
        assert result == "cached.host"
        mock_dns.assert_not_called()


def test_resolve_host_populates_cache():
    """_resolve_host stores result in cache on successful lookup."""
    cache = {}
    with patch.object(_dns_mod.socket, "gethostbyaddr", return_value=("myhost.local", [], [])):
        result = _dns_mod._resolve_host("10.0.0.2", cache)
        assert result == "myhost.local"
        assert cache["10.0.0.2"] == "myhost.local"


def test_resolve_host_caches_empty_on_failure():
    """_resolve_host caches empty string on lookup failure."""
    cache = {}
    with patch.object(_dns_mod.socket, "gethostbyaddr", side_effect=Exception("timeout")):
        result = _dns_mod._resolve_host("10.0.0.3", cache)
        assert result == ""
        assert cache["10.0.0.3"] == ""


def test_resolve_host_empty_ip():
    """_resolve_host returns empty string for empty IP."""
    result = _dns_mod._resolve_host("", {})
    assert result == ""


def test_evict_dns_cache_keeps_under_limit():
    """Cache eviction does nothing when under the limit."""
    cache = {f"10.0.0.{i}": f"host{i}" for i in range(10)}
    _dns_mod._evict_dns_cache(cache)
    assert len(cache) == 10


def test_evict_dns_cache_trims_when_over_limit():
    """Cache eviction removes half when at max capacity."""
    cache = {f"10.0.{i // 256}.{i % 256}": f"host{i}" for i in range(_dns_mod._DNS_CACHE_MAX)}
    _dns_mod._evict_dns_cache(cache)
    assert len(cache) == _dns_mod._DNS_CACHE_MAX // 2
