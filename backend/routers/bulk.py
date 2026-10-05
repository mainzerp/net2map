"""Bulk import/export endpoints for credentials and SNMP profiles."""
import csv
import io
import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import Credential, Device, SnmpProfile, get_db
from schemas import (
    MASK_EXPORT,
    MASK_SENTINELS,
    BulkExportOut,
    BulkImportError,
    BulkImportRequest,
    BulkImportResult,
    CredentialCreate,
    SnmpProfileCreate,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.crypto import encrypt
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
    "label", "ip", "priority", "snmp_port", "enabled",
    "snmp_version", "community",
    "v3_security_level", "v3_username",
    "v3_auth_protocol", "v3_auth_password",
    "v3_priv_protocol", "v3_priv_password",
    "profile_id", "device_id",
    "profile_label", "device_ip",
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


# Leading characters that spreadsheet applications interpret as a formula
# (OWASP CSV injection guidance).
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_escape_cell(value):
    """Neutralize a CSV cell against formula injection.

    Only string cells are touched; numbers and booleans are written as-is so
    e.g. negative integers are never quoted. Strings whose leading quotes are
    followed by a formula character also get one extra quote so the
    import-side unescape is an exact inverse.
    """
    if isinstance(value, str) and value.lstrip("'").startswith(_CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


def _csv_unescape_cell(value):
    """Inverse of ``_csv_escape_cell`` for cells read from a CSV import."""
    if (
        isinstance(value, str)
        and value.startswith("'")
        and value.lstrip("'").startswith(_CSV_FORMULA_PREFIXES)
    ):
        return value[1:]
    return value


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
        rows = [
            {k: _csv_unescape_cell(v) for k, v in (src or {}).items()}
            for src in reader
        ]

    normalized: List[dict] = []
    for src in rows:
        row = {k: v for k, v in (src or {}).items()}

        if kind == "credentials":
            for key in ["profile_id", "device_id", "snmp_port"]:
                if key in row:
                    row[key] = _normalize_optional_int(row.get(key))
            if "priority" in row:
                row["priority"] = _normalize_optional_int(row.get("priority"))
                if row["priority"] is None:
                    # Missing/empty priority (old exports) falls back to the
                    # schema default 0.
                    del row["priority"]
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
            # FK references exported by newer versions are not schema fields;
            # carry them through so the write phase can resolve them.
            if kind == "credentials":
                for alias in ("profile_label", "device_ip"):
                    if alias in row:
                        payload[alias] = row[alias]
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
        writer.writerow({k: _csv_escape_cell(row.get(k, "")) for k in fieldnames})
    return buf.getvalue()


@router.get("/bulk-export/{kind}", response_model=BulkExportOut,
            dependencies=[require_role("admin", "operator")])
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
            })
    else:
        rows = []
        for p in db.query(SnmpProfile).order_by(SnmpProfile.id).all():
            rows.append({
                "label": p.label,
                "snmp_version": p.snmp_version,
                "community": MASK_EXPORT if p.community else "",
                "v3_security_level": p.v3_security_level,
                "v3_username": p.v3_username,
                "v3_auth_protocol": p.v3_auth_protocol,
                "v3_auth_password": MASK_EXPORT if p.v3_auth_password else "",
                "v3_priv_protocol": p.v3_priv_protocol,
                "v3_priv_password": MASK_EXPORT if p.v3_priv_password else "",
            })

    return BulkExportOut(type=kind, format=fmt, data=_serialize_bulk_rows(kind, rows, fmt))


@router.post("/bulk-import/{kind}", response_model=BulkImportResult,
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

    _MASKED_SECRET_FIELDS = ("v3_auth_password", "v3_priv_password", "community")

    if not body.dry_run:
        if kind == "credentials":
            # Reference maps for resolving exported FK labels/ips; raw ids in
            # the payload remain the fallback when no label/ip was provided.
            profiles_by_label = {p.label: p.id for p in db.query(SnmpProfile).all()}
            devices_by_ip = {d.ip: d.id for d in db.query(Device).all()}
            for payload in valid_rows:
                profile_label = payload.pop("profile_label", None)
                device_ip = payload.pop("device_ip", None)
                masked_fields = {f for f in _MASKED_SECRET_FIELDS if payload.get(f) in MASK_SENTINELS}
                for pwd_field in _MASKED_SECRET_FIELDS:
                    if payload.get(pwd_field) and pwd_field not in masked_fields:
                        payload[pwd_field] = encrypt(payload[pwd_field])
                if profile_label is not None and str(profile_label).strip():
                    payload["profile_id"] = profiles_by_label.get(str(profile_label).strip())
                if device_ip is not None and str(device_ip).strip():
                    payload["device_id"] = devices_by_ip.get(str(device_ip).strip())
                if payload.get("device_id") is None:
                    # Same auto-link as create_credential: match the target IP
                    payload["device_id"] = devices_by_ip.get(payload["ip"])
                # Match on the unique key (ip, priority) like the config
                # import; rows without a priority field default to 0, which
                # preserves the old ip-only matching behaviour.
                existing = db.query(Credential).filter(
                    Credential.ip == payload["ip"],
                    Credential.priority == payload.get("priority", 0),
                ).first()
                if existing:
                    for key, value in payload.items():
                        if key in masked_fields:
                            continue
                        setattr(existing, key, value)
                    updated += 1
                else:
                    for field in masked_fields:
                        payload[field] = ""
                    db.add(Credential(**payload))
                    inserted += 1
        else:
            for payload in valid_rows:
                masked_fields = {f for f in _MASKED_SECRET_FIELDS if payload.get(f) in MASK_SENTINELS}
                for pwd_field in _MASKED_SECRET_FIELDS:
                    if payload.get(pwd_field) and pwd_field not in masked_fields:
                        payload[pwd_field] = encrypt(payload[pwd_field])
                existing = db.query(SnmpProfile).filter(SnmpProfile.label == payload["label"]).first()
                if existing:
                    for key, value in payload.items():
                        if key in masked_fields:
                            continue
                        setattr(existing, key, value)
                    updated += 1
                else:
                    for field in masked_fields:
                        payload[field] = ""
                    db.add(SnmpProfile(**payload))
                    inserted += 1
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            api_error(400, "IMPORT_INTEGRITY", "Import violated a database constraint (e.g. duplicate or dangling reference)")

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
