"""CRUD endpoints for SNMP credentials."""
from typing import List

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import Credential, Device, PingCandidate, get_db
from routers.topology import _bump_topo_version
from schemas import (
    CredentialCreate,
    CredentialOut,
    CredentialUpdate,
    PingOnlyAdoptRequest,
    PingOnlyAdoptResult,
    validate_credential_ip,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.crypto import encrypt
from shared.errors import api_error
from shared.ping_only import upsert_ping_only_device
from shared.secrets import normalize_mask_sentinels, strip_mask_sentinels

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

@router.get("/credentials", response_model=List[CredentialOut])
def list_credentials(db: Session = Depends(get_db)):
    return db.query(Credential).order_by(Credential.id).all()


@router.post("/credentials", response_model=CredentialOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def create_credential(body: CredentialCreate, request: Request, db: Session = Depends(get_db)):
    existing = db.query(Credential).filter(
        Credential.ip == body.ip, Credential.priority == body.priority
    ).first()
    if existing:
        api_error(400, "CREDENTIAL_IP_PRIORITY_EXISTS",
                  f"IP {body.ip} with priority {body.priority} already exists",
                  field="ip")
    data = body.model_dump()
    normalize_mask_sentinels(data)
    if data.get("community"):
        data["community"] = encrypt(data["community"])
    if data.get("v3_auth_password"):
        data["v3_auth_password"] = encrypt(data["v3_auth_password"])
    if data.get("v3_priv_password"):
        data["v3_priv_password"] = encrypt(data["v3_priv_password"])
    cred = Credential(**data)
    db.add(cred)

    # Auto-link to device by IP if device_id not explicitly set
    if not cred.device_id:
        device = db.query(Device).filter(Device.ip == body.ip).first()
        if device:
            cred.device_id = device.id

    db.flush()
    log_audit(request, "create", "credential", str(cred.id),
              {"ip": cred.ip, "label": cred.label, "snmp_enabled": bool(cred.snmp_enabled)}, db=db, strict=True)
    db.commit()
    db.refresh(cred)
    _bump_topo_version()
    return cred


def _new_device_position(index: int) -> tuple:
    """Map position for the n-th device created by one adoption batch (small grid)."""
    return 100.0 + 60.0 * (index % 10), 100.0 + 60.0 * (index // 10)


@router.post("/credentials/ping-only", response_model=PingOnlyAdoptResult,
             dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def create_ping_only_credentials(body: PingOnlyAdoptRequest, request: Request, db: Session = Depends(get_db)):
    """Register hosts as ping-only devices (credential snmp_enabled=False).

    Each entry is validated on its own: invalid IPs, IPs that already have a
    credential and repeats within the batch are skipped with a reason. For
    every created credential the Device is created (ping_status "unknown"
    until the next scan) or an existing Device is marked ping_only; a matching
    ping candidate is removed.
    """
    created: list = []
    skipped: list = []
    seen: set = set()
    for entry in body.entries:
        raw_ip = entry.ip if isinstance(entry.ip, str) else ""
        try:
            ip = validate_credential_ip(raw_ip)
        except ValueError:
            skipped.append({"ip": raw_ip, "reason": "invalid"})
            continue
        if ip in seen:
            skipped.append({"ip": ip, "reason": "duplicate"})
            continue
        seen.add(ip)
        if db.query(Credential.id).filter(Credential.ip == ip).first():
            skipped.append({"ip": ip, "reason": "exists"})
            continue
        label = (entry.label or "").strip()
        cred = Credential(ip=ip, label=label, enabled=True, snmp_enabled=False)
        db.add(cred)
        db.flush()
        device = db.query(Device).filter(Device.ip == ip).first()
        device = upsert_ping_only_device(
            db, ip, device, cred, label, None, 0, _new_device_position(len(created)),
        )
        db.query(PingCandidate).filter(PingCandidate.ip == ip).delete(synchronize_session=False)
        log_audit(request, "create", "credential", str(cred.id),
                  {"ip": ip, "label": label, "snmp_enabled": False, "ping_only": True}, db=db, strict=True)
        created.append({"ip": ip, "credential_id": cred.id, "device_id": device.id})
    db.commit()
    if created:
        _bump_topo_version()
    return {"created": created, "skipped": skipped}


@router.put("/credentials/{cred_id}", response_model=CredentialOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_credential(cred_id: int, body: CredentialUpdate, request: Request, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
    updates = body.model_dump(exclude_unset=True)
    strip_mask_sentinels(updates)
    if updates.get("snmp_enabled", True) is None:
        # NOT NULL column: an explicit null leaves the flag unchanged
        del updates["snmp_enabled"]
    if "community" in updates and updates["community"]:
        updates["community"] = encrypt(updates["community"])
    if "v3_auth_password" in updates and updates["v3_auth_password"]:
        updates["v3_auth_password"] = encrypt(updates["v3_auth_password"])
    if "v3_priv_password" in updates and updates["v3_priv_password"]:
        updates["v3_priv_password"] = encrypt(updates["v3_priv_password"])

    for k, v in updates.items():
        setattr(cred, k, v)

    log_audit(request, "update", "credential", str(cred_id), {"fields": list(updates.keys())}, db=db, strict=True)
    db.commit()
    db.refresh(cred)
    _bump_topo_version()
    return cred


@router.delete("/credentials/{cred_id}", status_code=204,
               dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def delete_credential(cred_id: int, request: Request, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
    log_audit(request, "delete", "credential", str(cred_id), {"ip": cred.ip, "label": cred.label}, db=db, strict=True)
    db.delete(cred)
    db.commit()
    _bump_topo_version()
