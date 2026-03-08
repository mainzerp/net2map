"""CRUD endpoints for SNMP profiles."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Credential, SnmpProfile, get_db
from schemas import SnmpProfileCreate, SnmpProfileOut, SnmpProfileUpdate
from shared.auth import require_role
from shared.audit import log_audit
from shared.crypto import encrypt
from shared.errors import api_error

router = APIRouter()


@router.get("/api/snmp-profiles", response_model=List[SnmpProfileOut])
def list_snmp_profiles(db: Session = Depends(get_db)):
    return db.query(SnmpProfile).order_by(SnmpProfile.id).all()


@router.post("/api/snmp-profiles", response_model=SnmpProfileOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_snmp_profile(body: SnmpProfileCreate, request: Request, db: Session = Depends(get_db)):
    payload = body.model_dump()
    if payload.get("v3_auth_password"):
        payload["v3_auth_password"] = encrypt(payload["v3_auth_password"])
    if payload.get("v3_priv_password"):
        payload["v3_priv_password"] = encrypt(payload["v3_priv_password"])
    profile = SnmpProfile(**payload)
    db.add(profile)
    db.commit()
    db.refresh(profile)
    log_audit(request, "create", "snmp_profile", str(profile.id), {"label": profile.label})
    return profile


@router.put("/api/snmp-profiles/{profile_id}", response_model=SnmpProfileOut,
            dependencies=[require_role("admin", "operator")])
def update_snmp_profile(profile_id: int, body: SnmpProfileUpdate, request: Request, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        api_error(404, "PROFILE_NOT_FOUND", "Profile not found")
    payload = body.model_dump(exclude_none=True)

    if "v3_auth_password" in payload and payload["v3_auth_password"]:
        payload["v3_auth_password"] = encrypt(payload["v3_auth_password"])
    if "v3_priv_password" in payload and payload["v3_priv_password"]:
        payload["v3_priv_password"] = encrypt(payload["v3_priv_password"])

    for k, v in payload.items():
        setattr(profile, k, v)

    # Credentials with profile_id inherit SNMP settings directly from the profile at scan time.
    # No need to copy fields to linked credentials.

    db.commit()
    db.refresh(profile)
    log_audit(request, "update", "snmp_profile", str(profile_id), {"fields": list(payload.keys())})
    return profile


@router.delete("/api/snmp-profiles/{profile_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_snmp_profile(profile_id: int, request: Request, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        api_error(404, "PROFILE_NOT_FOUND", "Profile not found")
    # Detach credentials that use this profile before deleting
    db.query(Credential).filter(Credential.profile_id == profile_id).update({"profile_id": None})
    log_audit(request, "delete", "snmp_profile", str(profile_id), {"label": profile.label})
    db.delete(profile)
    db.commit()
