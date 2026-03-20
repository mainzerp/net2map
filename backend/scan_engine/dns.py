"""DNS resolution helpers with per-scan caching."""
import logging
import socket

from shared.state import _log_event


def _resolve_ip(sys_name: str, switch_data: dict) -> str:
    """Try to find the management IP of a device by sysName in the scan batch."""
    for ip, sw in switch_data.items():
        if sw.sys_name and sys_name.lower() in sw.sys_name.lower():
            return ip
    try:
        return socket.gethostbyname(sys_name)
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
        cache[ip] = socket.gethostbyaddr(ip)[0]
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
