"""App settings and stats endpoints."""
from typing import List

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import AppSetting, Device, Endpoint, Port, ScanRun, get_db
from database import Rack as RackModel
from schemas import AppSettingOut, AppSettingUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.get("/api/settings", response_model=List[AppSettingOut])
def list_settings(db: Session = Depends(get_db)):
    return db.query(AppSetting).all()


# Keys that may be written via PUT /api/settings/{key}. Covers every key read
# by the backend (scheduler, tasks, scan/dns/map settings) or written by the
# frontend; unknown keys are rejected to prevent settings-table pollution.
ALLOWED_SETTING_KEYS = {
    "discovery_interval_sec",
    "link_update_interval_sec",
    "mac_update_interval_sec",
    "port_update_interval_sec",  # legacy, still read as fallback
    "discovery_scan_ranges",
    "scan_max_workers",
    "scan_snmp_timeout",
    "scan_snmp_retries",
    "dns_servers",
    "map_opacity",
    "map_scale",
    "map_bg_color",
    "audit_retention_days",
}


@router.put("/api/settings/{key}", response_model=AppSettingOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_setting(key: str, body: AppSettingUpdate, request: Request, db: Session = Depends(get_db)):
    if key not in ALLOWED_SETTING_KEYS:
        api_error(400, "UNKNOWN_SETTING_KEY", f"Unknown setting key: '{key}'", field="key")
    setting = db.query(AppSetting).filter(AppSetting.key == key).first()
    if not setting:
        setting = AppSetting(key=key, value=body.value)
        db.add(setting)
    else:
        setting.value = body.value
    db.commit()
    db.refresh(setting)
    log_audit(request, "settings_change", "app_setting", key, {"value": body.value})
    return setting


@router.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    device_count = db.query(Device).count()
    port_count = db.query(Port).count()
    port_up = db.query(Port).filter(Port.oper_status == 1).count()
    rack_count = db.query(RackModel).count()
    endpoint_count = db.query(Endpoint).count()
    latest_scan = db.query(ScanRun).order_by(ScanRun.created_at.desc()).first()
    return {
        "device_count": device_count,
        "port_count": port_count,
        "port_up_count": port_up,
        "rack_count": rack_count,
        "endpoint_count": endpoint_count,
        "last_scan_at": latest_scan.created_at if latest_scan else None,
        "last_scan_status": latest_scan.status if latest_scan else None,
    }
