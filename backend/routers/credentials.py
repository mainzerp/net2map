"""CRUD endpoints for SNMP credentials."""
from typing import List

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import Credential, Device, get_db
from routers.topology import _bump_topo_version
from schemas import CredentialCreate, CredentialOut, CredentialUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.crypto import encrypt
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.get("/api/credentials", response_model=List[CredentialOut])
def list_credentials(db: Session = Depends(get_db)):
    return db.query(Credential).order_by(Credential.id).all()


@router.post("/api/credentials", response_model=CredentialOut, status_code=201,
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

    db.commit()
    db.refresh(cred)
    _bump_topo_version()
    log_audit(request, "create", "credential", str(cred.id), {"ip": cred.ip, "label": cred.label})
    return cred


@router.put("/api/credentials/{cred_id}", response_model=CredentialOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_credential(cred_id: int, body: CredentialUpdate, request: Request, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
    updates = body.model_dump(exclude_unset=True)
    if "v3_auth_password" in updates and updates["v3_auth_password"]:
        updates["v3_auth_password"] = encrypt(updates["v3_auth_password"])
    if "v3_priv_password" in updates and updates["v3_priv_password"]:
        updates["v3_priv_password"] = encrypt(updates["v3_priv_password"])

    for k, v in updates.items():
        setattr(cred, k, v)

    db.commit()
    db.refresh(cred)
    _bump_topo_version()
    log_audit(request, "update", "credential", str(cred_id), {"fields": list(updates.keys())})
    return cred


@router.delete("/api/credentials/{cred_id}", status_code=204,
               dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def delete_credential(cred_id: int, request: Request, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
    log_audit(request, "delete", "credential", str(cred_id), {"ip": cred.ip, "label": cred.label})
    db.delete(cred)
    db.commit()
    _bump_topo_version()
