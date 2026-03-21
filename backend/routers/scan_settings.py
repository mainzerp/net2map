"""Scan settings, discovery ranges, and DNS settings endpoints."""
import ipaddress
import json
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import AppSetting, get_db
from scan_engine import _read_discovery_ranges
from schemas import (
    DiscoveryRangesOut,
    DiscoveryRangesUpdate,
    DnsSettingsOut,
    DnsSettingsUpdate,
    ScanSettingsOut,
    ScanSettingsUpdate,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.file_settings import (
    _read_dns_settings,
    _read_scan_settings,
    _write_dns_settings,
    _write_scan_settings,
)

router = APIRouter()


@router.get("/api/scan-settings", response_model=ScanSettingsOut)
def get_scan_settings():
    """Return scan execution settings."""
    return _read_scan_settings()


@router.put("/api/scan-settings", response_model=ScanSettingsOut,
            dependencies=[require_role("admin", "operator")])
def update_scan_settings(body: ScanSettingsUpdate, request: Request):
    """Update scan execution settings."""
    result = _write_scan_settings(body.model_dump(exclude_none=True))
    log_audit(request, "settings_change", "scan_settings", "", body.model_dump(exclude_none=True))
    return result


@router.get("/api/discovery-ranges", response_model=DiscoveryRangesOut)
def get_discovery_ranges(db: Session = Depends(get_db)):
    """Return configured discovery scan ranges."""
    return {"ranges": _read_discovery_ranges(db)}


@router.put("/api/discovery-ranges", response_model=DiscoveryRangesOut,
            dependencies=[require_role("admin", "operator")])
def update_discovery_ranges(body: DiscoveryRangesUpdate, request: Request, db: Session = Depends(get_db)):
    """Save discovery scan ranges (CIDR notation or single IPs)."""
    validated: List[str] = []
    for entry in body.ranges:
        entry = str(entry).strip()
        if not entry:
            continue
        try:
            ipaddress.ip_network(entry, strict=False)
            validated.append(entry)
        except ValueError:
            try:
                ipaddress.ip_address(entry)
                validated.append(entry)
            except ValueError:
                api_error(400, "INVALID_IP_RANGE", f"Invalid IP or CIDR range: {entry}", field="ranges")

    row = db.query(AppSetting).filter(AppSetting.key == "discovery_scan_ranges").first()
    if row:
        row.value = json.dumps(validated)
    else:
        db.add(AppSetting(key="discovery_scan_ranges", value=json.dumps(validated)))
    db.commit()
    log_audit(request, "settings_change", "discovery_ranges", "", {"ranges": validated})
    return {"ranges": validated}


@router.get("/api/dns-settings", response_model=DnsSettingsOut)
def get_dns_settings():
    """Return configured DNS servers for reverse lookups."""
    return _read_dns_settings()


@router.put("/api/dns-settings", response_model=DnsSettingsOut,
            dependencies=[require_role("admin", "operator")])
def update_dns_settings(body: DnsSettingsUpdate, request: Request):
    """Update configured DNS servers for reverse lookups."""
    result = _write_dns_settings(body.servers)
    log_audit(request, "settings_change", "dns_settings", "", {"servers": body.servers})
    return result
