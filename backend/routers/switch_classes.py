"""CRUD endpoints for switch classes."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Device, get_db
from database import SwitchClass as SwitchClassModel
from routers.topology import _bump_topo_version
from schemas import SwitchClassCreate, SwitchClassOut, SwitchClassUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()


@router.get("/switch-classes", response_model=List[SwitchClassOut])
def list_switch_classes(db: Session = Depends(get_db)):
    return db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()


@router.post("/switch-classes", response_model=SwitchClassOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_switch_class(body: SwitchClassCreate, request: Request, db: Session = Depends(get_db)):
    sc = SwitchClassModel(**body.model_dump())
    db.add(sc)
    db.commit()
    db.refresh(sc)
    _bump_topo_version()
    log_audit(request, "create", "switch_class", str(sc.id), {"label": sc.label})
    return sc


@router.put("/switch-classes/{class_id}", response_model=SwitchClassOut,
            dependencies=[require_role("admin", "operator")])
def update_switch_class(class_id: int, body: SwitchClassUpdate, request: Request, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")
    payload = body.model_dump(exclude_unset=True)
    if (
        "allow_outside_rack" in payload
        and payload["allow_outside_rack"] is False
        and sc.allow_outside_rack
    ):
        unracked_count = db.query(Device).filter(
            Device.class_id == class_id,
            Device.rack_id.is_(None),
        ).count()
        if unracked_count > 0:
            api_error(
                409,
                "OUTSIDE_RACK_IN_USE",
                "Cannot disable outside-rack placement while unracked devices are assigned to this class",
            )
    for k, v in payload.items():
        # No switch class field is nullable; explicit null values are ignored
        if v is not None:
            setattr(sc, k, v)
    db.commit()
    db.refresh(sc)
    _bump_topo_version()
    log_audit(request, "update", "switch_class", str(class_id), {"fields": list(payload.keys())})
    return sc


@router.delete("/switch-classes/{class_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_switch_class(class_id: int, request: Request, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")
    # Detach devices assigned to this class before deleting
    db.query(Device).filter(Device.class_id == class_id).update({"class_id": None})
    log_audit(request, "delete", "switch_class", str(class_id), {"label": sc.label})
    db.delete(sc)
    db.commit()
    _bump_topo_version()
