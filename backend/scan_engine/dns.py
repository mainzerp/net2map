"""DNS resolution helpers with per-scan caching."""
import logging
import socket
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError

from shared.state import _log_event

# Upper bound for a single system resolver call (gethostbyname/gethostbyaddr).
# The stdlib resolver has no timeout parameter and socket.setdefaulttimeout
# would affect every other socket in the process, so lookups run on a small
# shared pool and the caller stops waiting after this many seconds. A hung
# lookup keeps its worker thread busy until the OS resolver gives up.
_SYSTEM_DNS_TIMEOUT_SEC = 3.0
_DNS_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="net2map-dns")


def _call_with_timeout(func, *args, timeout: float | None = None):
    """Run a blocking resolver call on the DNS pool, bounded by *timeout* seconds
    (default _SYSTEM_DNS_TIMEOUT_SEC).

    Raises TimeoutError when the call does not finish in time; any exception
    of the call itself is re-raised.
    """
    if timeout is None:
        timeout = _SYSTEM_DNS_TIMEOUT_SEC
    future = _DNS_POOL.submit(func, *args)
    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError:
        future.cancel()
        raise TimeoutError("DNS lookup timed out after %.1fs" % timeout)


def _normalize_name(name: str) -> str:
    """Normalize a hostname for comparison: lowercase, stripped, no trailing dot."""
    return (name or "").strip().lower().rstrip(".")


def _resolve_ip(sys_name: str, switch_data: dict) -> str:
    """Try to find the management IP of a device by sysName in the scan batch.

    Matching is done in two passes: first an exact match (case-insensitive,
    FQDN-normalized -- short names also match the first label of an FQDN),
    then a substring match as last-resort fallback. This prevents short names
    like "sw1" from accidentally matching "sw11".
    """
    target = _normalize_name(sys_name)
    if not target:
        return ""
    target_short = target.split(".")[0]

    # Pass 1: exact match on the full normalized name or on the hostname label
    for ip, sw in switch_data.items():
        cand = _normalize_name(sw.sys_name)
        if cand and (cand == target or cand.split(".")[0] == target_short):
            return ip

    # Pass 2: substring fallback (legacy behavior)
    for ip, sw in switch_data.items():
        if sw.sys_name and target in sw.sys_name.lower():
            return ip

    try:
        return _call_with_timeout(socket.gethostbyname, sys_name)
    except Exception:
        return ""


_DNS_CACHE_MAX = 10000


def _evict_dns_cache(cache: dict[str, str]) -> None:
    """Evict oldest half of entries when cache exceeds size limit."""
    if len(cache) < _DNS_CACHE_MAX:
        return
    keys = list(cache.keys())
    for k in keys[:len(keys) // 2]:
        del cache[k]


def _resolve_host(
    ip: str,
    cache: dict[str, str],
    dns_servers: list[str] | None = None,
    correlation_id: str = "",
) -> str:
    """Best-effort reverse DNS lookup with per-scan cache."""
    if not ip:
        return ""
    if ip in cache:
        _log_event(
            logging.INFO,
            "dns.lookup.cache",
            correlation_id=correlation_id,
            ip=ip,
            host=cache[ip],
        )
        return cache[ip]

    if dns_servers:
        try:
            import dns.resolver
            import dns.reversename

            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = dns_servers
            resolver.timeout = 1.5
            resolver.lifetime = 2.5
            query_name = dns.reversename.from_address(ip)
            answers = resolver.resolve(query_name, "PTR")
            host = str(answers[0]).rstrip(".") if answers else ""
            _evict_dns_cache(cache)
            cache[ip] = host
            _log_event(
                logging.INFO,
                "dns.lookup",
                correlation_id=correlation_id,
                ip=ip,
                host=host,
                resolver="custom",
                nameservers=dns_servers,
                success=bool(host),
            )
            return host
        except Exception:
            pass

    try:
        _evict_dns_cache(cache)
        cache[ip] = _call_with_timeout(socket.gethostbyaddr, ip)[0]
        _log_event(
            logging.INFO,
            "dns.lookup",
            correlation_id=correlation_id,
            ip=ip,
            host=cache[ip],
            resolver="system",
            success=bool(cache[ip]),
        )
    except Exception:
        _evict_dns_cache(cache)
        cache[ip] = ""
        _log_event(
            logging.WARNING,
            "dns.lookup",
            correlation_id=correlation_id,
            ip=ip,
            host="",
            resolver="system",
            success=False,
        )
    return cache[ip]
