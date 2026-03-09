"""Scan engine: background scheduler, async scan execution, and supporting utilities."""
import asyncio
import ipaddress
import json
import logging
import platform
import re
import socket
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from database import (
    AppSetting, Credential, Device, Port, SessionLocal, SnmpProfile,
    ScanRun, ScanRunSwitchMetric, SwitchClass, TopologyLink, DryRunResult,
)
from schemas import ScanResult, ScanSwitchMetric
from shared.file_settings import _read_dns_settings, _read_scan_settings
from shared.state import _log_event, set_scan_job, get_scan_job, update_scan_job, can_dispatch_scan
from snmp_scanner import (
    LldpNeighbor, SwitchData, auto_layout, extract_model,
    is_virtual, scan_switch, speed_label,
)
from shared.crypto import decrypt
from shared.metrics import SCAN_ACTIVE, SCAN_DURATION, SCAN_TOTAL, DEVICE_COUNT, PORT_COUNT

log = logging.getLogger(__name__)


def _broadcast_progress(scanned: int, total: int, latest_ip: str, success: bool, job_id: str) -> None:
    """Broadcast scan progress to WebSocket clients (fire-and-forget)."""
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync({
            "type": "scan_progress",
            "job_id": job_id,
            "scanned": scanned,
            "total": total,
            "latest_ip": latest_ip,
            "success": success,
        })
    except Exception:
        pass


def _broadcast_scan_complete(job_id: str, status: str, found: int, links: int, duration_ms: int) -> None:
    """Broadcast scan completion to WebSocket clients."""
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync({
            "type": "scan_complete",
            "job_id": job_id,
            "status": status,
            "found": found,
            "links": links,
            "duration_ms": duration_ms,
        })
    except Exception:
        pass


# ── Shared background event loop ──────────────────────────────────────────────
# A single asyncio event loop running in a daemon thread, reused across all
# scan invocations.  Avoids the overhead of creating/destroying a loop per scan.

_bg_loop: Optional[asyncio.AbstractEventLoop] = None
_bg_loop_lock = threading.Lock()


def _get_bg_loop() -> asyncio.AbstractEventLoop:
    """Return the shared background event loop, starting it lazily."""
    global _bg_loop
    if _bg_loop is not None and _bg_loop.is_running():
        return _bg_loop
    with _bg_loop_lock:
        if _bg_loop is not None and _bg_loop.is_running():
            return _bg_loop
        loop = asyncio.new_event_loop()

        def _run(l: asyncio.AbstractEventLoop):
            asyncio.set_event_loop(l)
            l.run_forever()

        t = threading.Thread(target=_run, args=(loop,), daemon=True)
        t.start()
        _bg_loop = loop
        return loop


# ─── Ping helpers ─────────────────────────────────────────────────────────────

def _build_ping_cmd(ip: str, timeout_sec: int) -> list:
    if platform.system() == "Windows":
        return ["ping", "-n", "1", "-w", str(int(timeout_sec * 1000)), ip]
    return ["ping", "-c", "1", "-W", str(int(timeout_sec)), ip]


def _ping_host(ip: str, timeout_sec: int = 1) -> tuple[bool, int]:
    """Best-effort ICMP ping via system command. Returns (reachable, rtt_ms)."""
    if not ip:
        return False, 0

    cmds = [_build_ping_cmd(ip, timeout_sec)]

    for cmd in cmds:
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(1, timeout_sec + 1),
            )
        except Exception:
            continue

        out = f"{completed.stdout}\n{completed.stderr}".lower()
        if completed.returncode != 0:
            continue

        # Parse common rtt formats: time=1.23 ms / time<1ms / durchschnitt = 2ms
        patterns = [
            r"time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms",
            r"average\s*=\s*([0-9]+)ms",
            r"durchschnitt\s*=\s*([0-9]+)ms",
        ]
        for pattern in patterns:
            m = re.search(pattern, out)
            if m:
                try:
                    return True, int(float(m.group(1)))
                except ValueError:
                    pass
        return True, 1

    return False, 0


# ─── Scan helpers ─────────────────────────────────────────────────────────────

def _safe_json_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            return [str(v) for v in value]
    except Exception:
        pass
    return []


def _canonical_link_key(local_ip: str, local_port: str, remote_ip: str, remote_port: str) -> str:
    return f"{local_ip}|{local_port}|{remote_ip}|{remote_port}"


def _persist_scan_run(db: Session, result: ScanResult, devices_snapshot: List[str], links_snapshot: List[str]) -> int:
    run = ScanRun(
        status=result.status,
        scanned=result.scanned,
        found=result.found,
        links=result.links,
        max_workers=result.max_workers,
        total_duration_ms=result.total_duration_ms,
        error_count=len(result.errors or []),
        devices_snapshot_json=json.dumps(sorted(set(devices_snapshot))),
        links_snapshot_json=json.dumps(sorted(set(links_snapshot))),
    )
    db.add(run)
    db.flush()

    for metric in result.switch_metrics:
        db.add(ScanRunSwitchMetric(
            scan_run_id=run.id,
            ip=metric.ip,
            label=metric.label,
            duration_ms=metric.duration_ms,
            success=metric.success,
            error=metric.error,
        ))

    db.commit()
    return run.id


def _read_discovery_ranges(db: Session) -> List[str]:
    """Return list of configured CIDR/IP discovery ranges from AppSettings."""
    row = db.query(AppSetting).filter(AppSetting.key == "discovery_scan_ranges").first()
    if not row or not row.value:
        return []
    try:
        value = json.loads(row.value)
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
    except Exception:
        pass
    return []


def _expand_ranges_to_ips(ranges: List[str]) -> List[str]:
    """Expand a list of CIDR ranges or single IPs into individual IP strings."""
    result: List[str] = []
    for entry in ranges:
        entry = entry.strip()
        if not entry:
            continue
        try:
            network = ipaddress.ip_network(entry, strict=False)
            # Skip gigantic ranges (> 65536 hosts) to avoid memory issues
            if network.num_addresses > 65536:
                log.warning("Skipping oversized range %s (%d hosts)", entry, network.num_addresses)
                continue
            result.extend(str(ip) for ip in network.hosts())
        except ValueError:
            try:
                result.append(str(ipaddress.ip_address(entry)))
            except ValueError:
                log.warning("Invalid IP/range in discovery_scan_ranges: %s", entry)
    return result


def _resolve_ip(sys_name: str, switch_data: dict) -> str:
    """Try to find the management IP of a device by sysName in the scan batch."""
    for ip, sw in switch_data.items():
        if sw.sys_name and sys_name.lower() in sw.sys_name.lower():
            return ip
    try:
        return socket.gethostbyname(sys_name)
    except Exception:
        return ""


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


# ─── Core scan engine ─────────────────────────────────────────────────────────

async def _execute_scan(
    db: Session,
    cancel_event=None,
    correlation_id: Optional[str] = None,
    scan_type: str = "full",
    dry_run: bool = False,
) -> ScanResult:
    corr = correlation_id or str(uuid.uuid4())

    scan_mode = scan_type if scan_type in {"discovery", "ports", "links", "macs", "full"} else "full"
    SCAN_ACTIVE.inc()

    if scan_mode in {"ports", "links", "macs"}:
        # Only scan credentials that are already in the Device table and not ignored
        known_ips = {d.ip for d in db.query(Device.ip).filter(Device.ignored == False).all()}
        credentials = db.query(Credential).filter(
            Credential.enabled == True, Credential.ip.in_(known_ips)
        ).order_by(Credential.ip, Credential.priority).all()
    else:
        credentials = db.query(Credential).filter(
            Credential.enabled == True
        ).order_by(Credential.ip, Credential.priority).all()

    # Group credentials by IP for fallback chain support
    from collections import defaultdict
    creds_by_ip: Dict[str, List] = defaultdict(list)
    for c in credentials:
        creds_by_ip[c.ip].append(c)

    scan_settings = _read_scan_settings()
    configured_max_workers = scan_settings.get("max_workers", 4)
    global_snmp_timeout = scan_settings.get("snmp_timeout", 3)
    global_snmp_retries = scan_settings.get("snmp_retries", 1)

    # ── Range-based discovery (only for discovery/full scans) ──────────────────
    range_targets: List[dict] = []
    if scan_mode in {"discovery", "full"}:
        configured_ranges = _read_discovery_ranges(db)
        if configured_ranges:
            range_ips = _expand_ranges_to_ips(configured_ranges)
            cred_ips = {c.ip for c in credentials}
            # Load all profiles to try for each range IP
            all_profiles = db.query(SnmpProfile).order_by(SnmpProfile.id).all()
            for ip in range_ips:
                if ip in cred_ips:
                    continue  # already covered by existing credential
                if all_profiles:
                    profiles_data = [
                        {
                            "profile_id": p.id,
                            "profile_label": p.label,
                            "snmp_version": p.snmp_version,
                            "community": p.community,
                            "v3_security_level": p.v3_security_level,
                            "v3_username": p.v3_username,
                            "v3_auth_protocol": p.v3_auth_protocol,
                            "v3_auth_password": decrypt(p.v3_auth_password),
                            "v3_priv_protocol": p.v3_priv_protocol,
                            "v3_priv_password": decrypt(p.v3_priv_password),
                        }
                        for p in all_profiles
                    ]
                else:
                    # No profiles defined - try SNMPv2c public as fallback
                    profiles_data = [{
                        "profile_id": None,
                        "profile_label": "default-public",
                        "snmp_version": "v2c",
                        "community": "public",
                        "v3_security_level": "authPriv",
                        "v3_username": "",
                        "v3_auth_protocol": "SHA-256",
                        "v3_auth_password": "",
                        "v3_priv_protocol": "AES-128",
                        "v3_priv_password": "",
                    }]
                range_targets.append({
                    "ip": ip,
                    "label": ip,
                    "profile_key": f"range_probe:{ip}",
                    "snmp_port": 161,
                    "snmp_timeout": global_snmp_timeout,
                    "snmp_retries": global_snmp_retries,
                    "is_range_probe": True,
                    "profiles_to_try": profiles_data,
                    # These fields are filled after profile selection:
                    "snmp_version": "v2c",
                    "community": "public",
                    "v3_security_level": "authPriv",
                    "v3_username": "",
                    "v3_auth_protocol": "SHA-256",
                    "v3_auth_password": "",
                    "v3_priv_protocol": "AES-128",
                    "v3_priv_password": "",
                })
            _log_event(
                logging.INFO,
                "scan.range_probe.start",
                correlation_id=corr,
                ranges=configured_ranges,
                range_ips=len(range_ips),
                new_ips=len(range_targets),
                profiles=len(all_profiles),
            )

    _log_event(
        logging.INFO,
        "scan.start",
        correlation_id=corr,
        scan_type=scan_mode,
        enabled_credentials=len(credentials),
        range_probes=len(range_targets),
        configured_max_workers=configured_max_workers,
    )

    if not credentials and not range_targets:
        result = ScanResult(
            scanned=0,
            found=0,
            links=0,
            errors=["No enabled credentials and no discovery ranges configured"],
            max_workers=configured_max_workers,
            total_duration_ms=0,
            switch_metrics=[],
            status="finished",
        )
        _log_event(logging.INFO, "scan.end", correlation_id=corr, status=result.status, scanned=0, found=0, links=0, total_duration_ms=0)
        SCAN_ACTIVE.dec()
        SCAN_TOTAL.labels(scan_type=scan_mode, status="finished").inc()
        return result

    errors: List[str] = []
    switch_data: Dict[str, SwitchData] = {}
    ping_by_ip: Dict[str, tuple[bool, int]] = {}
    switch_metrics: List[ScanSwitchMetric] = []
    range_found_ips: List[str] = []  # IPs from ranges that responded to SNMP

    scan_targets = []

    def _cred_to_snmp_dict(cred):
        p = cred.profile
        return {
            "snmp_port": cred.snmp_port,
            "snmp_version": p.snmp_version if p else cred.snmp_version,
            "community": p.community if p else cred.community,
            "v3_security_level": p.v3_security_level if p else cred.v3_security_level,
            "v3_username": p.v3_username if p else cred.v3_username,
            "v3_auth_protocol": p.v3_auth_protocol if p else cred.v3_auth_protocol,
            "v3_auth_password": decrypt(p.v3_auth_password if p else cred.v3_auth_password),
            "v3_priv_protocol": p.v3_priv_protocol if p else cred.v3_priv_protocol,
            "v3_priv_password": decrypt(p.v3_priv_password if p else cred.v3_priv_password),
        }

    for ip, ip_creds in creds_by_ip.items():
        primary = ip_creds[0]
        p = primary.profile
        profile_key = f"profile:{p.id}" if p else f"cred:{primary.id}"
        primary_snmp = _cred_to_snmp_dict(primary)

        fallback_creds = []
        for fc in ip_creds[1:]:
            fallback_creds.append(_cred_to_snmp_dict(fc))

        scan_targets.append({
            "ip": ip,
            "label": primary.label,
            "profile_key": profile_key,
            **primary_snmp,
            "snmp_timeout": global_snmp_timeout,
            "snmp_retries": global_snmp_retries,
            "is_range_probe": False,
            "fallback_creds": fallback_creds,
        })

    scan_targets.extend(range_targets)

    async def _ping_host_async(ip: str, timeout_sec: int = 1) -> tuple[bool, int]:
        """Non-blocking ICMP ping via asyncio subprocess."""
        if not ip:
            return False, 0
        cmd = _build_ping_cmd(ip, timeout_sec)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=max(1, timeout_sec + 1))
            except asyncio.TimeoutError:
                proc.kill()
                return False, 0
            if proc.returncode != 0:
                return False, 0
            out = (stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")).lower()
            for pat in [
                r"time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms",
                r"average\s*=\s*([0-9]+)ms",
                r"durchschnitt\s*=\s*([0-9]+)ms",
            ]:
                m = re.search(pat, out)
                if m:
                    return True, max(1, int(float(m.group(1))))
            return True, 1
        except Exception:
            return False, 0

    async def _scan_target_async(target: dict, sem: asyncio.Semaphore):
        async with sem:
            started = time.perf_counter()
            ip = target["ip"]
            label = target["label"]
            is_probe = target.get("is_range_probe", False)
            ping_ok, ping_rtt = await _ping_host_async(ip)

            # For range probes: skip SNMP scan if host does not respond to ping
            if is_probe and not ping_ok:
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, "no ping", duration_ms, False, 0, is_probe, None

            if cancel_event and cancel_event.is_set():
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, "cancelled", duration_ms, ping_ok, ping_rtt, is_probe, None

            # For range probes: try all profiles in sequence until one succeeds
            if is_probe:
                profiles_to_try = target.get("profiles_to_try", [])
                for prof in profiles_to_try:
                    try:
                        data = await scan_switch(
                            ip=ip,
                            snmp_version=prof["snmp_version"],
                            community=prof["community"],
                            snmp_port=target["snmp_port"],
                            snmp_timeout=target["snmp_timeout"],
                            snmp_retries=target["snmp_retries"],
                            v3_security_level=prof["v3_security_level"],
                            v3_username=prof["v3_username"],
                            v3_auth_protocol=prof["v3_auth_protocol"],
                            v3_auth_password=prof["v3_auth_password"],
                            v3_priv_protocol=prof["v3_priv_protocol"],
                            v3_priv_password=prof["v3_priv_password"],
                            scan_type="discovery",
                        )
                        if data:
                            duration_ms = int((time.perf_counter() - started) * 1000)
                            return ip, label, data, "", duration_ms, ping_ok, ping_rtt, is_probe, prof["profile_id"]
                    except Exception:
                        continue
                # No profile worked
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, "no profile suitable", duration_ms, ping_ok, ping_rtt, is_probe, None

            # Try primary credential, then fallback credentials in priority order
            all_cred_sets = [target] + target.get("fallback_creds", [])
            last_error = "no SNMP response"
            for cred_set in all_cred_sets:
                try:
                    data = await scan_switch(
                        ip=ip,
                        snmp_version=cred_set["snmp_version"],
                        community=cred_set["community"],
                        snmp_port=cred_set.get("snmp_port", target["snmp_port"]),
                        snmp_timeout=target["snmp_timeout"],
                        snmp_retries=target["snmp_retries"],
                        v3_security_level=cred_set["v3_security_level"],
                        v3_username=cred_set["v3_username"],
                        v3_auth_protocol=cred_set["v3_auth_protocol"],
                        v3_auth_password=cred_set["v3_auth_password"],
                        v3_priv_protocol=cred_set["v3_priv_protocol"],
                        v3_priv_password=cred_set["v3_priv_password"],
                        scan_type=scan_mode,
                    )
                    if data:
                        if cred_set is not target:
                            log.info("Credential fallback succeeded for %s", ip)
                        duration_ms = int((time.perf_counter() - started) * 1000)
                        return ip, label, data, "", duration_ms, ping_ok, ping_rtt, is_probe, None
                except Exception as exc:
                    last_error = str(exc)
                    continue
            duration_ms = int((time.perf_counter() - started) * 1000)
            return ip, label, None, last_error, duration_ms, ping_ok, ping_rtt, is_probe, None

    # Track per-IP matched profile for auto-credential creation
    range_matched_profile: Dict[str, Optional[int]] = {}
    # Track IPs that responded but no profile matched
    range_no_profile_ips: List[str] = []

    scan_started = time.perf_counter()
    workers = max(1, min(int(configured_max_workers), max(len(scan_targets), 1)))
    sem = asyncio.Semaphore(workers)

    results = await asyncio.gather(
        *[_scan_target_async(t, sem) for t in scan_targets],
        return_exceptions=False,
    )
    total_targets = len(scan_targets)
    scanned_count = 0
    for ip, label, data, error_msg, duration_ms, ping_ok, ping_rtt, is_probe, matched_profile_id in results:
        scanned_count += 1
        ping_by_ip[ip] = (ping_ok, ping_rtt)
        if data:
            switch_data[ip] = data
            if is_probe:
                range_found_ips.append(ip)
                range_matched_profile[ip] = matched_profile_id
            _log_event(
                logging.INFO,
                "scan.switch.result",
                correlation_id=corr,
                ip=ip,
                label=label,
                success=True,
                ping_ok=ping_ok,
                ping_rtt_ms=ping_rtt,
                duration_ms=duration_ms,
                range_probe=is_probe,
            )
            switch_metrics.append(ScanSwitchMetric(
                ip=ip, label=label, duration_ms=duration_ms, success=True, error=""
            ))
        else:
            # Suppress noisy "no ping" errors for range probes (expected for most hosts)
            if error_msg and error_msg not in ("cancelled", "no ping") and not is_probe:
                if ping_ok:
                    errors.append(f"{ip}: {error_msg} (ping ok)")
                else:
                    errors.append(f"{ip}: {error_msg}")
            if is_probe and error_msg == "no profile suitable" and ping_ok:
                range_no_profile_ips.append(ip)
            if not is_probe or (error_msg and error_msg not in ("cancelled", "no ping")):
                _log_event(
                    logging.WARNING if (error_msg and error_msg not in ("cancelled", "no ping") and not is_probe) else logging.DEBUG,
                    "scan.switch.result",
                    correlation_id=corr,
                    ip=ip,
                    label=label,
                    success=False,
                    ping_ok=ping_ok,
                    ping_rtt_ms=ping_rtt,
                    duration_ms=duration_ms,
                    error=error_msg,
                    range_probe=is_probe,
                )
            if not is_probe:
                switch_metrics.append(ScanSwitchMetric(
                    ip=ip, label=label, duration_ms=duration_ms,
                    success=False, error=error_msg or "no SNMP response"
                ))

        # Broadcast progress to WebSocket clients
        _broadcast_progress(scanned_count, total_targets, ip, bool(data), corr)

    total_duration_ms = int((time.perf_counter() - scan_started) * 1000)
    switch_metrics.sort(key=lambda m: m.duration_ms, reverse=True)
    status = "cancelled" if (cancel_event and cancel_event.is_set()) else "finished"

    # In dry_run mode: return preview without writing anything to DB
    if dry_run:
        dry_run_preview = []
        for ip in range_found_ips:
            sw = switch_data.get(ip)
            prof_id = range_matched_profile.get(ip)
            existing_cred = db.query(Credential).filter(Credential.ip == ip).first()
            dry_run_preview.append({
                "ip": ip,
                "sys_name": sw.sys_name if sw else "",
                "sys_descr": sw.sys_descr if sw else "",
                "vendor": sw.vendor if sw else "generic",
                "location": sw.location if sw else "",
                "matched_profile_id": prof_id,
                "already_exists": existing_cred is not None,
            })
        for ip in range_no_profile_ips:
            ping_ok, _ = ping_by_ip.get(ip, (False, 0))
            if ping_ok:
                dry_run_preview.append({
                    "ip": ip,
                    "sys_name": "",
                    "sys_descr": "",
                    "vendor": "unknown",
                    "location": "",
                    "matched_profile_id": None,
                    "already_exists": False,
                    "no_profile_suitable": True,
                })
        result = ScanResult(
            scanned=len(scan_targets),
            found=len(range_found_ips),
            links=0,
            errors=errors,
            max_workers=workers,
            total_duration_ms=total_duration_ms,
            switch_metrics=switch_metrics,
            status="dry_run",
        )
        # Attach preview as extra data outside the Pydantic model
        result.__dict__["_dry_run_preview"] = dry_run_preview

        # Persist dry-run result to database
        run_id = _persist_scan_run(db, result, [], [])
        dry_run_record = DryRunResult(
            scan_run_id=run_id,
            preview_json=dry_run_preview,
        )
        db.add(dry_run_record)
        db.commit()
        result.run_id = run_id

        SCAN_ACTIVE.dec()
        SCAN_DURATION.labels(scan_type=scan_mode).observe(total_duration_ms / 1000)
        SCAN_TOTAL.labels(scan_type=scan_mode, status="dry_run").inc()
        return result

    # Auto-create credentials for IPs discovered via range probes
    if range_found_ips:
        for found_ip in range_found_ips:
            existing_cred = db.query(Credential).filter(Credential.ip == found_ip).first()
            if not existing_cred:
                sw = switch_data.get(found_ip)
                cred_label = sw.sys_name if (sw and sw.sys_name) else found_ip
                matched_prof_id = range_matched_profile.get(found_ip)
                matched_prof = db.query(SnmpProfile).filter(SnmpProfile.id == matched_prof_id).first() if matched_prof_id else None
                new_cred = Credential(
                    label=cred_label,
                    ip=found_ip,
                    snmp_port=161,
                    enabled=True,
                    location=sw.location if sw else "",
                    profile_id=matched_prof.id if matched_prof else None,
                    snmp_version=(matched_prof.snmp_version if matched_prof else "v2c"),
                    community=(matched_prof.community if matched_prof else "public"),
                    v3_security_level=(matched_prof.v3_security_level if matched_prof else "authPriv"),
                    v3_username=(matched_prof.v3_username if matched_prof else ""),
                    v3_auth_protocol=(matched_prof.v3_auth_protocol if matched_prof else "SHA-256"),
                    v3_auth_password=(matched_prof.v3_auth_password if matched_prof else ""),
                    v3_priv_protocol=(matched_prof.v3_priv_protocol if matched_prof else "AES-128"),
                    v3_priv_password=(matched_prof.v3_priv_password if matched_prof else ""),
                )
                db.add(new_cred)
                _log_event(
                    logging.INFO,
                    "scan.range_probe.auto_credential",
                    correlation_id=corr,
                    ip=found_ip,
                    label=cred_label,
                    profile_id=matched_prof.id if matched_prof else None,
                )
        db.commit()

    discovered_ips = set(switch_data.keys()) | {ip for ip, (ok, _) in ping_by_ip.items() if ok}
    existing_ips = {d.ip for d in db.query(Device.ip).all()}
    new_ips = [ip for ip in discovered_ips if ip not in existing_ips]
    all_ips_ordered = list(existing_ips) + new_ips
    layout = auto_layout(all_ips_ordered)
    # Reload credentials to include any auto-created entries from range probes
    cred_by_ip = {c.ip: c for c in db.query(Credential).filter(Credential.ip.in_(list(discovered_ips))).all()}
    class_by_id = {sc.id: sc for sc in db.query(SwitchClass).all()}

    for ip in discovered_ips:
        sw = switch_data.get(ip)
        ping_ok, ping_rtt = ping_by_ip.get(ip, (False, 0))
        ping_status = "online" if ping_ok else "offline"
        cred = cred_by_ip.get(ip)

        # Determine vendor and model (credential overrides autodetect)
        vendor = cred.vendor if (cred and cred.vendor) else (sw.vendor if sw else "generic")
        model = cred.model if (cred and cred.model) else (extract_model(sw.sys_descr, sw.vendor) if sw else "")

        device = db.query(Device).filter(Device.ip == ip).first()
        if device:
            if sw:
                device.sys_name  = sw.sys_name  or device.sys_name
                device.sys_descr = sw.sys_descr or device.sys_descr
                device.location  = sw.location  or device.location
                device.model     = model        or device.model
                device.vendor    = vendor
                device.last_seen = datetime.now(timezone.utc)
            elif ping_ok:
                device.sys_name = device.sys_name or ip
                device.sys_descr = device.sys_descr or "Discovered by ping (SNMP unavailable)"
                device.vendor = vendor or device.vendor or "generic"
                device.model = model or device.model
            device.ping_status = ping_status
            device.ping_rtt_ms = ping_rtt if ping_ok else 0
            device.last_ping = datetime.now(timezone.utc)
            if cred:
                target_rack_id = cred.rack_id if cred.rack_id is not None else device.rack_id
                target_class_id = cred.class_id if cred.class_id is not None else device.class_id
                invalid_combo = False
                if target_rack_id is None and target_class_id is not None:
                    target_class = class_by_id.get(target_class_id)
                    invalid_combo = (target_class is None) or (not target_class.allow_outside_rack)
                if invalid_combo:
                    _log_event(
                        logging.WARNING,
                        "scan.device_sync.skipped_invalid_outside_rack",
                        correlation_id=corr,
                        ip=ip,
                        credential_rack_id=cred.rack_id,
                        credential_class_id=cred.class_id,
                    )
                else:
                    if cred.rack_id is not None:
                        device.rack_id = cred.rack_id
                    if cred.class_id is not None:
                        device.class_id = cred.class_id
        else:
            x, y = layout.get(ip, (100.0, 100.0))
            rack_id = cred.rack_id if cred else None
            class_id = cred.class_id if cred else None
            if rack_id is None and class_id is not None:
                target_class = class_by_id.get(class_id)
                if target_class is None or not target_class.allow_outside_rack:
                    _log_event(
                        logging.WARNING,
                        "scan.device_create.skipped_invalid_outside_rack_class",
                        correlation_id=corr,
                        ip=ip,
                        credential_class_id=class_id,
                    )
                    class_id = None
            db.add(Device(
                ip=ip,
                sys_name=sw.sys_name if sw else ip,
                sys_descr=sw.sys_descr if sw else "Discovered by ping (SNMP unavailable)",
                model=model,
                vendor=vendor,
                location=sw.location if sw else "",
                ping_status=ping_status,
                ping_rtt_ms=ping_rtt if ping_ok else 0,
                last_ping=datetime.now(timezone.utc),
                map_x=x,
                map_y=y,
                rack_id=rack_id,
                class_id=class_id,
            ))

    db.commit()

    link_count = 0
    update_ports = scan_mode in {"full", "ports", "macs"}
    update_links = scan_mode in {"full", "ports", "links"}
    if update_ports:
        if cancel_event and cancel_event.is_set():
            status = "cancelled"
        else:
            try:
                dns_cache: Dict[str, str] = {}
                dns_servers = _read_dns_settings().get("servers", [])

                global_arp: dict = {}
                for sw_data in switch_data.values():
                    for mac, arp_ip in sw_data.arp_table.items():
                        if mac and arp_ip:
                            global_arp.setdefault(mac, arp_ip)

                log.info("Global ARP table: %d entries merged from %d devices", len(global_arp), len(switch_data))

                for ip, sw in switch_data.items():
                    if cancel_event and cancel_event.is_set():
                        db.rollback()
                        status = "cancelled"
                        break

                    device = db.query(Device).filter(Device.ip == ip).first()
                    if not device:
                        continue
                    if device.ignored:
                        continue

                    peers_by_ifindex: Dict[int, List[tuple[str, str, str]]] = {}
                    for mac, peer_ip in sw.arp_table.items():
                        ifindex = sw.mac_ifindex.get(mac)
                        if ifindex is None or not peer_ip:
                            continue
                        peer_host = _resolve_host(peer_ip, dns_cache, dns_servers, correlation_id=corr)
                        peers_by_ifindex.setdefault(ifindex, []).append((mac, peer_ip, peer_host))

                    # MAC-only entries: FDB has MAC->ifIndex, but no ARP entry
                    lldp_ifindexes = set()
                    for nbr in sw.lldp_neighbors:
                        lldp_ifindexes.add(nbr.local_port_idx)

                    macs_with_arp = set(sw.arp_table.keys())
                    for mac, ifindex in sw.mac_ifindex.items():
                        if mac in macs_with_arp:
                            continue
                        if ifindex in lldp_ifindexes:
                            continue
                        resolved_ip = global_arp.get(mac, "")
                        resolved_host = ""
                        if resolved_ip:
                            resolved_host = _resolve_host(resolved_ip, dns_cache, dns_servers, correlation_id=corr)
                        peers_by_ifindex.setdefault(ifindex, []).append((mac, resolved_ip, resolved_host))

                    db.query(Port).filter(Port.device_id == device.id).delete()
                    port_rows = []
                    for iface in sw.interfaces.values():
                        if is_virtual(iface.descr, sw.vendor):
                            continue

                        peer_mac = ""
                        peer_ip = ""
                        peer_host = ""
                        endpoint_entries: List[tuple[str, str, str]] = []
                        if iface.index in peers_by_ifindex and peers_by_ifindex[iface.index]:
                            endpoint_entries = sorted(
                                peers_by_ifindex[iface.index],
                                key=lambda x: (x[1] == "", x[1], x[0])
                            )
                            peer_mac, peer_ip, peer_host = endpoint_entries[0]

                        endpoint_details = [
                            {"mac": mac, "ip": ip_addr, "host": host}
                            for mac, ip_addr, host in endpoint_entries
                        ]

                        port_rows.append({
                            "device_id": device.id,
                            "if_index": iface.index,
                            "if_descr": iface.descr,
                            "if_alias": iface.alias,
                            "speed_mbps": iface.speed_mbps,
                            "oper_status": iface.oper_status,
                            "peer_mac": peer_mac,
                            "peer_ip": peer_ip,
                            "peer_host": peer_host,
                            "endpoint_count": len(endpoint_details),
                            "endpoint_details_json": endpoint_details,
                            "vlan": iface.vlan,
                            "tagged_vlans": iface.tagged_vlans,
                        })
                    if port_rows:
                        db.bulk_insert_mappings(Port, port_rows)
                    db.commit()
            except Exception:
                db.rollback()
                log.exception("Error during port update, rolled back")
                errors.append("Port update failed (rolled back)")

    if update_links:
        if cancel_event and cancel_event.is_set():
            status = "cancelled"
        else:
            try:
                scanned_ips = set(switch_data.keys())
                db.query(TopologyLink).filter(TopologyLink.local_ip.in_(scanned_ips)).delete(
                    synchronize_session=False
                )

                # Build a lookup: remote_ip -> { norm(if_descr) -> if_descr } for
                # resolving LLDP remote_port abbreviations to the canonical if_descr.
                def _norm(s: str) -> str:
                    return (s or "").strip().lower()

                def _port_suffix(s: str) -> str:
                    """Return the numeric/slash suffix of a port name.
                    e.g. 'TenGigabitEthernet 1/0/1' -> '1/0/1', 'TF2/0/21' -> '2/0/21'
                    Strip all letters and leading spaces before the first digit group.
                    """
                    import re
                    m = re.search(r'(\d[\d/]+)$', (s or "").strip())
                    return m.group(1) if m else _norm(s)

                port_lookup: Dict[str, Dict[str, str]] = {}
                port_suffix_lookup: Dict[str, Dict[str, str]] = {}
                for ip, sw in switch_data.items():
                    port_lookup[ip] = {}
                    for iface in sw.interfaces.values():
                        # Primary key: ifDescr (canonical)
                        port_lookup[ip][_norm(iface.descr)] = iface.descr
                        # Secondary key: ifAlias (e.g. OPNsense uses "lan" alias for "mlxen0")
                        if iface.alias:
                            port_lookup[ip].setdefault(_norm(iface.alias), iface.descr)
                    port_suffix_lookup[ip] = {}
                    for iface in sw.interfaces.values():
                        sfx = _port_suffix(iface.descr)
                        # Only store if the suffix is unique enough (contains /)
                        if "/" in sfx:
                            port_suffix_lookup[ip][sfx] = iface.descr

                for ip, sw in switch_data.items():
                    if cancel_event and cancel_event.is_set():
                        db.rollback()
                        status = "cancelled"
                        break

                    for nbr in sw.lldp_neighbors:
                        if not nbr.remote_sys:
                            continue
                        remote_ip = _resolve_ip(nbr.remote_sys, switch_data)
                        spd_label = speed_label(sw.interfaces[nbr.local_port_idx].speed_mbps) \
                            if nbr.local_port_idx in sw.interfaces else "1G"

                        # Resolve remote_port to canonical if_descr when possible so the
                        # frontend can match LLDP port names to scanned port if_descr values.
                        resolved_remote_port = nbr.remote_port
                        if remote_ip and remote_ip in port_lookup:
                            # First try exact normalized match
                            canonical = port_lookup[remote_ip].get(_norm(nbr.remote_port))
                            if canonical:
                                resolved_remote_port = canonical
                            else:
                                # Fallback: match by numeric suffix (e.g. TF2/0/21 -> TFGigabitEthernet 2/0/21)
                                sfx = _port_suffix(nbr.remote_port)
                                if "/" in sfx:
                                    canonical = port_suffix_lookup[remote_ip].get(sfx)
                                    if canonical:
                                        resolved_remote_port = canonical
                            if resolved_remote_port == nbr.remote_port:
                                # Fallback: lldpd on FreeBSD/OPNsense formats portDesc as
                                # "Description (ifname)" -- extract the ifname from parens.
                                m = re.search(r'\(([^)]+)\)\s*$', nbr.remote_port)
                                if m:
                                    canonical = port_lookup[remote_ip].get(_norm(m.group(1)))
                                    if canonical:
                                        resolved_remote_port = canonical
                            if resolved_remote_port == nbr.remote_port and nbr.remote_port_id:
                                # Last resort: try the raw lldpRemPortId (e.g. 'mlxen0' on OPNsense)
                                canonical = port_lookup[remote_ip].get(_norm(nbr.remote_port_id))
                                if canonical:
                                    resolved_remote_port = canonical

                        db.add(TopologyLink(
                            local_ip=ip,
                            local_port=nbr.local_port_desc or str(nbr.local_port_idx),
                            remote_ip=remote_ip,
                            remote_sys=nbr.remote_sys,
                            remote_port=resolved_remote_port,
                            speed_label=spd_label,
                        ))
                        link_count += 1
                else:
                    db.commit()
            except Exception:
                db.rollback()
                log.exception("Error during link update, rolled back")
                errors.append("Link update failed (rolled back)")

    result = ScanResult(
        scanned=len(scan_targets),
        found=len(discovered_ips),
        links=link_count,
        errors=errors,
        max_workers=workers,
        total_duration_ms=total_duration_ms,
        switch_metrics=switch_metrics,
        status=status,
    )
    snapshot_devices = sorted({str(ip) for ip in discovered_ips if ip})
    if snapshot_devices:
        snapshot_link_rows = db.query(TopologyLink).filter(TopologyLink.local_ip.in_(snapshot_devices)).all()
    else:
        snapshot_link_rows = []
    snapshot_links = sorted({
        _canonical_link_key(
            str(link.local_ip or ""),
            str(link.local_port or ""),
            str(link.remote_ip or ""),
            str(link.remote_port or ""),
        )
        for link in snapshot_link_rows
    })
    result.run_id = _persist_scan_run(db, result, snapshot_devices, snapshot_links)
    _log_event(
        logging.INFO,
        "scan.end",
        correlation_id=corr,
        status=result.status,
        scanned=result.scanned,
        found=result.found,
        links=result.links,
        total_duration_ms=result.total_duration_ms,
        errors=len(result.errors),
        run_id=result.run_id,
    )
    _broadcast_scan_complete(corr, result.status, result.found, result.links, result.total_duration_ms)

    # Update Prometheus metrics
    SCAN_ACTIVE.dec()
    SCAN_DURATION.labels(scan_type=scan_mode).observe(total_duration_ms / 1000)
    SCAN_TOTAL.labels(scan_type=scan_mode, status=status).inc()
    DEVICE_COUNT.set(db.query(Device).count())
    PORT_COUNT.labels(status="up").set(db.query(Port).filter(Port.oper_status == 1).count())
    PORT_COUNT.labels(status="down").set(db.query(Port).filter(Port.oper_status == 2).count())

    return result


# ─── Job management ───────────────────────────────────────────────────────────

def _run_scan_job(job_id: str, cancel_event: threading.Event, dry_run: bool = False, scan_type: str = "full"):
    db = SessionLocal()
    result = None
    try:
        loop = _get_bg_loop()
        future = asyncio.run_coroutine_threadsafe(
            _execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run, scan_type=scan_type),
            loop,
        )
        result = future.result()  # blocks until done
    except Exception as exc:
        result = ScanResult(
            scanned=0,
            found=0,
            links=0,
            errors=[str(exc)],
            max_workers=1,
            total_duration_ms=0,
            switch_metrics=[],
            status="failed",
        )
    finally:
        db.close()

    if result is None:
        return

    result_dict = result.model_dump()
    if dry_run:
        result_dict["preview"] = result.__dict__.get("_dry_run_preview", [])

    update_scan_job(job_id, {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "result": result_dict,
        "status": result.status if result.status in {"finished", "cancelled", "dry_run"} else "failed",
    })


def _start_job(dry_run: bool = False, scan_type: str = "full") -> dict:
    job_id = str(uuid.uuid4())

    # Try Celery dispatch if Redis is available
    from shared.redis_client import get_redis
    if get_redis():
        try:
            from tasks import run_scan_task
            set_scan_job(job_id, {
                "id": job_id,
                "status": "queued",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "result": None,
                "cancel_requested": False,
            })
            run_scan_task.delay(job_id, dry_run, scan_type)
            _log_event(logging.INFO, "scan.job.start", correlation_id=job_id, job_id=job_id, dry_run=dry_run, backend="celery")
            return {"job_id": job_id, "status": "queued"}
        except Exception as exc:
            _log_event(logging.WARNING, "scan.job.celery_fallback", error=str(exc))

    # Thread-based fallback
    cancel_event = threading.Event()
    set_scan_job(job_id, {
        "id": job_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "result": None,
        "cancel_requested": False,
        "cancel_event": cancel_event,
        "thread": None,
    })

    t = threading.Thread(target=_run_scan_job, args=(job_id, cancel_event, dry_run, scan_type), daemon=True)
    update_scan_job(job_id, {"thread": t})
    t.start()
    _log_event(logging.INFO, "scan.job.start", correlation_id=job_id, job_id=job_id, dry_run=dry_run, backend="thread")

    return {"job_id": job_id, "status": "running"}


# ─── Background scheduler ─────────────────────────────────────────────────────

# Wake event: set this to interrupt the scheduler sleep early (e.g. when
# settings change and the scheduler should re-evaluate intervals immediately).
_scheduler_wake = threading.Event()


def _dispatch_scheduled_scan(scan_type: str):
    """Run a scheduled scan, using Celery if available, otherwise directly.

    Checks the distributed scan lock before dispatching: if a higher-priority
    scan is running or waiting, this scan is skipped.
    """
    if not can_dispatch_scan(scan_type):
        _log_event(logging.INFO, "scheduler.%s.skipped" % scan_type,
                   reason="higher_priority_scan_active_or_waiting")
        return

    from shared.redis_client import get_redis
    if get_redis():
        try:
            from tasks import run_scan_task
            job_id = str(uuid.uuid4())
            set_scan_job(job_id, {
                "id": job_id,
                "status": "queued",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "result": None,
                "cancel_requested": False,
            })
            run_scan_task.delay(job_id, False, scan_type)
            _log_event(logging.INFO, "scheduler.%s.dispatched" % scan_type, backend="celery")
            return
        except Exception as exc:
            _log_event(logging.WARNING, "scheduler.celery_fallback", error=str(exc), scan_type=scan_type)

    # Direct execution fallback (also needs lock)
    from shared.state import acquire_scan_lock, release_scan_lock
    if not acquire_scan_lock(scan_type, timeout=60):
        _log_event(logging.INFO, "scheduler.%s.lock_timeout" % scan_type)
        return

    db = SessionLocal()
    loop = _get_bg_loop()
    try:
        future = asyncio.run_coroutine_threadsafe(
            _execute_scan(db, scan_type=scan_type), loop,
        )
        future.result()
    except Exception as e:
        _log_event(logging.ERROR, "scheduler.%s.error" % scan_type, error=str(e))
    finally:
        release_scan_lock(scan_type)
        db.close()


def _background_scheduler():
    """Runs discovery, link and MAC scans periodically based on app settings."""
    last_discovery = 0
    last_links = 0
    last_macs = 0

    while True:
        _scheduler_wake.wait(timeout=5)
        _scheduler_wake.clear()

        try:
            # Use a short-lived session only for reading settings
            settings_db = SessionLocal()
            try:
                discovery_setting = settings_db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").first()
                links_setting = settings_db.query(AppSetting).filter(AppSetting.key == "link_update_interval_sec").first()
                macs_setting = settings_db.query(AppSetting).filter(AppSetting.key == "mac_update_interval_sec").first()
                ports_legacy_setting = settings_db.query(AppSetting).filter(AppSetting.key == "port_update_interval_sec").first()

                discovery_interval = int(discovery_setting.value) if discovery_setting else 1800
                legacy_ports_interval = int(ports_legacy_setting.value) if ports_legacy_setting else 30
                links_interval = int(links_setting.value) if links_setting else legacy_ports_interval
                macs_interval = int(macs_setting.value) if macs_setting else legacy_ports_interval
            finally:
                settings_db.close()

            now = time.time()

            # Dispatch in priority order: macs > links > discovery
            # Higher-priority scans are dispatched first so they register
            # in the waiting set before lower-priority checks run.
            if macs_interval > 0 and (now - last_macs) >= macs_interval:
                _log_event(logging.INFO, "scheduler.macs.start")
                _dispatch_scheduled_scan("macs")
                last_macs = time.time()

            if links_interval > 0 and (now - last_links) >= links_interval:
                _log_event(logging.INFO, "scheduler.links.start")
                _dispatch_scheduled_scan("links")
                last_links = time.time()

            if discovery_interval > 0 and (now - last_discovery) >= discovery_interval:
                _log_event(logging.INFO, "scheduler.discovery.start")
                _dispatch_scheduled_scan("discovery")
                last_discovery = time.time()

        except Exception as e:
            _log_event(logging.ERROR, "scheduler.error", error=str(e))
