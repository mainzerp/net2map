"""CRUD endpoints for SNMP credentials."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Credential, Device, get_db
from database import Rack as RackModel
from database import SwitchClass as SwitchClassModel
from schemas import CredentialCreate, CredentialOut, CredentialUpdate
from shared.auth import require_role
from shared.audit import log_audit
from shared.crypto import encrypt
from shared.errors import api_error

router = APIRouter()


@router.get("/api/credentials", response_model=List[CredentialOut])
def list_credentials(db: Session = Depends(get_db)):
    return db.query(Credential).order_by(Credential.id).all()


@router.post("/api/credentials", response_model=CredentialOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
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

    # If device already exists, update its rack/class
    device = db.query(Device).filter(Device.ip == body.ip).first()
    if device:
        if cred.rack_id is not None:
            device.rack_id = cred.rack_id
        if cred.class_id is not None:
            device.class_id = cred.class_id

    db.commit()
    db.refresh(cred)
    log_audit(request, "create", "credential", str(cred.id), {"ip": cred.ip, "label": cred.label})
    return cred


@router.put("/api/credentials/{cred_id}", response_model=CredentialOut,
            dependencies=[require_role("admin", "operator")])
def update_credential(cred_id: int, body: CredentialUpdate, request: Request, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
    updates = body.model_dump(exclude_unset=True)
    if "v3_auth_password" in updates and updates["v3_auth_password"]:
        updates["v3_auth_password"] = encrypt(updates["v3_auth_password"])
    if "v3_priv_password" in updates and updates["v3_priv_password"]:
        updates["v3_priv_password"] = encrypt(updates["v3_priv_password"])

    if "rack_id" in updates and updates["rack_id"] is not None:
        rack = db.query(RackModel).filter(RackModel.id == updates["rack_id"]).first()
        if not rack:
            api_error(404, "RACK_NOT_FOUND", "Rack not found")

    if "class_id" in updates and updates["class_id"] is not None:
        switch_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == updates["class_id"]).first()
        if not switch_class:
            api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")

    device = db.query(Device).filter(Device.ip == cred.ip).first()
    if device and ("rack_id" in updates or "class_id" in updates):
        target_rack_id = updates["rack_id"] if "rack_id" in updates else device.rack_id
        target_class_id = updates["class_id"] if "class_id" in updates else device.class_id
        target_class = None
        if target_class_id is not None:
            target_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == target_class_id).first()
            if not target_class:
                api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")
        if target_rack_id is None:
            if target_class_id is None:
                api_error(400, "UNRACKED_REQUIRES_CLASS", "Unracked devices require a switch class that allows outside-rack placement")
            if not target_class.allow_outside_rack:
                api_error(400, "CLASS_REQUIRES_RACK", "Selected switch class requires rack assignment")

    for k, v in updates.items():
        setattr(cred, k, v)

    # If device exists, update its rack/class
    if device:
        if "rack_id" in updates:
            device.rack_id = cred.rack_id
        if "class_id" in updates:
            device.class_id = cred.class_id

    db.commit()
    db.refresh(cred)
    log_audit(request, "update", "credential", str(cred_id), {"fields": list(updates.keys())})
    return cred


@router.delete("/api/credentials/{cred_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_credential(cred_id: int, request: Request, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
    log_audit(request, "delete", "credential", str(cred_id), {"ip": cred.ip, "label": cred.label})
    db.delete(cred)
    db.commit()
