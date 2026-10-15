"""Tests for scan_engine/dns.py resolution and caching."""
import sys
from unittest.mock import MagicMock, patch

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


def test_resolve_ip_exact_match_preferred_over_substring():
    """A short sysName must not match a longer one ("sw1" vs "sw11")."""
    switch_data = {
        "10.0.0.11": MagicMock(sys_name="sw11"),
        "10.0.0.1": MagicMock(sys_name="sw1"),
    }
    # Dict order puts sw11 first: a naive substring scan would hit sw11.
    assert _dns_mod._resolve_ip("sw1", switch_data) == "10.0.0.1"


def test_resolve_ip_short_name_matches_fqdn_first_label():
    """A short hostname matches the first label of an FQDN sysName."""
    switch_data = {
        "10.0.0.7": MagicMock(sys_name="core-switch.example.com"),
    }
    assert _dns_mod._resolve_ip("core-switch", switch_data) == "10.0.0.7"


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


def test_resolve_hosts_concurrent_dedup_and_failures():
    """resolve_hosts resolves each unique IP once, concurrently, "" on failure."""
    import asyncio
    import threading
    import time

    seen = []
    active = {"now": 0, "max": 0}
    lock = threading.Lock()

    def fake_gethostbyaddr(ip):
        with lock:
            seen.append(ip)
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
        time.sleep(0.05)
        with lock:
            active["now"] -= 1
        if ip == "10.0.0.9":
            raise OSError("no PTR")
        return (f"host-{ip.split('.')[-1]}.lan", [], [ip])

    with patch.object(_dns_mod.socket, "gethostbyaddr", side_effect=fake_gethostbyaddr):
        result = asyncio.run(_dns_mod.resolve_hosts(["10.0.0.1", "10.0.0.2", "10.0.0.1", "", "10.0.0.9"]))
    assert result == {"10.0.0.1": "host-1.lan", "10.0.0.2": "host-2.lan", "10.0.0.9": ""}
    assert sorted(seen) == ["10.0.0.1", "10.0.0.2", "10.0.0.9"]
    assert active["max"] > 1


# -- process-wide TTL cache and custom resolver semantics ----------------------

def test_global_cache_shared_across_calls():
    """A second lookup with a fresh per-call cache is served from the TTL cache."""
    _dns_mod.clear_dns_cache()
    with patch.object(_dns_mod.socket, "gethostbyaddr", return_value=("cached.lan", [], [])) as mock_dns:
        assert _dns_mod._resolve_host("10.2.0.1", {}) == "cached.lan"
        assert _dns_mod._resolve_host("10.2.0.1", {}) == "cached.lan"
        assert mock_dns.call_count == 1


def test_global_cache_stores_negative_answers():
    _dns_mod.clear_dns_cache()
    with patch.object(_dns_mod.socket, "gethostbyaddr", side_effect=OSError("no PTR")) as mock_dns:
        assert _dns_mod._resolve_host("10.2.0.2", {}) == ""
        assert _dns_mod._resolve_host("10.2.0.2", {}) == ""
        assert mock_dns.call_count == 1
    _dns_mod.clear_dns_cache()
    with patch.object(_dns_mod.socket, "gethostbyaddr", return_value=("later.lan", [], [])):
        assert _dns_mod._resolve_host("10.2.0.2", {}) == "later.lan"


def test_ttl_cache_expiry_and_eviction():
    from shared.dns_cache import TTLCache

    clock = {"now": 0.0}
    cache = TTLCache(max_entries=4, positive_ttl=100, negative_ttl=10, clock=lambda: clock["now"])
    cache.set("a", "host-a")
    cache.set("b", "")
    assert cache.get("a") == "host-a"
    assert cache.get("b") == ""
    clock["now"] = 11
    assert cache.get("b") is None          # negative TTL elapsed
    assert cache.get("a") == "host-a"
    clock["now"] = 101
    assert cache.get("a") is None          # positive TTL elapsed
    for key in "cdefgh":
        cache.set(key, key)
    assert len(cache) <= 4
    assert cache.get("h") == "h"
    cache.clear()
    assert len(cache) == 0


def _fake_resolver(monkeypatch, exc=None, answer=None):
    import dns.resolver

    calls = []

    def fake_resolve(self, name, rdtype):
        calls.append(str(name))
        if exc is not None:
            raise exc
        return answer

    monkeypatch.setattr(dns.resolver.Resolver, "resolve", fake_resolve)
    return calls


def test_custom_dns_nxdomain_does_not_fall_back(monkeypatch):
    import dns.resolver

    _dns_mod.clear_dns_cache()
    calls = _fake_resolver(monkeypatch, exc=dns.resolver.NXDOMAIN())
    with patch.object(_dns_mod.socket, "gethostbyaddr", return_value=("system.lan", [], [])) as mock_dns:
        assert _dns_mod._resolve_host("10.3.0.1", {}, ["192.0.2.53"]) == ""
        mock_dns.assert_not_called()
    assert len(calls) == 1


def test_custom_dns_no_answer_does_not_fall_back(monkeypatch):
    import dns.resolver

    _dns_mod.clear_dns_cache()
    _fake_resolver(monkeypatch, exc=dns.resolver.NoAnswer())
    with patch.object(_dns_mod.socket, "gethostbyaddr", return_value=("system.lan", [], [])) as mock_dns:
        assert _dns_mod._resolve_host("10.3.0.2", {}, ["192.0.2.53"]) == ""
        mock_dns.assert_not_called()


def test_custom_dns_timeout_falls_back_to_system(monkeypatch):
    import dns.exception

    _dns_mod.clear_dns_cache()
    _fake_resolver(monkeypatch, exc=dns.exception.Timeout())
    with patch.object(_dns_mod.socket, "gethostbyaddr", return_value=("system.lan", [], [])) as mock_dns:
        assert _dns_mod._resolve_host("10.3.0.3", {}, ["192.0.2.53"]) == "system.lan"
        mock_dns.assert_called_once()


def test_custom_dns_answer_is_cached(monkeypatch):
    _dns_mod.clear_dns_cache()
    calls = _fake_resolver(monkeypatch, answer=["host.example.com."])
    assert _dns_mod._resolve_host("10.3.0.4", {}, ["192.0.2.53"]) == "host.example.com"
    assert _dns_mod._resolve_host("10.3.0.4", {}, ["192.0.2.53"]) == "host.example.com"
    assert len(calls) == 1
