"""Database helper functions for scan engine."""
import ipaddress
import json
import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from database import AppSetting, ScanRun, ScanRunSwitchMetric
from schemas import ScanResult

log = logging.getLogger(__name__)


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
