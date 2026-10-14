"""App settings and stats endpoints."""
from typing import Dict, List

from fastapi import APIRouter, Body, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import AppSetting, Device, Endpoint, Port, ScanRun, get_db
from database import Rack as RackModel
from latency.settings import LATENCY_SETTING_KEYS, validate_setting_value
from schemas import AppSettingOut, AppSettingUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.get("/settings", response_model=List[AppSettingOut])
def list_settings(db: Session = Depends(get_db)):
    return db.query(AppSetting).all()


# Keys that may be written via PUT /api/v1/settings/{key} and PUT /api/v1/settings. Covers every key read
# by the backend (scheduler, tasks, scan/dns/map settings) or written by the
# frontend; unknown keys are rejected to prevent settings-table pollution.
ALLOWED_SETTING_KEYS = {
    "discovery_interval_sec",
    "link_update_interval_sec",
    "mac_update_interval_sec",
    "vlan_update_interval_sec",
    "stp_update_interval_sec",
    "port_update_interval_sec",  # legacy, still read as fallback
    "discovery_scan_ranges",
    "scan_max_workers",
    "scan_snmp_timeout",
    "scan_snmp_retries",
    "scan_snmp_bulk_size",
    "dns_servers",
    "map_opacity",
    "map_scale",
    "map_bg_color",
    "audit_retention_days",
    "endpoint_retention_days",
    *LATENCY_SETTING_KEYS,
}

# Integer settings validated here: key -> (min, max).
_INT_SETTING_RANGES = {
    # Days after which unseen endpoints are pruned; 0 disables pruning.
    "endpoint_retention_days": (0, 3650),
}


def _validated_value(key: str, value: str, key_field: str = "key", value_field: str = "value") -> str:
    """Return the normalized value for ``key`` or raise a 400 api_error."""
    if key not in ALLOWED_SETTING_KEYS:
        api_error(400, "UNKNOWN_SETTING_KEY", f"Unknown setting key: '{key}'", field=key_field)
    if key in LATENCY_SETTING_KEYS:
        try:
            return validate_setting_value(key, value)
        except ValueError as exc:
            api_error(400, "INVALID_SETTING_VALUE", str(exc), field=value_field)
    if key in _INT_SETTING_RANGES:
        low, high = _INT_SETTING_RANGES[key]
        try:
            number = int(str(value).strip())
        except ValueError:
            api_error(400, "INVALID_SETTING_VALUE", f"{key} must be an integer", field=value_field)
        if not low <= number <= high:
            api_error(400, "INVALID_SETTING_VALUE", f"{key} must be between {low} and {high}", field=value_field)
        return str(number)
    return value


def _upsert(db: Session, key: str, value: str) -> AppSetting:
    setting = db.query(AppSetting).filter(AppSetting.key == key).first()
    if not setting:
        setting = AppSetting(key=key, value=value)
        db.add(setting)
    else:
        setting.value = value
    return setting


@router.put("/settings", response_model=List[AppSettingOut],
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_settings_bulk(request: Request, body: Dict[str, str] = Body(...), db: Session = Depends(get_db)):
    """Apply several settings atomically: all keys and values are validated first."""
    if not body:
        api_error(400, "EMPTY_SETTINGS", "No settings given")
    values = {key: _validated_value(key, value, key_field=key, value_field=key) for key, value in body.items()}
    for key, value in values.items():
        _upsert(db, key, value)
    db.commit()
    log_audit(request, "settings_change", "app_setting", ",".join(sorted(values)),
              {"keys": sorted(values), "values": values})
    return db.query(AppSetting).all()


@router.put("/settings/{key}", response_model=AppSettingOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_setting(key: str, body: AppSettingUpdate, request: Request, db: Session = Depends(get_db)):
    value = _validated_value(key, body.value)
    setting = _upsert(db, key, value)
    db.commit()
    db.refresh(setting)
    log_audit(request, "settings_change", "app_setting", key, {"value": value})
    return setting


@router.get("/stats")
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
