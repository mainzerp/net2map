"""Global config export/import endpoints."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import AppSetting, Credential, Device, ScanRange, SnmpProfile, get_db
from routers.bulk import _normalize_bool, _normalize_optional_int, normalize_snmp_enabled
from schemas import (
    MASK_EXPORT,
    CredentialCreate,
    GlobalConfigExportOut,
    GlobalConfigImportRequest,
    ScanRangeCreate,
    SnmpProfileCreate,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.crypto import encrypt
from shared.errors import api_error
from shared.scan_ranges import ScanRangeError, clean_profile_ids, normalize_scan_range
from shared.secrets import SECRET_FIELDS, masked_secret_fields

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

_LEGACY_RANGES_KEY = "discovery_scan_ranges"


def _legacy_range_cidrs(raw: str) -> list:
    """Normalized CIDRs of a legacy discovery_scan_ranges JSON list (invalid entries skipped)."""
    try:
        value = json.loads(raw or "[]")
    except ValueError:
        return []
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        try:
            cidr = normalize_scan_range(item)
        except ScanRangeError:
            continue
        if cidr not in result:
            result.append(cidr)
    return result


def _validate_scan_range_row(row) -> dict:
    """Validate one exported scan range; raises ValueError with a readable message."""
    if not isinstance(row, dict):
        raise ValueError("scan range must be an object")
    cidr = normalize_scan_range(row.get("cidr"))
    base = ScanRangeCreate(
        cidr=cidr,
        label=str(row.get("label") or ""),
        enabled=_normalize_bool(row.get("enabled", True)),
        interval_sec=_normalize_optional_int(row.get("interval_sec")),
    )
    labels = row.get("profile_labels")
    if labels is not None:
        if not isinstance(labels, list):
            raise ValueError("profile_labels must be an array")
        labels = [str(label).strip() for label in labels if str(label).strip()]
    return {
        "cidr": cidr,
        "label": base.label.strip(),
        "enabled": base.enabled,
        "interval_sec": base.interval_sec,
        "profile_labels": labels,
    }


@router.get("/config/export", response_model=GlobalConfigExportOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def export_global_config(request: Request, db: Session = Depends(get_db)):
    profile_labels_by_id = {p.id: p.label for p in db.query(SnmpProfile).all()}
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
                "snmp_enabled": c.snmp_enabled is not False,
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
        "scan_ranges": [
            {
                "cidr": r.cidr,
                "label": r.label or "",
                "enabled": bool(r.enabled),
                "interval_sec": r.interval_sec,
                # Profiles are referenced by label: ids differ between databases.
                "profile_labels": [
                    profile_labels_by_id[pid] for pid in clean_profile_ids(r.profile_ids)
                    if pid in profile_labels_by_id
                ],
            }
            for r in db.query(ScanRange).order_by(ScanRange.cidr).all()
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
    scan_range_rows = payload.get("scan_ranges")
    if scan_range_rows is None:
        scan_range_rows = []
    elif not isinstance(scan_range_rows, list):
        api_error(400, "INVALID_CONFIG_ARRAYS", "scan_ranges must be an array")

    if not isinstance(settings_rows, list) or not isinstance(profile_rows, list) or not isinstance(credential_rows, list):
        api_error(400, "INVALID_CONFIG_ARRAYS", "settings/profiles/credentials must be arrays")

    errors = []
    valid_settings = []
    valid_profiles = []
    valid_credentials = []
    # Normalized cidr -> validated scan range row (later rows win).
    valid_scan_ranges: dict = {}
    # CIDRs from a legacy "discovery_scan_ranges" settings row: only inserted
    # when missing, never written to app_settings.
    legacy_range_cidrs: list = []

    for i, row in enumerate(settings_rows, start=1):
        try:
            key = str(row.get("key", "")).strip()
            value = str(row.get("value", ""))
            if not key:
                raise ValueError("missing key")
            if key == _LEGACY_RANGES_KEY:
                legacy_range_cidrs.extend(_legacy_range_cidrs(value))
                continue
            valid_settings.append({"key": key, "value": value})
        except Exception as exc:
            errors.append({"section": "settings", "row": i, "message": str(exc)})

    for i, row in enumerate(scan_range_rows, start=1):
        try:
            valid = _validate_scan_range_row(row)
            valid_scan_ranges[valid["cidr"]] = valid
        except Exception as exc:
            errors.append({"section": "scan_ranges", "row": i, "message": str(exc)})
    for cidr in legacy_range_cidrs:
        valid_scan_ranges.setdefault(cidr, {"cidr": cidr, "legacy": True})

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
            normalize_snmp_enabled(normalized)
            validated = CredentialCreate(**normalized).model_dump()
            # FK references exported by newer versions are not schema fields;
            # carry them through so the write phase can resolve them.
            for alias in ("profile_label", "device_ip"):
                if alias in normalized:
                    validated[alias] = normalized[alias]
            valid_credentials.append(validated)
        except Exception as exc:
            errors.append({"section": "credentials", "row": i, "message": str(exc)})

    inserted = {"settings": 0, "profiles": 0, "credentials": 0, "scan_ranges": 0}
    updated = {"settings": 0, "profiles": 0, "credentials": 0, "scan_ranges": 0}

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
            masked_fields = masked_secret_fields(row)
            for pwd_field in SECRET_FIELDS:
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

        # New profiles need their ids before labels can be resolved.
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            api_error(400, "IMPORT_INTEGRITY", "Import violated a database constraint (e.g. duplicate or dangling reference)")

        # Reference maps for resolving exported FK labels/ips; raw ids in the
        # payload remain the fallback when no label/ip was provided.
        profiles_by_label = {p.label: p.id for p in db.query(SnmpProfile).all()}
        devices_by_ip = {d.ip: d.id for d in db.query(Device).all()}
        for row in valid_credentials:
            profile_label = row.pop("profile_label", None)
            device_ip = row.pop("device_ip", None)
            masked_fields = masked_secret_fields(row)
            for pwd_field in SECRET_FIELDS:
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

        existing_ranges = {r.cidr: r for r in db.query(ScanRange).all()}
        for cidr, row in valid_scan_ranges.items():
            existing = existing_ranges.get(cidr)
            if row.get("legacy"):
                if existing is None:
                    db.add(ScanRange(cidr=cidr, label="", enabled=True))
                    inserted["scan_ranges"] += 1
                continue
            fields = {
                "label": row["label"],
                "enabled": row["enabled"],
                "interval_sec": row["interval_sec"],
            }
            if row["profile_labels"] is not None:
                # Unknown labels are dropped (profile not part of this database).
                fields["profile_ids"] = list(dict.fromkeys(
                    profiles_by_label[label] for label in row["profile_labels"] if label in profiles_by_label
                ))
            if existing is not None:
                for key, value in fields.items():
                    setattr(existing, key, value)
                updated["scan_ranges"] += 1
            else:
                fields.setdefault("profile_ids", [])
                db.add(ScanRange(cidr=cidr, **fields))
                inserted["scan_ranges"] += 1

        # Written in the import transaction: no import without its audit record.
        log_audit(request, "import", "global_config", "", {
            "inserted": inserted, "updated": updated,
        }, db=db, strict=True)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            api_error(400, "IMPORT_INTEGRITY", "Import violated a database constraint (e.g. duplicate or dangling reference)")

    return {
        "dry_run": bool(body.dry_run),
        "totals": {
            "settings": len(valid_settings),
            "profiles": len(valid_profiles),
            "credentials": len(valid_credentials),
            "scan_ranges": len(valid_scan_ranges),
        },
        "inserted": inserted,
        "updated": updated,
        "errors": errors,
    }
