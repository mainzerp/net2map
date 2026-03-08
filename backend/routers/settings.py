"""App settings and stats endpoints."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import AppSetting, Device, Port, ScanRun, get_db
from database import Rack as RackModel
from schemas import AppSettingOut, AppSettingUpdate
from shared.auth import require_role
from shared.audit import log_audit

router = APIRouter()


@router.get("/api/settings", response_model=List[AppSettingOut])
def list_settings(db: Session = Depends(get_db)):
    return db.query(AppSetting).all()


@router.put("/api/settings/{key}", response_model=AppSettingOut,
            dependencies=[require_role("admin", "operator")])
def update_setting(key: str, body: AppSettingUpdate, request: Request, db: Session = Depends(get_db)):
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
    from sqlalchemy import func
    device_count = db.query(Device).count()
    port_count = db.query(Port).count()
    port_up = db.query(Port).filter(Port.oper_status == 1).count()
    rack_count = db.query(RackModel).count()
    latest_scan = db.query(ScanRun).order_by(ScanRun.created_at.desc()).first()
    return {
        "device_count": device_count,
        "port_count": port_count,
        "port_up_count": port_up,
        "rack_count": rack_count,
        "last_scan_at": latest_scan.created_at if latest_scan else None,
        "last_scan_status": latest_scan.status if latest_scan else None,
    }
