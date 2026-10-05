"""Global config export/import endpoints."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import AppSetting, Credential, Device, SnmpProfile, get_db
from routers.bulk import _normalize_bool, _normalize_optional_int
from schemas import (
    MASK_EXPORT,
    MASK_SENTINELS,
    CredentialCreate,
    GlobalConfigExportOut,
    GlobalConfigImportRequest,
    SnmpProfileCreate,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.crypto import encrypt
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.get("/config/export", response_model=GlobalConfigExportOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def export_global_config(request: Request, db: Session = Depends(get_db)):
    payload = {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "settings": [
            {"key": s.key, "value": s.value}
            for s in db.query(AppSetting).order_by(AppSetting.key).all()
        ],
        "profiles": [
            {
                "label": p.label,
                "snmp_version": p.snmp_version,
                "community": MASK_EXPORT if p.community else "",
                "v3_security_level": p.v3_security_level,
                "v3_username": p.v3_username,
                "v3_auth_protocol": p.v3_auth_protocol,
                "v3_auth_password": MASK_EXPORT if p.v3_auth_password else "",
                "v3_priv_protocol": p.v3_priv_protocol,
                "v3_priv_password": MASK_EXPORT if p.v3_priv_password else "",
            }
            for p in db.query(SnmpProfile).order_by(SnmpProfile.id).all()
        ],
        "credentials": [
            {
                "label": c.label,
                "ip": c.ip,
                "priority": c.priority,
                "snmp_port": c.snmp_port,
                "enabled": bool(c.enabled),
                "snmp_version": c.snmp_version,
                "community": MASK_EXPORT if c.community else "",
                "v3_security_level": c.v3_security_level,
                "v3_username": c.v3_username,
                "v3_auth_protocol": c.v3_auth_protocol,
                "v3_auth_password": MASK_EXPORT if c.v3_auth_password else "",
                "v3_priv_protocol": c.v3_priv_protocol,
                "v3_priv_password": MASK_EXPORT if c.v3_priv_password else "",
                "profile_id": c.profile_id,
                "device_id": c.device_id,
                # Human-readable FK references so an import can resolve them
                # on a different database where raw ids differ.
                "profile_label": c.profile.label if c.profile else None,
                "device_ip": c.device.ip if c.device else None,
            }
            for c in db.query(Credential).order_by(Credential.id).all()
        ],
    }
    return GlobalConfigExportOut(data=json.dumps(payload, ensure_ascii=False, indent=2))


@router.post("/config/import",
             dependencies=[require_role("admin")])
def import_global_config(body: GlobalConfigImportRequest, request: Request, db: Session = Depends(get_db)):
    try:
        payload = json.loads(body.data or "{}")
    except Exception as exc:
        api_error(400, "INVALID_JSON", f"Invalid JSON payload: {exc}")

    if not isinstance(payload, dict):
        api_error(400, "INVALID_CONFIG", "Config payload must be a JSON object")

    settings_rows = payload.get("settings") or []
    profile_rows = payload.get("profiles") or []
    credential_rows = payload.get("credentials") or []

    if not isinstance(settings_rows, list) or not isinstance(profile_rows, list) or not isinstance(credential_rows, list):
        api_error(400, "INVALID_CONFIG_ARRAYS", "settings/profiles/credentials must be arrays")

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
            for key in ["profile_id", "device_id", "snmp_port"]:
                if key in normalized:
                    normalized[key] = _normalize_optional_int(normalized.get(key))
            if "enabled" in normalized:
                normalized["enabled"] = _normalize_bool(normalized.get("enabled"))
            validated = CredentialCreate(**normalized).model_dump()
            # FK references exported by newer versions are not schema fields;
            # carry them through so the write phase can resolve them.
            for alias in ("profile_label", "device_ip"):
                if alias in normalized:
                    validated[alias] = normalized[alias]
            valid_credentials.append(validated)
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

        _MASKED_SECRET_FIELDS = ("v3_auth_password", "v3_priv_password", "community")
        for row in valid_profiles:
            masked_fields = {f for f in _MASKED_SECRET_FIELDS if row.get(f) in MASK_SENTINELS}
            for pwd_field in _MASKED_SECRET_FIELDS:
                if row.get(pwd_field) and pwd_field not in masked_fields:
                    row[pwd_field] = encrypt(row[pwd_field])
            existing = db.query(SnmpProfile).filter(SnmpProfile.label == row["label"]).first()
            if existing:
                for key, value in row.items():
                    if key in masked_fields:
                        continue
                    setattr(existing, key, value)
                updated["profiles"] += 1
            else:
                for field in masked_fields:
                    row[field] = ""
                db.add(SnmpProfile(**row))
                inserted["profiles"] += 1

        # Reference maps for resolving exported FK labels/ips; raw ids in the
        # payload remain the fallback when no label/ip was provided.
        profiles_by_label = {p.label: p.id for p in db.query(SnmpProfile).all()}
        devices_by_ip = {d.ip: d.id for d in db.query(Device).all()}
        for row in valid_credentials:
            profile_label = row.pop("profile_label", None)
            device_ip = row.pop("device_ip", None)
            masked_fields = {f for f in _MASKED_SECRET_FIELDS if row.get(f) in MASK_SENTINELS}
            for pwd_field in _MASKED_SECRET_FIELDS:
                if row.get(pwd_field) and pwd_field not in masked_fields:
                    row[pwd_field] = encrypt(row[pwd_field])
            if profile_label is not None and str(profile_label).strip():
                row["profile_id"] = profiles_by_label.get(str(profile_label).strip())
            if device_ip is not None and str(device_ip).strip():
                row["device_id"] = devices_by_ip.get(str(device_ip).strip())
            if row.get("device_id") is None:
                # Same auto-link as create_credential: match the target IP
                row["device_id"] = devices_by_ip.get(row["ip"])
            existing = db.query(Credential).filter(
                Credential.ip == row["ip"], Credential.priority == row.get("priority", 0)
            ).first()
            if existing:
                for key, value in row.items():
                    if key in masked_fields:
                        continue
                    setattr(existing, key, value)
                updated["credentials"] += 1
            else:
                for field in masked_fields:
                    row[field] = ""
                db.add(Credential(**row))
                inserted["credentials"] += 1

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            api_error(400, "IMPORT_INTEGRITY", "Import violated a database constraint (e.g. duplicate or dangling reference)")

    if not body.dry_run and not errors:
        log_audit(request, "import", "global_config", "", {
            "inserted": inserted, "updated": updated,
        })

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
