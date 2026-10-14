"""Core scan execution engine -- the async _execute_scan function."""
import asyncio
import contextlib
import functools
import logging
import re
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from sqlalchemy import event
from sqlalchemy.orm import Session

from database import (
    AuditLog,
    Credential,
    Device,
    DryRunResult,
    Endpoint,
    EndpointPortAssociation,
    PingCandidate,
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
from scanners.health import health_firmware, health_model
from schemas import ScanResult, ScanSwitchMetric
from shared.crypto import decrypt
from shared.fencing import apply_fence
from shared.file_settings import _read_db_setting, _read_dns_settings, _read_scan_settings
from shared.metrics import (
    DEVICE_COUNT,
    ENDPOINT_COUNT,
    PORT_COUNT,
    SCAN_ACTIVE,
    SCAN_DURATION,
    SCAN_TOTAL,
    STALE_LEASE_REJECTIONS,
)
from shared.ping_only import upsert_ping_only_device as _upsert_ping_only_device
from shared.state import SCAN_LOCK_FENCE_NAME, _log_event, fence_token_of, renew_scan_lock
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


class ScanOwnershipLost(RuntimeError):
    """The scan must stop after losing its distributed lease."""


class StaleLeaseError(ScanOwnershipLost):
    """The database rejected a transaction whose lease fencing token is stale."""


class ScanFinalizationAborted(RuntimeError):
    """An externally cancelled coroutine must stop its worker transaction."""


class _ScanLease:
    def __init__(self, token):
        self.token = token
        self.fence = fence_token_of(token)
        self.lost = threading.Event()
        self.aborted = threading.Event()

    def fence_transaction(self, connection, corr: Optional[str] = None):
        """Write this lease's fencing token in the current DB transaction.

        Authoritative guard: the Redis checks are only an early exit, the
        database rejects the transaction when a newer lease holder wrote.
        """
        if self.fence is None:
            return
        if apply_fence(connection, SCAN_LOCK_FENCE_NAME, self.fence):
            return
        self.lost.set()
        STALE_LEASE_REJECTIONS.labels(lease=SCAN_LOCK_FENCE_NAME).inc()
        _log_event(
            logging.WARNING,
            "scan.lease.stale_token_rejected",
            correlation_id=corr,
            lease=SCAN_LOCK_FENCE_NAME,
            fence_token=self.fence,
        )
        raise StaleLeaseError("Scan lease fencing token %d is stale" % self.fence)

    def check(self):
        if self.lost.is_set():
            raise ScanOwnershipLost("Scan lock ownership was lost")
        if self.aborted.is_set():
            raise ScanFinalizationAborted("Scan finalization was cancelled")
        if self.token and not renew_scan_lock(self.token):
            self.lost.set()
            raise ScanOwnershipLost("Scan lock ownership was lost")


def _guard_scan_transactions(finalize):
    """Require the current lease at each commit, including nested persistence helpers."""
    @functools.wraps(finalize)
    def guarded(db, **kwargs):
        lease = kwargs.get("lease") or _ScanLease(kwargs.get("lock_token"))
        kwargs["lease"] = lease
        corr = kwargs.get("corr")
        # Root transaction that already carries this lease's fencing token.
        fenced = {"tx": None}

        def ensure_fenced(session):
            if lease.fence is None:
                return
            # Acquiring the connection may begin the transaction and fence it
            # via after_begin; only fence explicitly when that did not happen.
            connection = session.connection()
            if session.get_transaction() is not fenced["tx"]:
                lease.fence_transaction(connection, corr)
                fenced["tx"] = session.get_transaction()

        def after_begin(session, transaction, connection):
            # Fence first, so on PostgreSQL the fence row lock is held for
            # the whole transaction and concurrent lease holders serialize.
            if lease.fence is None or transaction.nested:
                return
            lease.fence_transaction(connection, corr)
            fenced["tx"] = session.get_transaction()

        def before_commit(session):
            lease.check()
            ensure_fenced(session)

        def after_flush(session, flush_context):
            # A large flush can outlive the lease checked by before_commit.
            lease.check()

        event.listen(db, "after_begin", after_begin)
        event.listen(db, "before_commit", before_commit)
        event.listen(db, "after_flush_postexec", after_flush)
        try:
            lease.check()
            if db.in_transaction():
                # A transaction opened before the guard (scan body reads) is
                # fenced now, before any guarded write joins it.
                ensure_fenced(db)
            return finalize(db, **kwargs)
        except BaseException:
            db.rollback()
            raise
        finally:
            event.remove(db, "after_begin", after_begin)
            event.remove(db, "before_commit", before_commit)
            event.remove(db, "after_flush_postexec", after_flush)

    return guarded


async def _drain_scan_task(task):
    """Wait through repeated cancellation until owned background work has stopped."""
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except Exception:
            break
    with contextlib.suppress(asyncio.CancelledError, Exception):
        task.result()


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
    lease = _ScanLease(lock_token)
    body_task = None

    async def renew_lock():
        while True:
            await asyncio.sleep(_LOCK_RENEW_INTERVAL_SEC)
            lease.check()

    # Renew independently of target completion, including a single slow SNMP walk.
    renew_task = asyncio.create_task(renew_lock()) if lock_token else None
    try:
        lease.check()
        body_task = asyncio.create_task(
            _execute_scan_body(db, cancel_event, corr, scan_mode, dry_run, lock_token, scan_started, lease)
        )
        if renew_task is not None:
            await asyncio.wait({body_task, renew_task}, return_when=asyncio.FIRST_COMPLETED)
            if renew_task.done():
                renew_task.result()
        result = await asyncio.shield(body_task)
        final_status = result.status
        return result
    finally:
        if body_task is not None:
            if not body_task.done():
                lease.aborted.set()
                body_task.cancel()
            await _drain_scan_task(body_task)
        if renew_task is not None:
            renew_task.cancel()
            await _drain_scan_task(renew_task)
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
    lease: _ScanLease,
) -> ScanResult:
    ignored_ips = {d.ip for d in db.query(Device.ip).filter(Device.ignored.is_(True)).all()}
    if scan_mode in {"ports", "links", "macs"}:
        # Only scan credentials that are already in the Device table and not ignored
        known_ips = {d.ip for d in db.query(Device.ip).filter(Device.ignored.is_(False)).all()}
        credentials = db.query(Credential).filter(
            Credential.enabled.is_(True), Credential.ip.in_(known_ips)
        ).order_by(Credential.ip, Credential.priority).all()
        # Ping-only hosts are always pinged (cheap) so a newly registered one
        # gets its Device row with the next scan of any type.
        known_cred_ids = {c.id for c in credentials}
        credentials += [
            c for c in db.query(Credential).filter(
                Credential.enabled.is_(True), Credential.snmp_enabled.is_(False),
                Credential.ip.notin_(ignored_ips),
            ).order_by(Credential.ip, Credential.priority).all()
            if c.id not in known_cred_ids
        ]
    else:
        credentials = db.query(Credential).filter(
            Credential.enabled.is_(True), Credential.ip.notin_(ignored_ips)
        ).order_by(Credential.ip, Credential.priority).all()

    # Group credentials by IP for fallback chain support. Credentials with
    # snmp_enabled=False never take part in SNMP; an IP whose enabled
    # credentials are all SNMP-disabled becomes a ping-only target.
    creds_by_ip: Dict[str, List] = defaultdict(list)
    ping_only_creds: Dict[str, Credential] = {}
    for c in credentials:
        if c.snmp_enabled is False:
            ping_only_creds.setdefault(c.ip, c)
        else:
            creds_by_ip[c.ip].append(c)
    ping_only_targets: Dict[str, dict] = {
        ip: {"credential_id": c.id, "label": c.label or ""}
        for ip, c in ping_only_creds.items() if ip not in creds_by_ip
    }

    scan_settings = _read_scan_settings()
    configured_max_workers = scan_settings.get("max_workers", 4)
    global_snmp_timeout = scan_settings.get("snmp_timeout", 3)
    global_snmp_retries = scan_settings.get("snmp_retries", 1)
    bulk_size = scan_settings.get("snmp_bulk_size", 25)
    if_names_by_ip = _load_if_name_cache(db) if scan_mode in {"links", "macs"} else {}
    vlan_stp_plan = _plan_vlan_stp_collection(db, scan_mode)

    # ── Range-based discovery (only for discovery/full scans) ──────────────────
    range_targets: List[dict] = []
    if scan_mode in {"discovery", "full"}:
        configured_ranges = _read_discovery_ranges(db)
        if configured_ranges:
            range_ips = _expand_ranges_to_ips(configured_ranges)
            cred_ips = {c.ip for c in credentials}
            # Load all profiles to try for each range IP
            all_profiles = db.query(SnmpProfile).order_by(SnmpProfile.id).all()
            # Decrypt once per scan; the list is shared read-only by all range targets.
            if all_profiles:
                profiles_data = [
                    {
                        "profile_id": p.id,
                        "profile_label": p.label,
                        "snmp_version": p.snmp_version,
                        "community": decrypt(p.community),
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
            for ip in range_ips:
                if ip in cred_ips or ip in ignored_ips:
                    continue  # already covered by existing credential
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
    # IP -> id of the credential (primary or fallback) whose scan succeeded
    working_cred_by_ip: Dict[str, int] = {}

    scan_targets = []

    def _cred_to_snmp_dict(cred):
        p = cred.profile
        return {
            "credential_id": cred.id,
            # Engine IDs are per device, so the override always comes from the
            # credential itself, even when a shared profile supplies the secrets.
            "v3_engine_id": cred.v3_engine_id or "",
            "snmp_port": cred.snmp_port,
            "snmp_version": p.snmp_version if p else cred.snmp_version,
            "community": decrypt(p.community if p else cred.community),
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

    for ip, info in ping_only_targets.items():
        scan_targets.append({
            "ip": ip,
            "label": info["label"] or ip,
            "is_range_probe": False,
            "ping_only": True,
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
                await proc.wait()
                return False, 0
            except asyncio.CancelledError:
                if proc.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()
                await proc.wait()
                raise
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
            if cancel_event and cancel_event.is_set():
                return ip, label, None, "cancelled", 0, False, 0, is_probe, None
            ping_ok, ping_rtt = await _ping_host_async(ip)

            # Ping-only hosts (credential snmp_enabled=False): never try SNMP
            if target.get("ping_only"):
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, "", duration_ms, ping_ok, ping_rtt, is_probe, None

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
                    if cancel_event and cancel_event.is_set():
                        break
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
                if cancel_event and cancel_event.is_set():
                    break
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
                        v3_engine_id=cred_set.get("v3_engine_id", ""),
                        bulk_size=bulk_size,
                        if_names=if_names_by_ip.get(ip),
                        collect_vlan=vlan_stp_plan.get(ip, (True, True))[0],
                        collect_stp=vlan_stp_plan.get(ip, (True, True))[1],
                    )
                    if data:
                        if cred_set is not target:
                            log.info("Credential fallback succeeded for %s", ip)
                        if cred_set.get("credential_id") is not None:
                            working_cred_by_ip[ip] = cred_set["credential_id"]
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

    total_targets = len(scan_targets)
    scanned_count = 0
    # Keep explicit task ownership so parent exceptions cannot leave targets running.
    target_tasks = [asyncio.create_task(_scan_target_async(t, sem)) for t in scan_targets]
    try:
        for completed in asyncio.as_completed(target_tasks):
            ip, label, data, error_msg, duration_ms, ping_ok, ping_rtt, is_probe, matched_profile_id = await completed
            scanned_count += 1
            ping_by_ip[ip] = (ping_ok, ping_rtt)
            if ip in ping_only_targets and not is_probe:
                _log_event(
                    logging.INFO if ping_ok else logging.DEBUG,
                    "scan.switch.result",
                    correlation_id=corr,
                    ip=ip,
                    label=label,
                    success=ping_ok,
                    ping_ok=ping_ok,
                    ping_rtt_ms=ping_rtt,
                    duration_ms=duration_ms,
                    ping_only=True,
                )
                switch_metrics.append(ScanSwitchMetric(
                    ip=ip, label=label, duration_ms=duration_ms,
                    success=ping_ok, error="" if ping_ok else "no ping reply (ping-only)",
                ))
            elif data:
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

    finally:
        for task in target_tasks:
            if not task.done():
                task.cancel()
        await _drain_scan_task(asyncio.ensure_future(asyncio.gather(*target_tasks, return_exceptions=True)))

    total_duration_ms = int((time.perf_counter() - scan_started) * 1000)
    switch_metrics.sort(key=lambda m: m.duration_ms, reverse=True)
    status = "cancelled" if (cancel_event and cancel_event.is_set()) else "finished"

    lease.check()

    # The synchronous SQLAlchemy rebuild phase runs in a worker thread so the
    # shared background event loop stays responsive for WebSocket broadcasts
    # and other coroutines while ports/links/endpoints are rewritten.
    finalization_task = asyncio.create_task(asyncio.to_thread(
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
        lease=lease,
        working_cred_by_ip=working_cred_by_ip,
        ping_only_targets=ping_only_targets,
    ))
    try:
        result, dry_run_preview = await asyncio.shield(finalization_task)
    except asyncio.CancelledError:
        lease.aborted.set()
        # to_thread cannot stop a running thread. Drain it before the caller closes
        # the Session or releases the scan lock; commit guards reject further writes.
        await _drain_scan_task(finalization_task)
        raise

    lease.check()
    if dry_run:
        attach_dry_run_preview(result, dry_run_preview)
        return result

    _broadcast_scan_complete(corr, result.status, result.found, result.links, result.total_duration_ms)

    # Bump topology version so clients refetch updated data
    from routers.topology import _bump_topo_version
    _bump_topo_version()

    return result


def _record_engine_id(db: Session, cred: Credential, engine_id: str, corr: str) -> None:
    """Store the observed SNMP engine ID on the credential that worked.

    Engine IDs are stored for any SNMP version when the agent exposes
    snmpEngineID.0 (useful for change detection even with v2c). A change
    against a previously stored value is logged as a warning and written to
    the audit log as a system event. The caller commits (lease-guarded).
    """
    engine_id = (engine_id or "").lower()
    if not engine_id:
        return
    old = cred.discovered_engine_id
    if old and old != engine_id:
        log.warning(
            "SNMP engine ID changed for %s: %s -> %s; device may have been replaced or reset",
            cred.ip, old, engine_id,
        )
        _log_event(
            logging.WARNING,
            "scan.engine_id_changed",
            correlation_id=corr,
            ip=cred.ip,
            credential_id=cred.id,
            old=old,
            new=engine_id,
        )
        db.add(AuditLog(
            user_id=None,
            username="system",
            action="engine_id_changed",
            resource="credential",
            resource_id=str(cred.id) if cred.id is not None else "",
            details={"ip": cred.ip, "old": old, "new": engine_id, "correlation_id": corr},
        ))
    cred.discovered_engine_id = engine_id
    cred.engine_id_seen_at = datetime.now(timezone.utc)


IF_NAME_CACHE_DEFAULT_MAX_AGE = 1800  # seconds; used when discovery is disabled


def _load_if_name_cache(db: Session) -> Dict[str, Dict[int, tuple]]:
    """Return fresh interface name caches as {ip: {ifIndex: (descr, alias)}}.

    A cache is fresh for one discovery interval, so names and aliases are
    re-walked at most that often (or immediately when an unknown ifIndex
    appears, see snmp_scanner.scan_switch).
    """
    try:
        max_age = int(_read_db_setting("discovery_interval_sec", str(IF_NAME_CACHE_DEFAULT_MAX_AGE)))
    except (TypeError, ValueError):
        max_age = IF_NAME_CACHE_DEFAULT_MAX_AGE
    if max_age <= 0:
        max_age = IF_NAME_CACHE_DEFAULT_MAX_AGE
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=max_age)
    caches: Dict[str, Dict[int, tuple]] = {}
    rows = db.query(Device.ip, Device.if_names, Device.if_names_at).filter(
        Device.ignored.is_(False), Device.if_names_at.isnot(None),
    ).all()
    for ip, names, stamp in rows:
        if not isinstance(names, dict) or not names:
            continue
        if (stamp.replace(tzinfo=None) if stamp.tzinfo else stamp) < cutoff:
            continue
        try:
            caches[ip] = {int(k): (str(v[0]), str(v[1])) for k, v in names.items()}
        except (TypeError, ValueError, IndexError):
            continue
    return caches


def _apply_if_name_cache(device: Device, sw) -> None:
    """Store freshly walked interface names as the device's name cache."""
    if not getattr(sw, "if_names_refreshed", False):
        return
    device.if_names = {str(i): [iface.descr, iface.alias] for i, iface in sw.interfaces.items()}
    device.if_names_at = datetime.now(timezone.utc).replace(tzinfo=None)


def _resolve_device_type(current: Optional[str], detected: str, vendor: str, vendor_override: bool) -> str:
    """Decide the stored device type after a scan.

    A detection is "confident" when a specific vendor scanner matched or a
    generic device answered the UPS-MIB probe (anything but generic/switch).
    - vendor_override set: keep the stored type; only a still-default
      "switch" is upgraded by a confident detection.
    - otherwise a confident detection wins; the generic "switch" fallback
      keeps the stored type so a manual correction (meta PATCH) survives.
    """
    current = current or "switch"
    detected = detected or "switch"
    confident = not (vendor == "generic" and detected == "switch")
    if vendor_override:
        return detected if current == "switch" and confident else current
    return detected if confident else current


def _apply_health(device: Device, sw) -> None:
    """Store a freshly collected health snapshot.

    A scan without a snapshot (collection failed or not attempted) keeps the
    previous one; its timestamp shows how stale it is.
    """
    health = getattr(sw, "health", None)
    if not isinstance(health, dict):
        return
    device.health = health
    device.health_updated_at = datetime.now(timezone.utc).replace(tzinfo=None)


def _read_interval_setting(key: str, default: int) -> int:
    try:
        return int(_read_db_setting(key, str(default)))
    except (TypeError, ValueError):
        return default


def _plan_vlan_stp_collection(db: Session, scan_mode: str) -> Dict[str, tuple]:
    """Decide per device whether this scan collects VLAN and STP data.

    Returns {ip: (collect_vlan, collect_stp)}; IPs without an entry collect
    both. Manual full/ports scans always collect. Link scans never do (they do
    not rebuild ports, so per-port VLAN/STP data would be discarded). MAC scans
    collect each part once its interval (vlan_update_interval_sec /
    stp_update_interval_sec) has passed; an interval of 0 leaves that part to
    manual full scans.
    """
    if scan_mode in {"full", "ports", "discovery"}:
        return {}
    rows = db.query(Device.ip, Device.vlan_at, Device.stp_at).all()
    if scan_mode != "macs":
        return {ip: (False, False) for ip, _, _ in rows}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    vlan_interval = _read_interval_setting("vlan_update_interval_sec", 1800)
    stp_interval = _read_interval_setting("stp_update_interval_sec", 300)

    def _due(stamp, interval: int) -> bool:
        if interval <= 0:
            return False
        if stamp is None:
            return True
        stamp = stamp.replace(tzinfo=None) if stamp.tzinfo else stamp
        return (now - stamp).total_seconds() >= interval

    return {ip: (_due(vlan_at, vlan_interval), _due(stp_at, stp_interval)) for ip, vlan_at, stp_at in rows}


def _apply_stp_vlan_names(device: Device, sw) -> None:
    """Overwrite the device's STP summary and VLAN names from scan data.

    Values the device no longer reports are reset to None / {} so stale
    spanning tree data does not survive a scan. Parts the scan did not collect
    (``stp_collected`` / ``vlan_collected`` False) keep their stored values.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if getattr(sw, "stp_collected", True):
        stp = getattr(sw, "stp", None) or {}
        device.stp_protocol = stp.get("protocol")
        device.stp_bridge_id = stp.get("bridge_id")
        device.stp_root_id = stp.get("root_id")
        device.stp_root_cost = stp.get("root_cost")
        device.stp_root_port = stp.get("root_port")
        device.stp_at = now
    if getattr(sw, "vlan_collected", True):
        vlan_names = getattr(sw, "vlan_names", None)
        device.vlan_names = dict(vlan_names) if isinstance(vlan_names, dict) else {}
        device.vlan_at = now


def _upsert_ping_candidates(db: Session, probe_ips: List[str], ping_by_ip: Dict[str, tuple]) -> None:
    """Record discovery-range hosts that answer ping but not SNMP as ping candidates.

    ``probe_ips`` are range probe targets for which no SNMP profile worked
    (credential targets never land here). Hosts that already have a Device or
    a Credential are skipped. Existing candidates get last_seen / rtt_ms
    refreshed; their dismissed flag is kept. The caller commits (lease-guarded).
    """
    rtt_by_ip: Dict[str, int] = {}
    for ip in probe_ips:
        ping_ok, ping_rtt = ping_by_ip.get(ip, (False, 0))
        if ping_ok:
            rtt_by_ip[ip] = ping_rtt
    if not rtt_by_ip:
        return
    ips = list(rtt_by_ip)
    known = {row[0] for row in db.query(Device.ip).filter(Device.ip.in_(ips)).all()}
    known |= {row[0] for row in db.query(Credential.ip).filter(Credential.ip.in_(ips)).all()}
    existing = {c.ip: c for c in db.query(PingCandidate).filter(PingCandidate.ip.in_(ips)).all()}
    now = datetime.now(timezone.utc)
    for ip, rtt in rtt_by_ip.items():
        if ip in known:
            continue
        cand = existing.get(ip)
        if cand is None:
            db.add(PingCandidate(ip=ip, rtt_ms=rtt, first_seen=now, last_seen=now, dismissed=False))
        else:
            cand.rtt_ms = rtt
            cand.last_seen = now


@_guard_scan_transactions
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
    lease: _ScanLease,
    working_cred_by_ip: Optional[Dict[str, int]] = None,
    ping_only_targets: Optional[Dict[str, dict]] = None,
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
                "firmware": sw.firmware if sw else "",
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
                    "firmware": "",
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
            status="cancelled" if status == "cancelled" else "dry_run",
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

    lease.check()

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
            lease.check()
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
                # community is stored encrypted like the v3 passwords; the
                # profile value is copied verbatim so it stays encrypted.
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
    existing_ips = {row[0] for row in db.query(Device.ip).all()}
    # Known devices that answered neither ping nor SNMP must still be marked
    # offline -- otherwise ping_status stays stuck on the last good result.
    update_ips = discovered_ips | (
        {ip for ip, (ok, _) in ping_by_ip.items() if not ok} & existing_ips
    )
    # Ping-only hosts were registered explicitly: their Device row is created
    # regardless of the ping result (except when the scan was cancelled and
    # the host may never have been pinged).
    ping_only_targets = ping_only_targets or {}
    ping_only_ips = {
        ip for ip in ping_only_targets
        if ip in ping_by_ip and (ip in existing_ips or status != "cancelled")
    }
    update_ips |= ping_only_ips
    ping_only_creds: Dict[int, Credential] = {}
    if ping_only_ips:
        ping_only_creds = {
            c.id: c for c in db.query(Credential).filter(
                Credential.id.in_([ping_only_targets[ip]["credential_id"] for ip in ping_only_ips])
            ).all()
        }
    devices_by_ip: Dict[str, Device] = {}
    if update_ips:
        devices_by_ip = {d.ip: d for d in db.query(Device).filter(Device.ip.in_(list(update_ips))).all()}
    new_ips = [ip for ip in discovered_ips | ping_only_ips if ip not in existing_ips]
    all_ips_ordered = list(existing_ips) + new_ips
    layout = auto_layout(all_ips_ordered)
    # Reload credentials to include any auto-created entries from range probes
    cred_by_ip = {}
    if discovered_ips:
        cred_by_ip = {c.ip: c for c in db.query(Credential).filter(Credential.ip.in_(list(discovered_ips))).all()}

    # Credentials whose scan succeeded (for engine ID persistence)
    working_cred_by_ip = working_cred_by_ip or {}
    working_creds: Dict[int, Credential] = {}
    if working_cred_by_ip:
        working_creds = {
            c.id: c for c in db.query(Credential).filter(
                Credential.id.in_(list(set(working_cred_by_ip.values())))
            ).all()
        }
    range_found_set = set(range_found_ips)

    # Manual vendor overrides (devices whose vendor_override flag is set)
    vendor_overrides: Dict[str, str] = {}

    for ip in update_ips:
        lease.check()
        sw = switch_data.get(ip)
        ping_ok, ping_rtt = ping_by_ip.get(ip, (False, 0))
        ping_status = "online" if ping_ok else "offline"

        if ip in ping_only_ips:
            info = ping_only_targets[ip]
            devices_by_ip[ip] = _upsert_ping_only_device(
                db, ip, devices_by_ip.get(ip), ping_only_creds.get(info["credential_id"]),
                info.get("label") or "", ping_ok, ping_rtt, layout.get(ip, (100.0, 100.0)),
            )
            continue

        cred = cred_by_ip.get(ip)

        observed_engine_id = getattr(sw, "engine_id", "") if sw is not None else ""
        if isinstance(observed_engine_id, str) and observed_engine_id:
            engine_cred = working_creds.get(working_cred_by_ip.get(ip))
            if engine_cred is None and ip in range_found_set:
                # Auto-created credential from a range probe (single per IP)
                engine_cred = cred
            if engine_cred is not None:
                _record_engine_id(db, engine_cred, observed_engine_id, corr)

        # Determine vendor, model and firmware from scan data (overrides now live on Device)
        vendor = (sw.vendor if sw else "generic")
        # UPS / server ident values (health snapshot) beat sysDescr parsing.
        sw_health = getattr(sw, "health", None) if sw else None
        model = ((health_model(sw_health) or extract_model(sw.sys_descr, sw.vendor)) if sw else "")
        firmware = ((health_firmware(sw_health) or sw.firmware) if sw else "")
        detected_type = (getattr(sw, "device_type", None) or "switch") if sw else "switch"

        device = devices_by_ip.get(ip)
        if device:
            was_ping_only = bool(device.ping_only)
            # The credential is SNMP-enabled again (normal SNMP path)
            device.ping_only = False
            if sw:
                if was_ping_only and device.device_type == "other":
                    # "other" was only the ping-only placeholder; let the
                    # SNMP detection decide the type again.
                    device.device_type = "switch"
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
                device.device_type = _resolve_device_type(
                    device.device_type, detected_type, detected_vendor, bool(device.vendor_override and device.vendor),
                )
                device.sys_name  = sw.sys_name  or device.sys_name
                device.sys_descr = sw.sys_descr or device.sys_descr
                device.location  = sw.location  or device.location
                device.model     = model        or device.model
                device.firmware  = firmware     or device.firmware
                device.last_seen = datetime.now(timezone.utc)
                if scan_mode != "discovery":
                    _apply_stp_vlan_names(device, sw)
                    _apply_if_name_cache(device, sw)
                    _apply_health(device, sw)
            elif ping_ok:
                device.sys_name = device.sys_name or ip
                device.sys_descr = device.sys_descr or "Discovered by ping (SNMP unavailable)"
                # Never clobber an existing vendor with the "generic" fallback
                # of a ping-only observation (would erase manual overrides).
                device.vendor = device.vendor or vendor or "generic"
                device.model = model or device.model
                # A ping reply is a sighting too: keep last_seen in step with
                # ping_status="online" so the dashboard never shows an online
                # device with a stale "last seen" timestamp.
                device.last_seen = datetime.now(timezone.utc)
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
                firmware=firmware,
                vendor=vendor,
                device_type=detected_type,
                location=sw.location if sw else "",
                ping_status=ping_status,
                ping_rtt_ms=ping_rtt if ping_ok else 0,
                last_ping=datetime.now(timezone.utc),
                map_x=x,
                map_y=y,
                label=cred.label if cred else "",
                enabled=True,
            )
            if scan_mode != "discovery":
                _apply_stp_vlan_names(new_device, sw)
                _apply_if_name_cache(new_device, sw)
                _apply_health(new_device, sw)
            db.add(new_device)
            db.flush()
            devices_by_ip[ip] = new_device
            if cred and not cred.device_id:
                cred.device_id = new_device.id

    if status != "cancelled" and not (cancel_event and cancel_event.is_set()):
        _upsert_ping_candidates(db, range_no_profile_ips, ping_by_ip)

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
                    lease.check()
                    if cancel_event and cancel_event.is_set():
                        db.rollback()
                        status = "cancelled"
                        break
                    lease.check()

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

                    keep_vlan = not getattr(sw, "vlan_collected", True)
                    keep_stp = not getattr(sw, "stp_collected", True)
                    previous_ports: Dict[int, Port] = {}
                    if keep_vlan or keep_stp:
                        previous_ports = {
                            p.if_index: p for p in db.query(Port).filter(Port.device_id == device.id).all()
                        }
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
                        prev = previous_ports.get(iface.index)
                        vlan_src = prev if keep_vlan and prev is not None else None
                        stp_src = prev if keep_stp and prev is not None else iface
                        port_obj = Port(
                            device_id=device.id,
                            if_index=iface.index,
                            if_descr=iface.descr,
                            if_alias=iface.alias,
                            speed_mbps=iface.speed_mbps,
                            oper_status=iface.oper_status,
                            vlan=vlan_src.vlan if vlan_src else iface.vlan,
                            tagged_vlans=list(vlan_src.tagged_vlans or []) if vlan_src else iface.tagged_vlans,
                            stp_state=getattr(stp_src, "stp_state", None),
                            stp_role=getattr(stp_src, "stp_role", None),
                            stp_path_cost=getattr(stp_src, "stp_path_cost", None),
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
            except (ScanOwnershipLost, ScanFinalizationAborted):
                raise
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
                    lease.check()
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
            except (ScanOwnershipLost, ScanFinalizationAborted):
                raise
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
