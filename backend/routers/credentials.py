"""CRUD endpoints for SNMP credentials."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Credential, Device, get_db
from schemas import CredentialCreate, CredentialOut, CredentialUpdate

router = APIRouter()


@router.get("/api/credentials", response_model=List[CredentialOut])
def list_credentials(db: Session = Depends(get_db)):
    return db.query(Credential).order_by(Credential.id).all()


@router.post("/api/credentials", response_model=CredentialOut, status_code=201)
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


@router.put("/api/credentials/{cred_id}", response_model=CredentialOut)
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


@router.delete("/api/credentials/{cred_id}", status_code=204)
def delete_credential(cred_id: int, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        raise HTTPException(404, "Credential not found")
    db.delete(cred)
    db.commit()
