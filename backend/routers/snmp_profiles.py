"""CRUD endpoints for SNMP profiles."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Credential, SnmpProfile, get_db
from schemas import SnmpProfileCreate, SnmpProfileOut, SnmpProfileUpdate

router = APIRouter()


@router.get("/api/snmp-profiles", response_model=List[SnmpProfileOut])
def list_snmp_profiles(db: Session = Depends(get_db)):
    return db.query(SnmpProfile).order_by(SnmpProfile.id).all()


@router.post("/api/snmp-profiles", response_model=SnmpProfileOut, status_code=201)
def create_snmp_profile(body: SnmpProfileCreate, db: Session = Depends(get_db)):
    payload = body.model_dump()
    profile = SnmpProfile(**payload)
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@router.put("/api/snmp-profiles/{profile_id}", response_model=SnmpProfileOut)
def update_snmp_profile(profile_id: int, body: SnmpProfileUpdate, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    payload = body.model_dump(exclude_none=True)

    for k, v in payload.items():
        setattr(profile, k, v)

    # Credentials with profile_id inherit SNMP settings directly from the profile at scan time.
    # No need to copy fields to linked credentials.

    db.commit()
    db.refresh(profile)
    return profile


@router.delete("/api/snmp-profiles/{profile_id}", status_code=204)
def delete_snmp_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    # Detach credentials that use this profile before deleting
    db.query(Credential).filter(Credential.profile_id == profile_id).update({"profile_id": None})
    db.delete(profile)
    db.commit()
