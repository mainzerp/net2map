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
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from database import (
    AppSetting, Credential, Device, Port, SessionLocal, SnmpProfile,
    ScanRun, ScanRunSwitchMetric, TopologyLink,
)
from schemas import ScanResult, ScanSwitchMetric
from shared.file_settings import _read_dns_settings, _read_scan_settings
from shared.state import SCAN_JOBS, SCAN_JOBS_LOCK, _log_event
from snmp_scanner import (
    LldpNeighbor, SwitchData, auto_layout, extract_model,
    is_virtual, scan_switch, speed_label,
)

log = logging.getLogger(__name__)


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
    cancel_event: Optional[threading.Event] = None,
    correlation_id: Optional[str] = None,
    scan_type: str = "full",
    dry_run: bool = False,
) -> ScanResult:
    corr = correlation_id or str(uuid.uuid4())

    scan_mode = scan_type if scan_type in {"discovery", "ports", "links", "macs", "full"} else "full"

    if scan_mode in {"ports", "links", "macs"}:
        # Only scan credentials that are already in the Device table and not ignored
        known_ips = {d.ip for d in db.query(Device.ip).filter(Device.ignored == False).all()}
        credentials = db.query(Credential).filter(Credential.enabled == True, Credential.ip.in_(known_ips)).all()
    else:
        credentials = db.query(Credential).filter(Credential.enabled == True).all()

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
                            "v3_auth_password": p.v3_auth_password,
                            "v3_priv_protocol": p.v3_priv_protocol,
                            "v3_priv_password": p.v3_priv_password,
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
        return result

    errors: List[str] = []
    switch_data: Dict[str, SwitchData] = {}
    ping_by_ip: Dict[str, tuple[bool, int]] = {}
    switch_metrics: List[ScanSwitchMetric] = []
    range_found_ips: List[str] = []  # IPs from ranges that responded to SNMP

    scan_targets = []

    for cred in credentials:
        p = cred.profile
        profile_key = f"profile:{p.id}" if p else f"cred:{cred.id}"

        scan_targets.append({
            "ip": cred.ip,
            "label": cred.label,
            "profile_key": profile_key,
            "snmp_port": cred.snmp_port,
            "snmp_version": p.snmp_version if p else cred.snmp_version,
            "community": p.community if p else cred.community,
            "v3_security_level": p.v3_security_level if p else cred.v3_security_level,
            "v3_username": p.v3_username if p else cred.v3_username,
            "v3_auth_protocol": p.v3_auth_protocol if p else cred.v3_auth_protocol,
            "v3_auth_password": p.v3_auth_password if p else cred.v3_auth_password,
            "v3_priv_protocol": p.v3_priv_protocol if p else cred.v3_priv_protocol,
            "v3_priv_password": p.v3_priv_password if p else cred.v3_priv_password,
            "snmp_timeout": global_snmp_timeout,
            "snmp_retries": global_snmp_retries,
            "is_range_probe": False,
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

            try:
                data = await scan_switch(
                    ip=ip,
                    snmp_version=target["snmp_version"],
                    community=target["community"],
                    snmp_port=target["snmp_port"],
                    snmp_timeout=target["snmp_timeout"],
                    snmp_retries=target["snmp_retries"],
                    v3_security_level=target["v3_security_level"],
                    v3_username=target["v3_username"],
                    v3_auth_protocol=target["v3_auth_protocol"],
                    v3_auth_password=target["v3_auth_password"],
                    v3_priv_protocol=target["v3_priv_protocol"],
                    v3_priv_password=target["v3_priv_password"],
                    scan_type=scan_mode,
                )
                duration_ms = int((time.perf_counter() - started) * 1000)
                if data:
                    return ip, label, data, "", duration_ms, ping_ok, ping_rtt, is_probe, None
                return ip, label, None, "no SNMP response", duration_ms, ping_ok, ping_rtt, is_probe, None
            except Exception as exc:
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, str(exc), duration_ms, ping_ok, ping_rtt, is_probe, None

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
    for ip, label, data, error_msg, duration_ms, ping_ok, ping_rtt, is_probe, matched_profile_id in results:
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
                device.last_seen = datetime.utcnow()
            elif ping_ok:
                device.sys_name = device.sys_name or ip
                device.sys_descr = device.sys_descr or "Discovered by ping (SNMP unavailable)"
                device.vendor = vendor or device.vendor or "generic"
                device.model = model or device.model
            device.ping_status = ping_status
            device.ping_rtt_ms = ping_rtt if ping_ok else 0
            device.last_ping = datetime.utcnow()
            if cred:
                if cred.rack_id is not None:
                    device.rack_id = cred.rack_id
                if cred.class_id is not None:
                    device.class_id = cred.class_id
        else:
            x, y = layout.get(ip, (100.0, 100.0))
            db.add(Device(
                ip=ip,
                sys_name=sw.sys_name if sw else ip,
                sys_descr=sw.sys_descr if sw else "Discovered by ping (SNMP unavailable)",
                model=model,
                vendor=vendor,
                location=sw.location if sw else "",
                ping_status=ping_status,
                ping_rtt_ms=ping_rtt if ping_ok else 0,
                last_ping=datetime.utcnow(),
                map_x=x,
                map_y=y,
                rack_id=cred.rack_id if cred else None,
                class_id=cred.class_id if cred else None,
            ))

    db.commit()

    link_count = 0
    update_ports = scan_mode in {"full", "ports", "macs"}
    update_links = scan_mode in {"full", "ports", "links"}
    if update_ports:
        dns_cache: Dict[str, str] = {}
        dns_servers = _read_dns_settings().get("servers", [])

        for ip, sw in switch_data.items():
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

            db.query(Port).filter(Port.device_id == device.id).delete()
            for iface in sw.interfaces.values():
                if is_virtual(iface.descr, sw.vendor):
                    continue

                peer_mac = ""
                peer_ip = ""
                peer_host = ""
                endpoint_entries: List[tuple[str, str, str]] = []
                if iface.index in peers_by_ifindex and peers_by_ifindex[iface.index]:
                    endpoint_entries = sorted(peers_by_ifindex[iface.index], key=lambda x: x[1])
                    peer_mac, peer_ip, peer_host = endpoint_entries[0]

                endpoint_details = [
                    {
                        "mac": mac,
                        "ip": ip_addr,
                        "host": host,
                    }
                    for mac, ip_addr, host in endpoint_entries
                ]

                db.add(Port(
                    device_id=device.id,
                    if_index=iface.index,
                    if_descr=iface.descr,
                    if_alias=iface.alias,
                    speed_mbps=iface.speed_mbps,
                    oper_status=iface.oper_status,
                    peer_mac=peer_mac,
                    peer_ip=peer_ip,
                    peer_host=peer_host,
                    endpoint_count=len(endpoint_details),
                    endpoint_details_json=json.dumps(endpoint_details),
                ))
            db.commit()

    if update_links:
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
            port_lookup[ip] = {_norm(iface.descr): iface.descr for iface in sw.interfaces.values()}
            port_suffix_lookup[ip] = {}
            for iface in sw.interfaces.values():
                sfx = _port_suffix(iface.descr)
                # Only store if the suffix is unique enough (contains /)
                if "/" in sfx:
                    port_suffix_lookup[ip][sfx] = iface.descr

        for ip, sw in switch_data.items():
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

                db.add(TopologyLink(
                    local_ip=ip,
                    local_port=nbr.local_port_desc or str(nbr.local_port_idx),
                    remote_ip=remote_ip,
                    remote_sys=nbr.remote_sys,
                    remote_port=resolved_remote_port,
                    speed_label=spd_label,
                ))
                link_count += 1
        db.commit()

    result = ScanResult(
        scanned=len(credentials),
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
    return result


# ─── Job management ───────────────────────────────────────────────────────────

def _run_scan_job(job_id: str, cancel_event: threading.Event, dry_run: bool = False):
    db = SessionLocal()
    result = None
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                _execute_scan(db, cancel_event, correlation_id=job_id, dry_run=dry_run)
            )
        finally:
            loop.close()
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

    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            return
        state["finished_at"] = datetime.utcnow().isoformat()
        state["result"] = result_dict
        state["status"] = result.status if result.status in {"finished", "cancelled", "dry_run"} else "failed"


def _start_job(dry_run: bool = False) -> dict:
    job_id = str(uuid.uuid4())
    cancel_event = threading.Event()

    with SCAN_JOBS_LOCK:
        SCAN_JOBS[job_id] = {
            "id": job_id,
            "status": "running",
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
            "result": None,
            "cancel_requested": False,
            "cancel_event": cancel_event,
            "thread": None,
        }

    t = threading.Thread(target=_run_scan_job, args=(job_id, cancel_event, dry_run), daemon=True)
    with SCAN_JOBS_LOCK:
        SCAN_JOBS[job_id]["thread"] = t
    t.start()
    _log_event(logging.INFO, "scan.job.start", correlation_id=job_id, job_id=job_id, dry_run=dry_run)

    return {"job_id": job_id, "status": "running"}


# ─── Background scheduler ─────────────────────────────────────────────────────

def _background_scheduler():
    """Runs discovery, link and MAC scans periodically based on app settings."""
    last_discovery = 0
    last_links = 0
    last_macs = 0

    while True:
        time.sleep(5)

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

            # Run discovery scan – fresh session per scan
            if discovery_interval > 0 and (now - last_discovery) >= discovery_interval:
                _log_event(logging.INFO, "scheduler.discovery.start")
                db = SessionLocal()
                loop = asyncio.new_event_loop()
                try:
                    loop.run_until_complete(_execute_scan(db, scan_type="discovery"))
                except Exception as e:
                    _log_event(logging.ERROR, "scheduler.discovery.error", error=str(e))
                finally:
                    db.close()
                    loop.close()
                    last_discovery = time.time()

            # Run link/neighbor scan – fresh session per scan
            if links_interval > 0 and (now - last_links) >= links_interval:
                _log_event(logging.INFO, "scheduler.links.start")
                db = SessionLocal()
                loop = asyncio.new_event_loop()
                try:
                    loop.run_until_complete(_execute_scan(db, scan_type="links"))
                except Exception as e:
                    _log_event(logging.ERROR, "scheduler.links.error", error=str(e))
                finally:
                    db.close()
                    loop.close()
                    last_links = time.time()

            # Run MAC-at-port scan – fresh session per scan
            if macs_interval > 0 and (now - last_macs) >= macs_interval:
                _log_event(logging.INFO, "scheduler.macs.start")
                db = SessionLocal()
                loop = asyncio.new_event_loop()
                try:
                    loop.run_until_complete(_execute_scan(db, scan_type="macs"))
                except Exception as e:
                    _log_event(logging.ERROR, "scheduler.macs.error", error=str(e))
                finally:
                    db.close()
                    loop.close()
                    last_macs = time.time()

        except Exception as e:
            _log_event(logging.ERROR, "scheduler.error", error=str(e))
