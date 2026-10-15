"""Reverse DNS diagnostics for the DNS settings page.

Runs the same two lookup paths as the scan (configured DNS servers via
dnspython, then the system resolver of the container) without any cache and
reports each result with its error, so a user can see why a name is missing.
"""
import socket
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError

_SYSTEM_TIMEOUT_SEC = 3.0
_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="net2map-dns-check")


def _custom_lookup(ip: str, servers: list[str]) -> dict:
    result = {"resolver": "custom", "nameservers": servers, "host": "", "error": ""}
    try:
        import dns.resolver
        import dns.reversename
    except ImportError:
        result["error"] = "dnspython is not installed"
        return result
    try:
        resolver = dns.resolver.Resolver(configure=False)
        resolver.nameservers = servers
        resolver.timeout = 1.5
        resolver.lifetime = 2.5
        answers = resolver.resolve(dns.reversename.from_address(ip), "PTR")
        result["host"] = str(answers[0]).rstrip(".") if answers else ""
        if not result["host"]:
            result["error"] = "empty answer"
    except dns.resolver.NXDOMAIN:
        result["error"] = "NXDOMAIN: no PTR record for this address"
    except dns.resolver.NoAnswer:
        result["error"] = "no PTR record in the answer"
    except dns.resolver.LifetimeTimeout:
        result["error"] = "timeout: no DNS server answered"
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def _system_lookup(ip: str) -> dict:
    result = {"resolver": "system", "nameservers": _system_nameservers(), "host": "", "error": ""}
    future = _POOL.submit(socket.gethostbyaddr, ip)
    try:
        result["host"] = future.result(timeout=_SYSTEM_TIMEOUT_SEC)[0]
    except FutureTimeoutError:
        future.cancel()
        result["error"] = f"timeout after {_SYSTEM_TIMEOUT_SEC:.0f} s"
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def _system_nameservers() -> list[str]:
    """Nameservers of the container's /etc/resolv.conf (best effort)."""
    try:
        with open("/etc/resolv.conf", encoding="utf-8") as fh:
            return [
                parts[1] for parts in (line.split() for line in fh)
                if len(parts) >= 2 and parts[0] == "nameserver"
            ]
    except OSError:
        return []


def check_reverse_dns(ip: str, servers: list[str]) -> list[dict]:
    """Reverse-resolve ``ip`` via the configured servers (if any) and the system resolver.

    Returns one entry per path: ``{resolver, nameservers, host, error}``.
    """
    results = []
    if servers:
        results.append(_custom_lookup(ip, servers))
    results.append(_system_lookup(ip))
    return results
