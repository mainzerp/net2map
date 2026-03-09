"""Bulk import/export endpoints for credentials and SNMP profiles."""
import csv
import io
import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import Credential, SnmpProfile, get_db
from schemas import (
    BulkExportOut,
    BulkImportError,
    BulkImportRequest,
    BulkImportResult,
    CredentialCreate,
    SnmpProfileCreate,
)
from shared.auth import require_role
from shared.audit import log_audit
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

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
            raise HTTPException(400, detail={"error": {"code": "INVALID_IMPORT_PAYLOAD", "message": "JSON import requires an array or {items:[...]} payload"}})
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


@router.get("/api/bulk-export/{kind}", response_model=BulkExportOut)
@limiter.limit("10/minute")
def bulk_export(kind: str, request: Request, fmt: str = "json", db: Session = Depends(get_db)):
    if kind not in {"credentials", "profiles"}:
        api_error(400, "INVALID_KIND", "kind must be 'credentials' or 'profiles'", field="kind")
    fmt = (fmt or "json").lower()
    if fmt not in {"json", "csv"}:
        api_error(400, "INVALID_FORMAT", "format must be 'json' or 'csv'", field="format")

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
                "v3_auth_password": "********" if c.v3_auth_password else "",
                "v3_priv_protocol": c.v3_priv_protocol,
                "v3_priv_password": "********" if c.v3_priv_password else "",
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
                "v3_auth_password": "********" if p.v3_auth_password else "",
                "v3_priv_protocol": p.v3_priv_protocol,
                "v3_priv_password": "********" if p.v3_priv_password else "",
            })

    return BulkExportOut(type=kind, format=fmt, data=_serialize_bulk_rows(kind, rows, fmt))


@router.post("/api/bulk-import/{kind}", response_model=BulkImportResult,
             dependencies=[require_role("admin")])
def bulk_import(kind: str, body: BulkImportRequest, request: Request, db: Session = Depends(get_db)):
    if kind not in {"credentials", "profiles"}:
        api_error(400, "INVALID_KIND", "kind must be 'credentials' or 'profiles'", field="kind")

    try:
        parsed_rows = _parse_bulk_rows(kind, body)
    except HTTPException:
        raise
    except Exception as exc:
        api_error(400, "INVALID_IMPORT_PAYLOAD", f"Invalid import payload: {exc}")

    valid_rows, errors = _validate_bulk_rows(kind, parsed_rows)
    inserted = 0
    updated = 0

    _PASSWORD_MASK = "********"

    if not body.dry_run:
        if kind == "credentials":
            for payload in valid_rows:
                existing = db.query(Credential).filter(Credential.ip == payload["ip"]).first()
                if existing:
                    for key, value in payload.items():
                        if key in ("v3_auth_password", "v3_priv_password") and value == _PASSWORD_MASK:
                            continue
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
                        if key in ("v3_auth_password", "v3_priv_password") and value == _PASSWORD_MASK:
                            continue
                        setattr(existing, key, value)
                    updated += 1
                else:
                    db.add(SnmpProfile(**payload))
                    inserted += 1
        db.commit()

    if not body.dry_run:
        log_audit(request, "import", f"bulk_{kind}", "", {
            "inserted": inserted, "updated": updated, "total_rows": len(parsed_rows),
        })

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
