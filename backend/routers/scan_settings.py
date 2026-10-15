"""Scan settings, discovery ranges, and DNS settings endpoints."""
import ipaddress
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import ScanRange, get_db
from schemas import (
    DiscoveryRangesOut,
    DiscoveryRangesUpdate,
    DnsSettingsOut,
    DnsSettingsUpdate,
    DnsTestOut,
    DnsTestRequest,
    ScanSettingsOut,
    ScanSettingsUpdate,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.dns_check import check_reverse_dns
from shared.errors import api_error
from shared.file_settings import (
    _read_dns_settings,
    _read_scan_settings,
    _write_dns_settings,
    _write_scan_settings,
)
from shared.scan_ranges import ScanRangeError, all_range_cidrs, normalize_scan_range

router = APIRouter()


@router.get("/scan-settings", response_model=ScanSettingsOut)
def get_scan_settings():
    """Return scan execution settings."""
    return _read_scan_settings()


@router.put("/scan-settings", response_model=ScanSettingsOut,
            dependencies=[require_role("admin", "operator")])
def update_scan_settings(body: ScanSettingsUpdate, request: Request):
    """Update scan execution settings."""
    result = _write_scan_settings(body.model_dump(exclude_none=True))
    log_audit(request, "settings_change", "scan_settings", "", body.model_dump(exclude_none=True))
    return result


@router.get("/discovery-ranges", response_model=DiscoveryRangesOut, deprecated=True)
def get_discovery_ranges(db: Session = Depends(get_db)):
    """Return the CIDRs of all scan ranges. Deprecated: use GET /scan-ranges."""
    return {"ranges": all_range_cidrs(db)}


@router.put("/discovery-ranges", response_model=DiscoveryRangesOut, deprecated=True,
            dependencies=[require_role("admin", "operator")])
def update_discovery_ranges(body: DiscoveryRangesUpdate, request: Request, db: Session = Depends(get_db)):
    """Replace the scan range list (CIDR notation or single IPs). Deprecated: use /scan-ranges.

    Listed ranges that already exist keep their settings, missing ones are
    created with defaults and ranges not listed are deleted.
    """
    validated: List[str] = []
    for entry in body.ranges:
        entry = str(entry).strip()
        if not entry:
            continue
        try:
            cidr = normalize_scan_range(entry)
        except ScanRangeError as exc:
            api_error(400, exc.code, str(exc), field="ranges")
        if cidr not in validated:
            validated.append(cidr)

    wanted = set(validated)
    existing = {row.cidr: row for row in db.query(ScanRange).all()}
    for cidr, row in existing.items():
        if cidr not in wanted:
            db.delete(row)
    for cidr in validated:
        if cidr not in existing:
            db.add(ScanRange(cidr=cidr, label="", enabled=True))
    db.commit()
    ranges = all_range_cidrs(db)
    log_audit(request, "settings_change", "discovery_ranges", "", {"ranges": ranges})
    return {"ranges": ranges}


@router.get("/dns-settings", response_model=DnsSettingsOut)
def get_dns_settings():
    """Return configured DNS servers for reverse lookups."""
    return _read_dns_settings()


@router.post("/dns-settings/test", response_model=DnsTestOut,
             dependencies=[require_role("admin", "operator")])
def test_dns_settings(body: DnsTestRequest):
    """Reverse-resolve one IP with the configured servers and the system resolver (no cache)."""
    try:
        ip = str(ipaddress.ip_address(body.ip.strip()))
    except ValueError:
        api_error(400, "INVALID_IP", f"Invalid IP address: {body.ip}", field="ip")
    servers = _read_dns_settings().get("servers", [])
    return {"ip": ip, "results": check_reverse_dns(ip, servers)}


@router.put("/dns-settings", response_model=DnsSettingsOut,
            dependencies=[require_role("admin", "operator")])
def update_dns_settings(body: DnsSettingsUpdate, request: Request):
    """Update configured DNS servers for reverse lookups."""
    result = _write_dns_settings(body.servers)
    log_audit(request, "settings_change", "dns_settings", "", {"servers": body.servers})
    return result
