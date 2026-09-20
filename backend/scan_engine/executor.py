"""Core scan execution engine -- the async _execute_scan function."""
import asyncio
import logging
import re
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from database import (
    Credential,
    Device,
    DryRunResult,
    Endpoint,
    EndpointPortAssociation,
    Port,
    SnmpProfile,
    TopologyLink,
)
from scan_engine.broadcast import _broadcast_progress, _broadcast_scan_complete
from scan_engine.db_helpers import (
    _canonical_link_key,
    _expand_ranges_to_ips,
    _persist_scan_run,
    _read_discovery_ranges,
)
from scan_engine.dns import _resolve_host, _resolve_ip
from scan_engine.ping import _build_ping_cmd
from schemas import ScanResult, ScanSwitchMetric
from shared.crypto import decrypt
from shared.file_settings import _read_dns_settings, _read_scan_settings
from shared.metrics import DEVICE_COUNT, ENDPOINT_COUNT, PORT_COUNT, SCAN_ACTIVE, SCAN_DURATION, SCAN_TOTAL
from shared.state import _log_event, renew_scan_lock
from snmp_scanner import (
    SwitchData,
    auto_layout,
    extract_model,
    is_virtual,
    scan_switch,
    speed_label,
)

log = logging.getLogger(__name__)

# Interval between distributed-lock renewals during a scan. The lock TTL
# (shared.state._SCAN_LOCK_TTL) is a crash-recovery safety net and can be
# shorter than the scan duration, so long scans must renew periodically.
_LOCK_RENEW_INTERVAL_SEC = 120

# Dry-run preview is intentionally not part of the serialized ScanResult
# schema; it travels alongside the result object via these helpers and is
# materialized into the job result dict by the job runners (jobs.py/tasks.py).
_DRY_RUN_PREVIEW_ATTR = "_dry_run_preview"


def attach_dry_run_preview(result: ScanResult, preview: list) -> None:
    """Attach a dry-run preview list to a ScanResult (not serialized)."""
    result.__dict__[_DRY_RUN_PREVIEW_ATTR] = preview


def get_dry_run_preview(result: ScanResult) -> list:
    """Return the dry-run preview attached to a ScanResult, or []."""
    return result.__dict__.get(_DRY_RUN_PREVIEW_ATTR, [])


async def _execute_scan(
    db: Session,
    cancel_event=None,
    correlation_id: Optional[str] = None,
    scan_type: str = "full",
    dry_run: bool = False,
    lock_token: Optional[str] = None,
) -> ScanResult:
    corr = correlation_id or str(uuid.uuid4())
    scan_mode = scan_type if scan_type in {"discovery", "ports", "links", "macs", "full"} else "full"

    scan_started = time.perf_counter()
    final_status = "failed"
    SCAN_ACTIVE.inc()
    try:
        result = await _execute_scan_body(db, cancel_event, corr, scan_mode, dry_run, lock_token, scan_started)
        final_status = result.status
        return result
    finally:
        # Metrics live in finally so exceptions (e.g. from asyncio.gather)
        # can never leak the SCAN_ACTIVE gauge or skip SCAN_TOTAL/SCAN_DURATION.
        duration_ms = int((time.perf_counter() - scan_started) * 1000)
        SCAN_ACTIVE.dec()
        SCAN_DURATION.labels(scan_type=scan_mode).observe(duration_ms / 1000)
        SCAN_TOTAL.labels(scan_type=scan_mode, status=final_status).inc()


async def _execute_scan_body(
    db: Session,
    cancel_event,
    corr: str,
    scan_mode: str,
    dry_run: bool,
    lock_token: Optional[str],
    scan_started: float,
) -> ScanResult:
    if scan_mode in {"ports", "links", "macs"}:
        # Only scan credentials that are already in the Device table and not ignored
        known_ips = {d.ip for d in db.query(Device.ip).filter(Device.ignored.is_(False)).all()}
        credentials = db.query(Credential).filter(
            Credential.enabled.is_(True), Credential.ip.in_(known_ips)
        ).order_by(Credential.ip, Credential.priority).all()
    else:
        credentials = db.query(Credential).filter(
            Credential.enabled.is_(True)
        ).order_by(Credential.ip, Credential.priority).all()

    # Group credentials by IP for fallback chain support
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

    workers = max(1, min(int(configured_max_workers), max(len(scan_targets), 1)))
    sem = asyncio.Semaphore(workers)

    results = await asyncio.gather(
        *[_scan_target_async(t, sem) for t in scan_targets],
        return_exceptions=False,
    )
    total_targets = len(scan_targets)
    scanned_count = 0
    last_lock_renew = time.time()
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

        # Renew the distributed scan lock periodically (TTL is shorter than
        # long-running scans; renewal is ownership-checked and cheap).
        if lock_token and (time.time() - last_lock_renew) > _LOCK_RENEW_INTERVAL_SEC:
            renew_scan_lock(lock_token)
            last_lock_renew = time.time()

    total_duration_ms = int((time.perf_counter() - scan_started) * 1000)
    switch_metrics.sort(key=lambda m: m.duration_ms, reverse=True)
    status = "cancelled" if (cancel_event and cancel_event.is_set()) else "finished"

    if lock_token:
        renew_scan_lock(lock_token)

    # The synchronous SQLAlchemy rebuild phase runs in a worker thread so the
    # shared background event loop stays responsive for WebSocket broadcasts
    # and other coroutines while ports/links/endpoints are rewritten.
    result, dry_run_preview = await asyncio.to_thread(
        _finalize_scan_db,
        db,
        dry_run=dry_run,
        scan_mode=scan_mode,
        corr=corr,
        cancel_event=cancel_event,
        switch_data=switch_data,
        ping_by_ip=ping_by_ip,
        range_found_ips=range_found_ips,
        range_matched_profile=range_matched_profile,
        range_no_profile_ips=range_no_profile_ips,
        errors=errors,
        status=status,
        total_duration_ms=total_duration_ms,
        scanned=len(scan_targets),
        workers=workers,
        switch_metrics=switch_metrics,
        lock_token=lock_token,
    )

    if dry_run:
        attach_dry_run_preview(result, dry_run_preview)
        return result

    _broadcast_scan_complete(corr, result.status, result.found, result.links, result.total_duration_ms)

    # Bump topology version so clients refetch updated data
    from routers.topology import _bump_topo_version
    _bump_topo_version()

    return result


def _finalize_scan_db(
    db: Session,
    *,
    dry_run: bool,
    scan_mode: str,
    corr: str,
    cancel_event,
    switch_data: Dict[str, SwitchData],
    ping_by_ip: Dict[str, tuple],
    range_found_ips: List[str],
    range_matched_profile: Dict[str, Optional[int]],
    range_no_profile_ips: List[str],
    errors: List[str],
    status: str,
    total_duration_ms: int,
    scanned: int,
    workers: int,
    switch_metrics: List[ScanSwitchMetric],
    lock_token: Optional[str],
) -> tuple:
    """Synchronous DB rebuild phase -- runs in a worker thread via
    asyncio.to_thread (see _execute_scan_body).

    Returns ``(result, dry_run_preview)``.

    Cancellation note: port data is committed per device to keep transactions
    bounded. When a scan is cancelled mid-rebuild, devices already committed
    keep their new rows -- status "cancelled" may therefore include partially
    updated port/endpoint data. This is surfaced in result.errors.
    """
    # ── Dry run: build the preview and persist it for later retrieval ────────
    if dry_run:
        dry_run_preview = []
        existing_cred_ips = set()
        if range_found_ips:
            existing_cred_ips = {
                row[0] for row in db.query(Credential.ip).filter(Credential.ip.in_(range_found_ips)).all()
            }
        for ip in range_found_ips:
            sw = switch_data.get(ip)
            prof_id = range_matched_profile.get(ip)
            dry_run_preview.append({
                "ip": ip,
                "sys_name": sw.sys_name if sw else "",
                "sys_descr": sw.sys_descr if sw else "",
                "vendor": sw.vendor if sw else "generic",
                "location": sw.location if sw else "",
                "matched_profile_id": prof_id,
                "already_exists": ip in existing_cred_ips,
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
            scanned=scanned,
            found=len(range_found_ips),
            links=0,
            errors=errors,
            max_workers=workers,
            total_duration_ms=total_duration_ms,
            switch_metrics=switch_metrics,
            status="dry_run",
        )

        # Persist dry-run result to database
        run_id = _persist_scan_run(db, result, [], [])
        dry_run_record = DryRunResult(
            scan_run_id=run_id,
            preview_json=dry_run_preview,
        )
        db.add(dry_run_record)
        db.commit()
        result.run_id = run_id
        return result, dry_run_preview

    if lock_token:
        renew_scan_lock(lock_token)

    # ── Auto-create credentials for IPs discovered via range probes ──────────
    if range_found_ips:
        existing_cred_ips = {
            row[0] for row in db.query(Credential.ip).filter(Credential.ip.in_(range_found_ips)).all()
        }
        profile_ids = {pid for pid in range_matched_profile.values() if pid}
        profiles_by_id = {}
        if profile_ids:
            profiles_by_id = {
                p.id: p for p in db.query(SnmpProfile).filter(SnmpProfile.id.in_(profile_ids)).all()
            }
        for found_ip in range_found_ips:
            if found_ip in existing_cred_ips:
                continue
            sw = switch_data.get(found_ip)
            cred_label = sw.sys_name if (sw and sw.sys_name) else found_ip
            matched_prof = profiles_by_id.get(range_matched_profile.get(found_ip))
            new_cred = Credential(
                label=cred_label,
                ip=found_ip,
                snmp_port=161,
                enabled=True,
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

    # ── Device upsert ─────────────────────────────────────────────────────────
    discovered_ips = set(switch_data.keys()) | {ip for ip, (ok, _) in ping_by_ip.items() if ok}
    devices_by_ip: Dict[str, Device] = {}
    if discovered_ips:
        devices_by_ip = {d.ip: d for d in db.query(Device).filter(Device.ip.in_(list(discovered_ips))).all()}
    existing_ips = {row[0] for row in db.query(Device.ip).all()}
    new_ips = [ip for ip in discovered_ips if ip not in existing_ips]
    all_ips_ordered = list(existing_ips) + new_ips
    layout = auto_layout(all_ips_ordered)
    # Reload credentials to include any auto-created entries from range probes
    cred_by_ip = {}
    if discovered_ips:
        cred_by_ip = {c.ip: c for c in db.query(Credential).filter(Credential.ip.in_(list(discovered_ips))).all()}

    # Manual vendor overrides (devices whose vendor_override flag is set)
    vendor_overrides: Dict[str, str] = {}

    for ip in discovered_ips:
        sw = switch_data.get(ip)
        ping_ok, ping_rtt = ping_by_ip.get(ip, (False, 0))
        ping_status = "online" if ping_ok else "offline"
        cred = cred_by_ip.get(ip)

        # Determine vendor and model from scan data (overrides now live on Device)
        vendor = (sw.vendor if sw else "generic")
        model = (extract_model(sw.sys_descr, sw.vendor) if sw else "")

        device = devices_by_ip.get(ip)
        if device:
            if sw:
                detected_vendor = vendor or "generic"
                if device.vendor_override and device.vendor:
                    # The vendor was set manually via the topology API
                    # (vendor_override flag): keep it and use it for port
                    # filtering in this scan.
                    vendor_overrides[ip] = device.vendor
                    _log_event(
                        logging.INFO,
                        "scan.vendor_override",
                        correlation_id=corr,
                        ip=ip,
                        detected=detected_vendor,
                        override=device.vendor,
                    )
                else:
                    device.vendor = detected_vendor or device.vendor
                device.sys_name  = sw.sys_name  or device.sys_name
                device.sys_descr = sw.sys_descr or device.sys_descr
                device.location  = sw.location  or device.location
                device.model     = model        or device.model
                device.last_seen = datetime.now(timezone.utc)
            elif ping_ok:
                device.sys_name = device.sys_name or ip
                device.sys_descr = device.sys_descr or "Discovered by ping (SNMP unavailable)"
                # Never clobber an existing vendor with the "generic" fallback
                # of a ping-only observation (would erase manual overrides).
                device.vendor = device.vendor or vendor or "generic"
                device.model = model or device.model
            device.ping_status = ping_status
            device.ping_rtt_ms = ping_rtt if ping_ok else 0
            device.last_ping = datetime.now(timezone.utc)
            if cred:
                if not device.label and cred.label:
                    device.label = cred.label
                if not cred.device_id:
                    cred.device_id = device.id
        else:
            # Only create Device rows for SNMP-discovered hosts (sw is not None)
            # Ping-only discoveries are tracked as endpoints via FDB/ARP data
            if sw is None:
                continue
            x, y = layout.get(ip, (100.0, 100.0))
            new_device = Device(
                ip=ip,
                sys_name=sw.sys_name if sw else ip,
                sys_descr=sw.sys_descr if sw else "",
                model=model,
                vendor=vendor,
                location=sw.location if sw else "",
                ping_status=ping_status,
                ping_rtt_ms=ping_rtt if ping_ok else 0,
                last_ping=datetime.now(timezone.utc),
                map_x=x,
                map_y=y,
                label=cred.label if cred else "",
                enabled=True,
            )
            db.add(new_device)
            db.flush()
            devices_by_ip[ip] = new_device
            if cred and not cred.device_id:
                cred.device_id = new_device.id

    db.commit()

    # ── Port / endpoint rebuild ───────────────────────────────────────────────
    link_count = 0
    ports_committed = False
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

                # Bulk preload endpoints for all MACs seen in this scan to
                # avoid a per-MAC SELECT (N+1) during endpoint upserts.
                all_macs: set = set()
                for sw_data in switch_data.values():
                    all_macs.update(sw_data.arp_table.keys())
                    all_macs.update(sw_data.mac_ifindex.keys())
                endpoints_by_mac: Dict[str, Endpoint] = {}
                if all_macs:
                    endpoints_by_mac = {
                        e.mac: e for e in db.query(Endpoint).filter(Endpoint.mac.in_(list(all_macs))).all()
                    }

                for ip, sw in switch_data.items():
                    if cancel_event and cancel_event.is_set():
                        db.rollback()
                        status = "cancelled"
                        break
                    if lock_token:
                        renew_scan_lock(lock_token)

                    device = devices_by_ip.get(ip)
                    if not device:
                        continue
                    if device.ignored:
                        continue

                    # A manually overridden vendor (DB) wins over the
                    # auto-detected one for port filtering decisions.
                    effective_vendor = vendor_overrides.get(ip, sw.vendor)

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

                    # Build port objects. Virtual interfaces (loopbacks, VLAN
                    # SVIs, LAGs) are skipped UNLESS they carry FDB/endpoint
                    # entries -- dropping those would silently lose all
                    # endpoints learned on e.g. a LAG ifIndex.
                    ports_with_endpoints: List[tuple] = []
                    for iface in sw.interfaces.values():
                        endpoint_entries: List[tuple[str, str, str]] = []
                        if iface.index in peers_by_ifindex and peers_by_ifindex[iface.index]:
                            endpoint_entries = sorted(
                                peers_by_ifindex[iface.index],
                                key=lambda x: (x[1] == "", x[1], x[0])
                            )
                        if is_virtual(iface.descr, effective_vendor) and not endpoint_entries:
                            continue
                        port_obj = Port(
                            device_id=device.id,
                            if_index=iface.index,
                            if_descr=iface.descr,
                            if_alias=iface.alias,
                            speed_mbps=iface.speed_mbps,
                            oper_status=iface.oper_status,
                            vlan=iface.vlan,
                            tagged_vlans=iface.tagged_vlans,
                        )
                        ports_with_endpoints.append((port_obj, iface, endpoint_entries))

                    if ports_with_endpoints:
                        # One flush per device assigns all port ids (batched
                        # instead of a flush per row).
                        db.add_all([p for p, _, _ in ports_with_endpoints])
                        db.flush()

                        now = datetime.now(timezone.utc)
                        new_endpoints: List[Endpoint] = []
                        endpoint_assoc_plan: List[tuple] = []  # (endpoint, port_obj, vlan)
                        for port_obj, iface, ep_entries in ports_with_endpoints:
                            for mac, ep_ip, ep_host in ep_entries:
                                if not mac:
                                    continue
                                endpoint = endpoints_by_mac.get(mac)
                                if endpoint is not None:
                                    if ep_ip:
                                        endpoint.ip = ep_ip
                                    if ep_host:
                                        endpoint.hostname = ep_host
                                    endpoint.last_seen = now
                                else:
                                    endpoint = Endpoint(
                                        mac=mac,
                                        ip=ep_ip or None,
                                        hostname=ep_host or None,
                                    )
                                    endpoints_by_mac[mac] = endpoint
                                    new_endpoints.append(endpoint)
                                endpoint_assoc_plan.append((endpoint, port_obj, iface.vlan))

                        if new_endpoints:
                            db.add_all(new_endpoints)
                            db.flush()

                        # Ports are freshly inserted, so no association for
                        # them can exist yet; guard only against duplicates
                        # within this scan (uq_epa_endpoint_port).
                        seen_assocs = set()
                        new_assocs: List[EndpointPortAssociation] = []
                        for endpoint, port_obj, vlan in endpoint_assoc_plan:
                            key = (endpoint.id, port_obj.id)
                            if key in seen_assocs:
                                continue
                            seen_assocs.add(key)
                            new_assocs.append(EndpointPortAssociation(
                                endpoint_id=endpoint.id,
                                port_id=port_obj.id,
                                vlan_id=vlan if vlan else None,
                            ))
                        if new_assocs:
                            db.add_all(new_assocs)
                    db.commit()
                    ports_committed = True
            except Exception:
                db.rollback()
                log.exception("Error during port update, rolled back")
                errors.append("Port update failed (rolled back)")

    # ── Topology link rebuild ─────────────────────────────────────────────────
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

                links_cancelled = False
                for ip, sw in switch_data.items():
                    if cancel_event and cancel_event.is_set():
                        db.rollback()
                        status = "cancelled"
                        links_cancelled = True
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
                if not links_cancelled:
                    db.commit()
            except Exception:
                db.rollback()
                log.exception("Error during link update, rolled back")
                errors.append("Link update failed (rolled back)")

    if status == "cancelled" and ports_committed:
        # See docstring: cancellation can leave already-committed devices with
        # updated port/endpoint rows. Make that visible instead of implying
        # the database is untouched.
        errors.append("Scan cancelled after partial port data was committed; some devices have updated ports/endpoints")
        _log_event(logging.WARNING, "scan.cancelled_partial", correlation_id=corr)

    result = ScanResult(
        scanned=scanned,
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

    # Update Prometheus gauges from the final DB state
    DEVICE_COUNT.set(db.query(Device).count())
    PORT_COUNT.labels(status="up").set(db.query(Port).filter(Port.oper_status == 1).count())
    PORT_COUNT.labels(status="down").set(db.query(Port).filter(Port.oper_status == 2).count())
    ENDPOINT_COUNT.set(db.query(Endpoint).count())

    return result, []
