"""Global config export/import endpoints."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import AppSetting, Credential, SnmpProfile, get_db
from routers.bulk import _normalize_bool, _normalize_optional_int
from schemas import CredentialCreate, GlobalConfigExportOut, GlobalConfigImportRequest, SnmpProfileCreate
from shared.auth import require_role
from shared.audit import log_audit
from shared.crypto import encrypt
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.get("/api/config/export", response_model=GlobalConfigExportOut)
@limiter.limit("10/minute")
def export_global_config(request: Request, db: Session = Depends(get_db)):
    payload = {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat() + "Z",
        "settings": [
            {"key": s.key, "value": s.value}
            for s in db.query(AppSetting).order_by(AppSetting.key).all()
        ],
        "profiles": [
            {
                "label": p.label,
                "snmp_version": p.snmp_version,
                "community": "********" if p.community else "",
                "v3_security_level": p.v3_security_level,
                "v3_username": p.v3_username,
                "v3_auth_protocol": p.v3_auth_protocol,
                "v3_auth_password": "********" if p.v3_auth_password else "",
                "v3_priv_protocol": p.v3_priv_protocol,
                "v3_priv_password": "********" if p.v3_priv_password else "",
            }
            for p in db.query(SnmpProfile).order_by(SnmpProfile.id).all()
        ],
        "credentials": [
            {
                "label": c.label,
                "ip": c.ip,
                "snmp_port": c.snmp_port,
                "enabled": bool(c.enabled),
                "snmp_version": c.snmp_version,
                "community": "********" if c.community else "",
                "v3_security_level": c.v3_security_level,
                "v3_username": c.v3_username,
                "v3_auth_protocol": c.v3_auth_protocol,
                "v3_auth_password": "********" if c.v3_auth_password else "",
                "v3_priv_protocol": c.v3_priv_protocol,
                "v3_priv_password": "********" if c.v3_priv_password else "",
                "profile_id": c.profile_id,
                "device_id": c.device_id,
            }
            for c in db.query(Credential).order_by(Credential.id).all()
        ],
    }
    return GlobalConfigExportOut(data=json.dumps(payload, ensure_ascii=False, indent=2))


@router.post("/api/config/import",
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

        _PASSWORD_MASK = "********"
        for row in valid_profiles:
            for pwd_field in ("v3_auth_password", "v3_priv_password"):
                if row.get(pwd_field) and row[pwd_field] != _PASSWORD_MASK:
                    row[pwd_field] = encrypt(row[pwd_field])
            existing = db.query(SnmpProfile).filter(SnmpProfile.label == row["label"]).first()
            if existing:
                for key, value in row.items():
                    if key in ("v3_auth_password", "v3_priv_password", "community") and value == _PASSWORD_MASK:
                        continue
                    setattr(existing, key, value)
                updated["profiles"] += 1
            else:
                db.add(SnmpProfile(**row))
                inserted["profiles"] += 1

        for row in valid_credentials:
            for pwd_field in ("v3_auth_password", "v3_priv_password"):
                if row.get(pwd_field) and row[pwd_field] != _PASSWORD_MASK:
                    row[pwd_field] = encrypt(row[pwd_field])
            existing = db.query(Credential).filter(Credential.ip == row["ip"]).first()
            if existing:
                for key, value in row.items():
                    if key in ("v3_auth_password", "v3_priv_password", "community") and value == _PASSWORD_MASK:
                        continue
                    setattr(existing, key, value)
                updated["credentials"] += 1
            else:
                db.add(Credential(**row))
                inserted["credentials"] += 1

        db.commit()

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
