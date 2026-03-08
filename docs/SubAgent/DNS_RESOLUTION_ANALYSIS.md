# DNS Resolution Analysis

## Problem

Port endpoint tooltips display IP and MAC addresses correctly, but `peer_host` is always empty. Reverse DNS hostname resolution is not populating hostnames during scans.

---

## Architecture Overview

### Data Flow

1. **Scan executes** in Celery worker (`netmap-celery` container) via `tasks.py` -> `_execute_scan()` in `scan_engine.py`
2. **Endpoint data collected** from SNMP: ARP tables (MAC->IP) and FDB tables (MAC->ifIndex) in `snmp_scanner.py`
3. **DNS resolution called** per IP in `_resolve_host()` at `scan_engine.py:237`
4. **Results stored** in `Port.peer_host` and `Port.endpoint_details_json[].host` in the database
5. **Frontend displays** hostname in tooltip (`Port.jsx:142`) and detail modal (`PortDetailModal.jsx:131`)

### Where DNS Settings Are Stored

- DB key: `dns_servers` in `AppSetting` table (default: `"[]"`)
- Read via: `_read_dns_settings()` in `shared/file_settings.py:131`
- Written via: `PUT /api/dns-settings` in `routers/scan_settings.py:89`
- UI: `DnsTab.jsx` - textarea for DNS server IPs, one per line

---

## Root Cause Analysis

### `_resolve_host` Function (scan_engine.py:237-307)

```python
def _resolve_host(ip, cache, dns_servers=None, correlation_id=""):
    if not ip:
        return ""
    if ip in cache:
        return cache[ip]

    if dns_servers:                          # <-- PATH A: custom DNS
        try:
            import dns.resolver              # dnspython library
            import dns.reversename
            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = dns_servers
            resolver.timeout = 1.5
            resolver.lifetime = 2.5
            query_name = dns.reversename.from_address(ip)
            answers = resolver.resolve(query_name, "PTR")
            host = str(answers[0]).rstrip(".") if answers else ""
            cache[ip] = host
            return host
        except Exception:
            pass                             # <-- BUG 1: Silent failure, no logging

    try:                                     # <-- PATH B: system DNS fallback
        cache[ip] = socket.gethostbyaddr(ip)[0]
    except Exception:
        cache[ip] = ""                       # <-- BUG 2: Silent failure, only WARNING log
    return cache[ip]
```

### Identified Issues

#### Issue 1: Empty DNS Servers List = Custom Path Never Entered

At `scan_engine.py:830`:
```python
dns_servers = _read_dns_settings().get("servers", [])
```

If NO DNS servers are configured (default), `dns_servers` is `[]`. Python evaluates `if []:` as `False`, so the **entire custom DNS resolver path (PATH A) is skipped**. Execution goes directly to PATH B (system DNS).

#### Issue 2: Docker DNS Isolation (System DNS Failure)

Both the backend and celery-worker containers run on a Docker bridge network (`netmap`). The `docker-compose.yml` has **no `dns:` configuration** for either container.

Inside Docker, `socket.gethostbyaddr()` uses Docker's embedded DNS resolver (`127.0.0.11`), which:
- Resolves container names (e.g., `postgres`, `redis`)
- Does **NOT** forward PTR (reverse) queries to the host's DNS servers
- Cannot resolve internal network hostnames (e.g., `workstation.corp.local`)

Result: `socket.gethostbyaddr(ip)` raises an exception for every private IP, `cache[ip]` is set to `""`, and `peer_host` is always empty.

#### Issue 3: Silent Exception Swallowing in Custom DNS Path

When custom DNS servers ARE configured and the PTR lookup fails, the exception is caught by a bare `except Exception: pass` with **no logging at all** (line ~283). This makes debugging impossible because:
- Import errors (`dnspython` not installed) would be silently ignored
- Network timeouts would be silently ignored
- NXDOMAIN responses would be silently ignored
- Any misconfiguration goes undetected

After the silent failure, it falls through to the same broken system DNS (PATH B).

#### Issue 4: Celery Worker Also Affected

Scans run via `tasks.py` -> `run_scan_task()` in the `netmap-celery` container. This container has the **same Docker DNS limitations** as the backend. The celery worker has no `dns:` overrides in docker-compose.

---

## Verification Checklist

| Check | Status |
|-------|--------|
| `dnspython>=2.6.1` in requirements.txt | Present (line 15) |
| `_resolve_host` called during scan | Yes, at scan_engine.py:857 and :870 |
| DNS settings DB key seeded | Yes, `("dns_servers", "[]")` at database.py:312 |
| DNS settings API endpoint | Yes, GET/PUT `/api/dns-settings` in scan_settings.py |
| DNS settings UI tab | Yes, `DnsTab.jsx` |
| Docker `dns:` config in compose | **MISSING** for backend and celery-worker |
| Custom DNS error logging | **MISSING** - bare `except Exception: pass` |
| System DNS works in Docker | **NO** - Docker bridge DNS cannot resolve PTR for private IPs |

---

## Root Cause Summary

The most likely scenario is:

1. **No custom DNS servers are configured** in the settings (default `[]`), so the dnspython-based resolver is never used
2. The system fallback (`socket.gethostbyaddr`) runs inside Docker where **PTR resolution for internal IPs fails**
3. Every IP resolves to `""`, so `peer_host` is always empty
4. Even if a user configures DNS servers, failures are **silently swallowed** with no logging, making the feature appear broken with no diagnostic output

---

## Recommended Fixes

### Fix 1: Add DNS Configuration to Docker Containers

In `docker-compose.yml`, add `dns:` to both backend and celery-worker services so `socket.gethostbyaddr()` can use the host's real DNS servers:
```yaml
backend:
  dns:
    - 10.0.0.10   # Internal DNS server
    
celery-worker:
  dns:
    - 10.0.0.10
```

However, this is a deployment-time config. The real fix should work without docker-compose changes.

### Fix 2: Log Custom DNS Failures (Critical)

Replace the silent `except Exception: pass` in the custom DNS path with proper error logging:
```python
except Exception as exc:
    _log_event(
        logging.WARNING,
        "dns.lookup",
        correlation_id=correlation_id,
        ip=ip,
        host="",
        resolver="custom",
        nameservers=dns_servers,
        success=False,
        error=str(exc),
    )
```

### Fix 3: Skip System DNS Fallback When Custom Servers Are Configured

When the user has explicitly configured DNS servers, falling through to system DNS (which inside Docker always fails) is wasteful. If custom DNS fails, cache `""` and return immediately instead of trying the broken system fallback:

```python
if dns_servers:
    try:
        # ... custom resolver ...
        return host
    except Exception as exc:
        _log_event(...)
        cache[ip] = ""
        return ""           # Don't fall through to broken system DNS
```

### Fix 4: Log DNS Resolution Summary

Add a summary log after the endpoint resolution loop so operators can see how many IPs resolved successfully:
```python
resolved_count = sum(1 for v in dns_cache.values() if v)
log.info("DNS resolution: %d/%d IPs resolved to hostnames", resolved_count, len(dns_cache))
```

### Fix 5: Validate DNS Server Connectivity on Save

When updating DNS settings via the API, optionally test a PTR query against a known IP to verify the servers are reachable, and warn if they're not.

---

## Files Involved

| File | Relevance |
|------|-----------|
| `backend/scan_engine.py:237-307` | `_resolve_host()` function with silent failure bugs |
| `backend/scan_engine.py:829-870` | DNS resolution call site during port endpoint processing |
| `backend/shared/file_settings.py:117-140` | DNS settings read/write from DB |
| `backend/routers/scan_settings.py:83-94` | DNS settings API endpoints |
| `backend/database.py:312` | DNS settings default seed value |
| `backend/requirements.txt:15` | dnspython dependency |
| `docker-compose.yml` | Missing `dns:` config for containers |
| `backend/tasks.py` | Celery task that invokes `_execute_scan` |
| `frontend/src/components/settings/DnsTab.jsx` | DNS settings UI |
| `frontend/src/components/Port.jsx:142` | Tooltip display of `peer_host` |
| `frontend/src/components/PortDetailModal.jsx:131` | Detail modal hostname display |
