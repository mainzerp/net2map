"""Scan settings, discovery ranges, and DNS settings endpoints."""
import ipaddress
import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import AppSetting, get_db
from scan_engine import _read_discovery_ranges
from shared.file_settings import (
    _normalize_dns_servers,
    _read_dns_settings,
    _read_scan_settings,
    _write_dns_settings,
    _write_scan_settings,
)

router = APIRouter()


@router.get("/api/scan-settings")
def get_scan_settings():
    """Return scan execution settings."""
    return _read_scan_settings()


@router.put("/api/scan-settings")
async def update_scan_settings(request: Request):
    """Update scan execution settings."""
    body = await request.json()
    return _write_scan_settings(body)


@router.get("/api/discovery-ranges")
def get_discovery_ranges(db: Session = Depends(get_db)):
    """Return configured discovery scan ranges."""
    return {"ranges": _read_discovery_ranges(db)}


@router.put("/api/discovery-ranges")
async def update_discovery_ranges(request: Request, db: Session = Depends(get_db)):
    """Save discovery scan ranges (CIDR notation or single IPs)."""
    body = await request.json()
    raw_ranges = body.get("ranges", [])
    if not isinstance(raw_ranges, list):
        raise HTTPException(400, "'ranges' must be an array")

    validated: List[str] = []
    for entry in raw_ranges:
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
                raise HTTPException(400, f"Invalid IP or CIDR range: {entry}")

    row = db.query(AppSetting).filter(AppSetting.key == "discovery_scan_ranges").first()
    if row:
        row.value = json.dumps(validated)
    else:
        db.add(AppSetting(key="discovery_scan_ranges", value=json.dumps(validated)))
    db.commit()
    return {"ranges": validated}


@router.get("/api/dns-settings")
def get_dns_settings():
    """Return configured DNS servers for reverse lookups."""
    return _read_dns_settings()


@router.put("/api/dns-settings")
async def update_dns_settings(request: Request):
    """Update configured DNS servers for reverse lookups."""
    body = await request.json()
    return _write_dns_settings(body.get("servers", []))
