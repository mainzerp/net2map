"""FastAPI application – NetMap backend."""
import asyncio
import json
import csv
import hashlib
import io
import logging
import os
import socket
import shutil
import ipaddress
import time
import threading
import uuid
import subprocess
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from database import (
    Credential, Device, Port, TopologyLink, SnmpProfile,
    ScanRun, ScanRunSwitchMetric, SessionLocal,
    Rack as RackModel, SwitchClass as SwitchClassModel,
    AppSetting,
    create_tables, get_db,
)
from database import SwitchModel as SwitchModelModel
from schemas import (
    CredentialCreate, CredentialOut, CredentialUpdate,
    DeviceOut, DevicePositionUpdate, DeviceMetaUpdate, RackPositionUpdate,
    ScanResult, ScanRunOut, ScanSwitchMetric, TopologyOut, TopologyLinkOut,
    SnmpProfileCreate, SnmpProfileUpdate, SnmpProfileOut,
    RackCreate, RackUpdate, RackOut,
    SwitchClassCreate, SwitchClassUpdate, SwitchClassOut,
    SwitchModelCreate, SwitchModelUpdate, SwitchModelOut,
    AppSettingOut, AppSettingUpdate,
    BulkImportRequest, BulkImportResult, BulkImportError, BulkExportOut,
    GlobalConfigExportOut, GlobalConfigImportRequest,
)
from snmp_scanner import (
    LldpNeighbor, SwitchData, auto_layout, scan_switch,
    extract_model, is_virtual, speed_label,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="NetMap API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


SCAN_JOBS: Dict[str, dict] = {}
SCAN_JOBS_LOCK = threading.Lock()
LOG_BUFFER = deque(maxlen=5000)
LOG_BUFFER_LOCK = threading.Lock()


def _log_event(level: int, event: str, **fields):
    payload = {
        "ts": datetime.utcnow().isoformat() + "Z",
        "level": logging.getLevelName(level),
        "event": event,
        **fields,
    }
    line = json.dumps(payload, ensure_ascii=False)
    with LOG_BUFFER_LOCK:
        LOG_BUFFER.append(payload)
    log.log(level, line)


@app.on_event("startup")
def on_startup():
    create_tables()
    threading.Thread(target=_background_scheduler, daemon=True).start()

def _background_scheduler():
    """Runs discovery and port scans periodically based on app settings."""
    last_discovery = 0
    last_ports = 0
    
    while True:
        time.sleep(5)
        
        try:
            db = SessionLocal()
            
            # Read settings
            discovery_setting = db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").first()
            ports_setting = db.query(AppSetting).filter(AppSetting.key == "port_update_interval_sec").first()
            
            discovery_interval = int(discovery_setting.value) if discovery_setting else 1800
            ports_interval = int(ports_setting.value) if ports_setting else 30
            
            now = time.time()
            
            # Run discovery scan
            if discovery_interval > 0 and (now - last_discovery) >= discovery_interval:
                _log_event(logging.INFO, "scheduler.discovery.start")
                loop = asyncio.new_event_loop()
                try:
                    loop.run_until_complete(_execute_scan(db, scan_type="discovery"))
                finally:
                    loop.close()
                last_discovery = time.time()

            # Run ports scan
            if ports_interval > 0 and (now - last_ports) >= ports_interval:
                _log_event(logging.INFO, "scheduler.ports.start")
                loop = asyncio.new_event_loop()
                try:
                    loop.run_until_complete(_execute_scan(db, scan_type="ports"))
                finally:
                    loop.close()
                last_ports = time.time()
                
        except Exception as e:
            _log_event(logging.ERROR, "scheduler.error", error=str(e))
        finally:
            db.close()

# ─── App Settings ──────────────────────────────────────────────────────────────

@app.get("/api/settings", response_model=List[AppSettingOut])
def list_settings(db: Session = Depends(get_db)):
    return db.query(AppSetting).all()

@app.put("/api/settings/{key}", response_model=AppSettingOut)
def update_setting(key: str, body: AppSettingUpdate, db: Session = Depends(get_db)):
    setting = db.query(AppSetting).filter(AppSetting.key == key).first()
    if not setting:
        setting = AppSetting(key=key, value=body.value)
        db.add(setting)
    else:
        setting.value = body.value
    db.commit()
    db.refresh(setting)
    return setting


PROFILE_BULK_FIELDS = [
    "label", "snmp_version", "community",
    "v3_security_level", "v3_username",
    "v3_auth_protocol", "v3_auth_password",
    "v3_priv_protocol", "v3_priv_password",
]

CREDENTIAL_BULK_FIELDS = [
    "label", "ip", "snmp_port", "location", "enabled",
    "snmp_version", "community",
    "v3_security_level", "v3_username",
    "v3_auth_protocol", "v3_auth_password",
    "v3_priv_protocol", "v3_priv_password",
    "profile_id", "rack_id", "class_id", "vendor", "model",
]


def _normalize_bool(value):
    if isinstance(value, bool):
        return value
    txt = str(value or "").strip().lower()
    return txt in {"1", "true", "yes", "y", "on"}


def _normalize_optional_int(value):
    if value is None:
        return None
    txt = str(value).strip()
    if txt == "":
        return None
    return int(txt)


def _parse_bulk_rows(kind: str, body: BulkImportRequest) -> List[dict]:
    if body.format == "json":
        parsed = json.loads(body.data or "[]")
        if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
            parsed = parsed.get("items")
        if not isinstance(parsed, list):
            raise HTTPException(400, "JSON import requires an array or {items:[...]} payload")
        rows = parsed
    else:
        reader = csv.DictReader(io.StringIO(body.data or ""))
        rows = list(reader)

    normalized: List[dict] = []
    for src in rows:
        row = {k: v for k, v in (src or {}).items()}

        if kind == "credentials":
            for key in ["profile_id", "rack_id", "class_id", "snmp_port"]:
                if key in row:
                    row[key] = _normalize_optional_int(row.get(key))
            if "enabled" in row:
                row["enabled"] = _normalize_bool(row.get("enabled"))
        normalized.append(row)

    return normalized


def _validate_bulk_rows(kind: str, rows: List[dict]) -> tuple[List[dict], List[BulkImportError]]:
    valid: List[dict] = []
    errors: List[BulkImportError] = []
    schema_cls = CredentialCreate if kind == "credentials" else SnmpProfileCreate

    for idx, row in enumerate(rows, start=1):
        try:
            payload = schema_cls(**row).model_dump()
            valid.append(payload)
        except Exception as exc:
            errors.append(BulkImportError(row=idx, message=str(exc)))

    return valid, errors


def _serialize_bulk_rows(kind: str, rows: List[dict], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(rows, ensure_ascii=False, indent=2)

    fieldnames = CREDENTIAL_BULK_FIELDS if kind == "credentials" else PROFILE_BULK_FIELDS
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: row.get(k, "") for k in fieldnames})
    return buf.getvalue()


@app.get("/api/bulk-export/{kind}", response_model=BulkExportOut)
def bulk_export(kind: str, format: str = "json", db: Session = Depends(get_db)):
    if kind not in {"credentials", "profiles"}:
        raise HTTPException(400, "kind must be 'credentials' or 'profiles'")
    fmt = (format or "json").lower()
    if fmt not in {"json", "csv"}:
        raise HTTPException(400, "format must be 'json' or 'csv'")

    if kind == "credentials":
        rows = []
        for c in db.query(Credential).order_by(Credential.id).all():
            rows.append({
                "label": c.label,
                "ip": c.ip,
                "snmp_port": c.snmp_port,
                "location": c.location,
                "enabled": bool(c.enabled),
                "snmp_version": c.snmp_version,
                "community": c.community,
                "v3_security_level": c.v3_security_level,
                "v3_username": c.v3_username,
                "v3_auth_protocol": c.v3_auth_protocol,
                "v3_auth_password": c.v3_auth_password,
                "v3_priv_protocol": c.v3_priv_protocol,
                "v3_priv_password": c.v3_priv_password,
                "profile_id": c.profile_id,
                "rack_id": c.rack_id,
                "class_id": c.class_id,
                "vendor": c.vendor,
                "model": c.model,
            })
    else:
        rows = []
        for p in db.query(SnmpProfile).order_by(SnmpProfile.id).all():
            rows.append({
                "label": p.label,
                "snmp_version": p.snmp_version,
                "community": p.community,
                "v3_security_level": p.v3_security_level,
                "v3_username": p.v3_username,
                "v3_auth_protocol": p.v3_auth_protocol,
                "v3_auth_password": p.v3_auth_password,
                "v3_priv_protocol": p.v3_priv_protocol,
                "v3_priv_password": p.v3_priv_password,
            })

    return BulkExportOut(type=kind, format=fmt, data=_serialize_bulk_rows(kind, rows, fmt))


@app.post("/api/bulk-import/{kind}", response_model=BulkImportResult)
def bulk_import(kind: str, body: BulkImportRequest, db: Session = Depends(get_db)):
    if kind not in {"credentials", "profiles"}:
        raise HTTPException(400, "kind must be 'credentials' or 'profiles'")

    try:
        parsed_rows = _parse_bulk_rows(kind, body)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Invalid import payload: {exc}")

    valid_rows, errors = _validate_bulk_rows(kind, parsed_rows)
    inserted = 0
    updated = 0

    if not body.dry_run:
        if kind == "credentials":
            for payload in valid_rows:
                existing = db.query(Credential).filter(Credential.ip == payload["ip"]).first()
                if existing:
                    for key, value in payload.items():
                        setattr(existing, key, value)
                    updated += 1
                else:
                    db.add(Credential(**payload))
                    inserted += 1
        else:
            for payload in valid_rows:
                existing = db.query(SnmpProfile).filter(SnmpProfile.label == payload["label"]).first()
                if existing:
                    for key, value in payload.items():
                        setattr(existing, key, value)
                    updated += 1
                else:
                    db.add(SnmpProfile(**payload))
                    inserted += 1
        db.commit()

    return BulkImportResult(
        type=kind,
        format=body.format,
        dry_run=bool(body.dry_run),
        total_rows=len(parsed_rows),
        valid_rows=len(valid_rows),
        inserted=inserted,
        updated=updated,
        errors=errors,
    )


@app.get("/api/config/export", response_model=GlobalConfigExportOut)
def export_global_config(db: Session = Depends(get_db)):
    payload = {
        "version": 1,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "settings": [
            {"key": s.key, "value": s.value}
            for s in db.query(AppSetting).order_by(AppSetting.key).all()
        ],
        "profiles": [
            {
                "label": p.label,
                "snmp_version": p.snmp_version,
                "community": p.community,
                "v3_security_level": p.v3_security_level,
                "v3_username": p.v3_username,
                "v3_auth_protocol": p.v3_auth_protocol,
                "v3_auth_password": p.v3_auth_password,
                "v3_priv_protocol": p.v3_priv_protocol,
                "v3_priv_password": p.v3_priv_password,
            }
            for p in db.query(SnmpProfile).order_by(SnmpProfile.id).all()
        ],
        "credentials": [
            {
                "label": c.label,
                "ip": c.ip,
                "snmp_port": c.snmp_port,
                "location": c.location,
                "enabled": bool(c.enabled),
                "snmp_version": c.snmp_version,
                "community": c.community,
                "v3_security_level": c.v3_security_level,
                "v3_username": c.v3_username,
                "v3_auth_protocol": c.v3_auth_protocol,
                "v3_auth_password": c.v3_auth_password,
                "v3_priv_protocol": c.v3_priv_protocol,
                "v3_priv_password": c.v3_priv_password,
                "profile_id": c.profile_id,
                "rack_id": c.rack_id,
                "class_id": c.class_id,
                "vendor": c.vendor,
                "model": c.model,
            }
            for c in db.query(Credential).order_by(Credential.id).all()
        ],
    }
    return GlobalConfigExportOut(data=json.dumps(payload, ensure_ascii=False, indent=2))


@app.post("/api/config/import")
def import_global_config(body: GlobalConfigImportRequest, db: Session = Depends(get_db)):
    try:
        payload = json.loads(body.data or "{}")
    except Exception as exc:
        raise HTTPException(400, f"Invalid JSON payload: {exc}")

    if not isinstance(payload, dict):
        raise HTTPException(400, "Config payload must be a JSON object")

    settings_rows = payload.get("settings") or []
    profile_rows = payload.get("profiles") or []
    credential_rows = payload.get("credentials") or []

    if not isinstance(settings_rows, list) or not isinstance(profile_rows, list) or not isinstance(credential_rows, list):
        raise HTTPException(400, "settings/profiles/credentials must be arrays")

    errors = []
    valid_settings = []
    valid_profiles = []
    valid_credentials = []

    for i, row in enumerate(settings_rows, start=1):
        try:
            key = str(row.get("key", "")).strip()
            value = str(row.get("value", ""))
            if not key:
                raise ValueError("missing key")
            valid_settings.append({"key": key, "value": value})
        except Exception as exc:
            errors.append({"section": "settings", "row": i, "message": str(exc)})

    for i, row in enumerate(profile_rows, start=1):
        try:
            valid_profiles.append(SnmpProfileCreate(**row).model_dump())
        except Exception as exc:
            errors.append({"section": "profiles", "row": i, "message": str(exc)})

    for i, row in enumerate(credential_rows, start=1):
        try:
            normalized = dict(row)
            for key in ["profile_id", "rack_id", "class_id", "snmp_port"]:
                if key in normalized:
                    normalized[key] = _normalize_optional_int(normalized.get(key))
            if "enabled" in normalized:
                normalized["enabled"] = _normalize_bool(normalized.get("enabled"))
            valid_credentials.append(CredentialCreate(**normalized).model_dump())
        except Exception as exc:
            errors.append({"section": "credentials", "row": i, "message": str(exc)})

    inserted = {"settings": 0, "profiles": 0, "credentials": 0}
    updated = {"settings": 0, "profiles": 0, "credentials": 0}

    if not body.dry_run and not errors:
        for row in valid_settings:
            existing = db.query(AppSetting).filter(AppSetting.key == row["key"]).first()
            if existing:
                existing.value = row["value"]
                updated["settings"] += 1
            else:
                db.add(AppSetting(**row))
                inserted["settings"] += 1

        for row in valid_profiles:
            existing = db.query(SnmpProfile).filter(SnmpProfile.label == row["label"]).first()
            if existing:
                for key, value in row.items():
                    setattr(existing, key, value)
                updated["profiles"] += 1
            else:
                db.add(SnmpProfile(**row))
                inserted["profiles"] += 1

        for row in valid_credentials:
            existing = db.query(Credential).filter(Credential.ip == row["ip"]).first()
            if existing:
                for key, value in row.items():
                    setattr(existing, key, value)
                updated["credentials"] += 1
            else:
                db.add(Credential(**row))
                inserted["credentials"] += 1

        db.commit()

    return {
        "dry_run": bool(body.dry_run),
        "totals": {
            "settings": len(valid_settings),
            "profiles": len(valid_profiles),
            "credentials": len(valid_credentials),
        },
        "inserted": inserted,
        "updated": updated,
        "errors": errors,
    }

# ─── SNMP Profiles ───────────────────────────────────────────────────────────────

@app.get("/api/snmp-profiles", response_model=List[SnmpProfileOut])
def list_snmp_profiles(db: Session = Depends(get_db)):
    return db.query(SnmpProfile).order_by(SnmpProfile.id).all()


@app.post("/api/snmp-profiles", response_model=SnmpProfileOut, status_code=201)
def create_snmp_profile(body: SnmpProfileCreate, db: Session = Depends(get_db)):
    payload = body.model_dump()
    profile = SnmpProfile(**payload)
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@app.put("/api/snmp-profiles/{profile_id}", response_model=SnmpProfileOut)
def update_snmp_profile(profile_id: int, body: SnmpProfileUpdate, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    payload = body.model_dump(exclude_none=True)

    for k, v in payload.items():
        setattr(profile, k, v)

    # Keep linked credential fields aligned with profile settings so edits are immediately reflected.
    db.query(Credential).filter(Credential.profile_id == profile_id).update({
        "snmp_version": profile.snmp_version,
        "community": profile.community,
        "v3_security_level": profile.v3_security_level,
        "v3_username": profile.v3_username,
        "v3_auth_protocol": profile.v3_auth_protocol,
        "v3_auth_password": profile.v3_auth_password,
        "v3_priv_protocol": profile.v3_priv_protocol,
        "v3_priv_password": profile.v3_priv_password,
    })

    db.commit()
    db.refresh(profile)
    return profile


@app.delete("/api/snmp-profiles/{profile_id}", status_code=204)
def delete_snmp_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    # Detach credentials that use this profile before deleting
    db.query(Credential).filter(Credential.profile_id == profile_id).update({"profile_id": None})
    db.delete(profile)
    db.commit()


# ─── Racks ────────────────────────────────────────────────────────────────────

@app.get("/api/racks", response_model=List[RackOut])
def list_racks(db: Session = Depends(get_db)):
    return db.query(RackModel).order_by(RackModel.id).all()


@app.post("/api/racks", response_model=RackOut, status_code=201)
def create_rack(body: RackCreate, db: Session = Depends(get_db)):
    rack = RackModel(**body.model_dump())
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@app.put("/api/racks/{rack_id}", response_model=RackOut)
def update_rack(rack_id: int, body: RackUpdate, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(rack, k, v)
    db.commit()
    db.refresh(rack)
    return rack


@app.delete("/api/racks/{rack_id}", status_code=204)
def delete_rack(rack_id: int, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    # Detach devices assigned to this rack before deleting
    db.query(Device).filter(Device.rack_id == rack_id).update({"rack_id": None})
    db.delete(rack)
    db.commit()


# ─── Switch Classes ───────────────────────────────────────────────────────────

@app.get("/api/switch-classes", response_model=List[SwitchClassOut])
def list_switch_classes(db: Session = Depends(get_db)):
    return db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()


@app.post("/api/switch-classes", response_model=SwitchClassOut, status_code=201)
def create_switch_class(body: SwitchClassCreate, db: Session = Depends(get_db)):
    sc = SwitchClassModel(**body.model_dump())
    db.add(sc)
    db.commit()
    db.refresh(sc)
    return sc


@app.put("/api/switch-classes/{class_id}", response_model=SwitchClassOut)
def update_switch_class(class_id: int, body: SwitchClassUpdate, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        raise HTTPException(404, "Switch class not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(sc, k, v)
    db.commit()
    db.refresh(sc)
    return sc


@app.delete("/api/switch-classes/{class_id}", status_code=204)
def delete_switch_class(class_id: int, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        raise HTTPException(404, "Switch class not found")
    # Detach devices assigned to this class before deleting
    db.query(Device).filter(Device.class_id == class_id).update({"class_id": None})
    db.delete(sc)
    db.commit()


# ─── Switch Models ────────────────────────────────────────────────────────────

@app.get("/api/switch-models", response_model=List[SwitchModelOut])
def list_switch_models(db: Session = Depends(get_db)):
    return db.query(SwitchModelModel).order_by(SwitchModelModel.id).all()


@app.post("/api/switch-models", response_model=SwitchModelOut, status_code=201)
def create_switch_model(body: SwitchModelCreate, db: Session = Depends(get_db)):
    sm = SwitchModelModel(**body.model_dump())
    db.add(sm)
    db.commit()
    db.refresh(sm)
    return sm


@app.put("/api/switch-models/{model_id}", response_model=SwitchModelOut)
def update_switch_model(model_id: int, body: SwitchModelUpdate, db: Session = Depends(get_db)):
    sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first()
    if not sm:
        raise HTTPException(404, "Switch model not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(sm, k, v)
    db.commit()
    db.refresh(sm)
    return sm


@app.delete("/api/switch-models/{model_id}", status_code=204)
def delete_switch_model(model_id: int, db: Session = Depends(get_db)):
    sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first()
    if not sm:
        raise HTTPException(404, "Switch model not found")
    # Detach devices assigned to this model before deleting
    db.query(Device).filter(Device.model_id == model_id).update({"model_id": None})
    db.delete(sm)
    db.commit()


# ─── Credentials ──────────────────────────────────────────────────────────────

@app.get("/api/credentials", response_model=List[CredentialOut])
def list_credentials(db: Session = Depends(get_db)):
    return db.query(Credential).order_by(Credential.id).all()


@app.post("/api/credentials", response_model=CredentialOut, status_code=201)
def create_credential(body: CredentialCreate, db: Session = Depends(get_db)):
    existing = db.query(Credential).filter(Credential.ip == body.ip).first()
    if existing:
        raise HTTPException(400, f"IP {body.ip} already exists")
    cred = Credential(**body.model_dump())
    db.add(cred)
    
    # If device already exists, update its rack/class
    device = db.query(Device).filter(Device.ip == body.ip).first()
    if device:
        if cred.rack_id is not None:
            device.rack_id = cred.rack_id
        if cred.class_id is not None:
            device.class_id = cred.class_id

    db.commit()
    db.refresh(cred)
    return cred


@app.put("/api/credentials/{cred_id}", response_model=CredentialOut)
def update_credential(cred_id: int, body: CredentialUpdate, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        raise HTTPException(404, "Credential not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(cred, k, v)
        
    # If device exists, update its rack/class
    device = db.query(Device).filter(Device.ip == cred.ip).first()
    if device:
        if "rack_id" in body.model_dump(exclude_unset=True):
            device.rack_id = cred.rack_id
        if "class_id" in body.model_dump(exclude_unset=True):
            device.class_id = cred.class_id

    db.commit()
    db.refresh(cred)
    return cred


@app.delete("/api/credentials/{cred_id}", status_code=204)
def delete_credential(cred_id: int, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        raise HTTPException(404, "Credential not found")
    db.delete(cred)
    db.commit()


# ─── SNMP Scan ────────────────────────────────────────────────────────────────

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


async def _execute_scan(
    db: Session,
    cancel_event: Optional[threading.Event] = None,
    correlation_id: Optional[str] = None,
    scan_type: str = "full",
    dry_run: bool = False,
) -> ScanResult:
    corr = correlation_id or str(uuid.uuid4())

    if scan_type == "ports":
        # Only scan credentials that are already in the Device table
        known_ips = {d.ip for d in db.query(Device.ip).all()}
        credentials = db.query(Credential).filter(Credential.enabled == True, Credential.ip.in_(known_ips)).all()
    else:
        credentials = db.query(Credential).filter(Credential.enabled == True).all()

    scan_settings = _read_scan_settings()
    configured_max_workers = scan_settings.get("max_workers", 4)
    global_snmp_timeout = scan_settings.get("snmp_timeout", 3)
    global_snmp_retries = scan_settings.get("snmp_retries", 1)

    # ── Range-based discovery (only for discovery/full scans) ──────────────────
    range_targets: List[dict] = []
    if scan_type != "ports":
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
        scan_type=scan_type,
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
        cmd = ["ping", "-c", "1", "-W", str(timeout_sec), ip]
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
            import re as _re
            for pat in [
                r"time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms",
                r"average\s*=\s*([0-9]+)ms",
                r"durchschnitt\s*=\s*([0-9]+)ms",
            ]:
                m = _re.search(pat, out)
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
                        data = await asyncio.to_thread(
                            scan_switch,
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
                data = await asyncio.to_thread(
                    scan_switch,
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
                    scan_type=scan_type,
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
    if scan_type != "discovery":
        dns_cache: Dict[str, str] = {}
        dns_servers = _read_dns_settings().get("servers", [])

        for ip, sw in switch_data.items():
            device = db.query(Device).filter(Device.ip == ip).first()
            if not device:
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

        scanned_ips = set(switch_data.keys())
        db.query(TopologyLink).filter(TopologyLink.local_ip.in_(scanned_ips)).delete(
            synchronize_session=False
        )

        for ip, sw in switch_data.items():
            for nbr in sw.lldp_neighbors:
                if not nbr.remote_sys:
                    continue
                remote_ip = _resolve_ip(nbr.remote_sys, switch_data)
                spd_label = speed_label(sw.interfaces[nbr.local_port_idx].speed_mbps) \
                    if nbr.local_port_idx in sw.interfaces else "1G"
                db.add(TopologyLink(
                    local_ip=ip,
                    local_port=nbr.local_port_desc or str(nbr.local_port_idx),
                    remote_ip=remote_ip,
                    remote_sys=nbr.remote_sys,
                    remote_port=nbr.remote_port,
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


@app.post("/api/scan", response_model=ScanResult)
async def run_scan(db: Session = Depends(get_db)):
    """Synchronous scan execution (compatibility endpoint)."""
    return await _execute_scan(db, None, correlation_id=f"sync-{uuid.uuid4()}")


@app.post("/api/scan/jobs")
def start_scan_job():
    """Start background scan job and return job ID immediately."""
    return _start_job(dry_run=False)


@app.post("/api/scan/dry-run/jobs")
def start_dry_run_job():
    """Start a background dry-run discovery job. Returns job ID immediately.
    Poll /api/scan/jobs/{job_id} for results; result will contain a 'preview' key."""
    return _start_job(dry_run=True)


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


@app.get("/api/scan/jobs/{job_id}")
def get_scan_job(job_id: str):
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            raise HTTPException(404, "Scan job not found")
        return {
            "id": state["id"],
            "status": state["status"],
            "started_at": state["started_at"],
            "finished_at": state["finished_at"],
            "cancel_requested": state["cancel_requested"],
            "result": state["result"],
        }


@app.post("/api/scan/jobs/{job_id}/cancel")
def cancel_scan_job(job_id: str):
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            raise HTTPException(404, "Scan job not found")
        if state["status"] != "running":
            return {"id": job_id, "status": state["status"], "cancel_requested": state["cancel_requested"]}
        state["cancel_requested"] = True
        state["cancel_event"].set()
        _log_event(logging.WARNING, "scan.job.cancel_requested", correlation_id=job_id, job_id=job_id)
        return {"id": job_id, "status": state["status"], "cancel_requested": True}


@app.get("/api/scan-runs", response_model=List[ScanRunOut])
def list_scan_runs(limit: int = 20, db: Session = Depends(get_db)):
    clamped = max(1, min(200, limit))
    runs = db.query(ScanRun).order_by(ScanRun.created_at.desc()).limit(clamped).all()

    out: List[ScanRunOut] = []
    for idx, run in enumerate(runs):
        prev_run = runs[idx + 1] if idx + 1 < len(runs) else None
        current_devices = set(_safe_json_list(getattr(run, "devices_snapshot_json", "[]")))
        current_links = set(_safe_json_list(getattr(run, "links_snapshot_json", "[]")))
        prev_devices = set(_safe_json_list(getattr(prev_run, "devices_snapshot_json", "[]"))) if prev_run else set()
        prev_links = set(_safe_json_list(getattr(prev_run, "links_snapshot_json", "[]"))) if prev_run else set()

        new_devices = sorted(current_devices - prev_devices)
        removed_devices = sorted(prev_devices - current_devices)
        new_links = sorted(current_links - prev_links)
        removed_links = sorted(prev_links - current_links)

        metrics = [
            ScanSwitchMetric(
                ip=m.ip,
                label=m.label,
                duration_ms=m.duration_ms,
                success=bool(m.success),
                error=m.error or "",
            )
            for m in run.switch_metrics
        ]
        out.append(ScanRunOut(
            id=run.id,
            status=run.status,
            scanned=run.scanned,
            found=run.found,
            links=run.links,
            max_workers=run.max_workers,
            total_duration_ms=run.total_duration_ms,
            error_count=run.error_count,
            new_devices=new_devices,
            removed_devices=removed_devices,
            new_links=new_links,
            removed_links=removed_links,
            created_at=run.created_at,
            switch_metrics=metrics,
        ))
    return out


# ─── Topology ─────────────────────────────────────────────────────────────────

@app.get("/api/topology")
def get_topology(request: Request, db: Session = Depends(get_db)):
    nodes   = db.query(Device).all()
    links   = db.query(TopologyLink).all()
    racks   = db.query(RackModel).order_by(RackModel.id).all()
    classes = db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()
    models  = db.query(SwitchModelModel).order_by(SwitchModelModel.id).all()

    # Build a lookup for ports_per_row from switch models
    model_ppr = {m.id: m.ports_per_row for m in models}

    # Build DeviceOut objects with resolved ports_per_row
    node_dicts = []
    for d in nodes:
        dout = DeviceOut.model_validate(d)
        if d.model_id and d.model_id in model_ppr:
            dout.ports_per_row = model_ppr[d.model_id]
        node_dicts.append(dout)

    result  = TopologyOut(nodes=node_dicts, links=links, racks=racks, classes=classes, models=models)
    # ETag: hash of serialized result to allow browser-side caching
    body = result.model_dump_json()
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(content=body, media_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})


@app.patch("/api/topology/devices/{device_id}/position", response_model=DeviceOut)
def update_device_position(
    device_id: int, body: DevicePositionUpdate, db: Session = Depends(get_db)
):
    """Persist drag-and-drop position."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(404, "Device not found")
    device.map_x = body.map_x
    device.map_y = body.map_y
    db.commit()
    db.refresh(device)
    return device


@app.patch("/api/topology/racks/{rack_id}/position", response_model=RackOut)
def update_rack_position(
    rack_id: int, body: RackPositionUpdate, db: Session = Depends(get_db)
):
    """Persist drag-and-drop position for a rack."""
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    rack.map_x = body.map_x
    rack.map_y = body.map_y
    db.commit()
    db.refresh(rack)
    return rack


@app.patch("/api/topology/devices/{device_id}/meta", response_model=DeviceOut)
def update_device_meta(
    device_id: int, body: DeviceMetaUpdate, db: Session = Depends(get_db)
):
    """Update device location, sys_name, vendor, model, rack assignment, and/or switch class assignment."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(404, "Device not found")

    payload = body.model_dump(exclude_unset=True)

    if "location" in payload:
        device.location = payload["location"]
    if "sys_name" in payload:
        device.sys_name = payload["sys_name"]
    if "vendor" in payload:
        device.vendor = payload["vendor"]
    if "model" in payload:
        device.model = payload["model"]
    if "rack_id" in payload:
        rack_id = payload["rack_id"]
        if rack_id is not None and not db.query(RackModel).filter(RackModel.id == rack_id).first():
            raise HTTPException(404, "Rack not found")
        device.rack_id = rack_id
    if "class_id" in payload:
        class_id = payload["class_id"]
        if class_id is not None and not db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first():
            raise HTTPException(404, "Switch class not found")
        device.class_id = class_id
    if "model_id" in payload:
        model_id = payload["model_id"]
        if model_id is not None and not db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first():
            raise HTTPException(404, "Switch model not found")
        device.model_id = model_id

    db.commit()
    db.refresh(device)
    # Resolve ports_per_row from switch model
    dout = DeviceOut.model_validate(device)
    if device.model_id:
        sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == device.model_id).first()
        if sm:
            dout.ports_per_row = sm.ports_per_row
    return dout


# ─── Map Background ──────────────────────────────────────────────────────────

MAP_BG_DIR = "/data"
MAP_BG_FILENAME = "map-background"
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


def _find_bg_file():
    """Return the path of the stored background image, or None."""
    for ext in ALLOWED_EXTENSIONS:
        path = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
        if os.path.isfile(path):
            return path
    return None


def _clear_bg_files():
    """Remove any existing background image files."""
    for ext in ALLOWED_EXTENSIONS:
        path = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
        if os.path.isfile(path):
            os.remove(path)


@app.post("/api/map-background")
async def upload_map_background(file: UploadFile = File(...)):
    """Upload or replace the map background image."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")

    # Read and check size
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)} MB.")

    _clear_bg_files()

    dest = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
    with open(dest, "wb") as f:
        f.write(contents)

    return {"ok": True, "filename": file.filename, "size": len(contents)}


@app.get("/api/map-background")
def get_map_background():
    """Return the stored background image file."""
    path = _find_bg_file()
    if not path:
        raise HTTPException(404, "No background image set")
    return FileResponse(path)


@app.delete("/api/map-background")
def delete_map_background():
    """Remove the background image."""
    _clear_bg_files()
    return {"ok": True}


# ─── Map Settings ─────────────────────────────────────────────────────────────

MAP_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "map-settings.json")
DEFAULT_MAP_SETTINGS = {"opacity": 0.3, "scale": 1.0}


def _read_map_settings():
    try:
        with open(MAP_SETTINGS_PATH, "r") as f:
            return {**DEFAULT_MAP_SETTINGS, **json.load(f)}
    except (FileNotFoundError, json.JSONDecodeError):
        return {**DEFAULT_MAP_SETTINGS}


def _write_map_settings(data):
    merged = {**_read_map_settings(), **data}
    with open(MAP_SETTINGS_PATH, "w") as f:
        json.dump(merged, f)
    return merged


@app.get("/api/map-settings")
def get_map_settings():
    """Return persisted map background settings (opacity, scale)."""
    return _read_map_settings()


@app.put("/api/map-settings")
async def update_map_settings(request: Request):
    """Update map background settings."""
    body = await request.json()
    allowed = {}
    if "opacity" in body:
        allowed["opacity"] = float(body["opacity"])
    if "scale" in body:
        allowed["scale"] = float(body["scale"])
    return _write_map_settings(allowed)


# ─── Scan Settings ────────────────────────────────────────────────────────────

SCAN_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "scan-settings.json")
DEFAULT_SCAN_SETTINGS = {"max_workers": 4, "snmp_timeout": 3, "snmp_retries": 1}


def _normalize_scan_settings(value: dict | None):
    value = value or {}
    max_workers = value.get("max_workers", DEFAULT_SCAN_SETTINGS["max_workers"])
    snmp_timeout = value.get("snmp_timeout", DEFAULT_SCAN_SETTINGS["snmp_timeout"])
    snmp_retries = value.get("snmp_retries", DEFAULT_SCAN_SETTINGS["snmp_retries"])
    try:
        max_workers = int(max_workers)
        snmp_timeout = int(snmp_timeout)
        snmp_retries = int(snmp_retries)
    except (TypeError, ValueError):
        raise HTTPException(400, "Settings must be integers")
    max_workers = max(1, min(128, max_workers))
    snmp_timeout = max(1, min(30, snmp_timeout))
    snmp_retries = max(0, min(10, snmp_retries))
    return {"max_workers": max_workers, "snmp_timeout": snmp_timeout, "snmp_retries": snmp_retries}


def _read_scan_settings():
    try:
        with open(SCAN_SETTINGS_PATH, "r") as f:
            raw = json.load(f)
            return _normalize_scan_settings(raw)
    except (FileNotFoundError, json.JSONDecodeError):
        return {**DEFAULT_SCAN_SETTINGS}


def _write_scan_settings(value: dict | None):
    os.makedirs(os.path.dirname(SCAN_SETTINGS_PATH), exist_ok=True)
    payload = _normalize_scan_settings(value)
    with open(SCAN_SETTINGS_PATH, "w") as f:
        json.dump(payload, f)
    return payload


@app.get("/api/scan-settings")
def get_scan_settings():
    """Return scan execution settings."""
    return _read_scan_settings()


@app.put("/api/scan-settings")
async def update_scan_settings(request: Request):
    """Update scan execution settings."""
    body = await request.json()
    return _write_scan_settings(body)


# ─── Discovery Range Settings ─────────────────────────────────────────────────

@app.get("/api/discovery-ranges")
def get_discovery_ranges(db: Session = Depends(get_db)):
    """Return configured discovery scan ranges."""
    return {"ranges": _read_discovery_ranges(db)}


@app.put("/api/discovery-ranges")
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




DNS_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "dns-settings.json")
DEFAULT_DNS_SETTINGS = {"servers": []}


def _normalize_dns_servers(value) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(400, "'servers' must be an array of IP addresses")

    normalized: list[str] = []
    for item in value:
        server = str(item).strip()
        if not server:
            continue
        try:
            normalized.append(str(ipaddress.ip_address(server)))
        except ValueError:
            raise HTTPException(400, f"Invalid DNS server IP: {server}")

    # preserve order, remove duplicates
    return list(dict.fromkeys(normalized))


def _read_dns_settings():
    try:
        with open(DNS_SETTINGS_PATH, "r") as f:
            data = json.load(f)
            return {"servers": _normalize_dns_servers(data.get("servers", []))}
    except FileNotFoundError:
        return {**DEFAULT_DNS_SETTINGS}
    except json.JSONDecodeError:
        return {**DEFAULT_DNS_SETTINGS}


def _write_dns_settings(servers: list[str]):
    os.makedirs(os.path.dirname(DNS_SETTINGS_PATH), exist_ok=True)
    payload = {"servers": _normalize_dns_servers(servers)}
    with open(DNS_SETTINGS_PATH, "w") as f:
        json.dump(payload, f)
    return payload


@app.get("/api/dns-settings")
def get_dns_settings():
    """Return configured DNS servers for reverse lookups."""
    return _read_dns_settings()


@app.put("/api/dns-settings")
async def update_dns_settings(request: Request):
    """Update configured DNS servers for reverse lookups."""
    body = await request.json()
    return _write_dns_settings(body.get("servers", []))


@app.get("/api/logs")
def get_logs(limit: int = 200, level: str = "", event_prefix: str = "", q: str = ""):
    """Return recent structured backend logs."""
    clamped = max(1, min(2000, int(limit)))
    level_filter = level.strip().upper()
    event_filter = event_prefix.strip()
    query = q.strip().lower()
    with LOG_BUFFER_LOCK:
        rows = list(LOG_BUFFER)
    if level_filter:
        rows = [r for r in rows if str(r.get("level", "")).upper() == level_filter]
    if event_filter:
        rows = [r for r in rows if str(r.get("event", "")).startswith(event_filter)]
    if query:
        rows = [
            r for r in rows
            if query in json.dumps(r, ensure_ascii=False).lower()
        ]
    return rows[-clamped:]


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _ping_host(ip: str, timeout_sec: int = 1) -> tuple[bool, int]:
    """Best-effort ICMP ping via system command. Returns (reachable, rtt_ms)."""
    if not ip:
        return False, 0

    # Linux container default (Docker image), fallback command shape for Windows.
    cmds = [
        ["ping", "-c", "1", "-W", str(timeout_sec), ip],
        ["ping", "-n", "1", "-w", str(timeout_sec * 1000), ip],
    ]

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
        import re
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


