"""CRUD endpoints for racks."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Device, get_db
from database import Rack as RackModel
from routers.topology import _bump_topo_version
from schemas import RackCreate, RackOut, RackUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()


@router.get("/api/racks", response_model=List[RackOut])
def list_racks(db: Session = Depends(get_db)):
    return db.query(RackModel).order_by(RackModel.id).all()


@router.post("/api/racks", response_model=RackOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_rack(body: RackCreate, request: Request, db: Session = Depends(get_db)):
    rack = RackModel(**body.model_dump())
    db.add(rack)
    db.commit()
    db.refresh(rack)
    _bump_topo_version()
    log_audit(request, "create", "rack", str(rack.id), {"label": rack.label})
    return rack


@router.put("/api/racks/{rack_id}", response_model=RackOut,
            dependencies=[require_role("admin", "operator")])
def update_rack(rack_id: int, body: RackUpdate, request: Request, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")
    payload = body.model_dump(exclude_unset=True)
    # No rack field is nullable; explicit null values are ignored
    for k, v in payload.items():
        if v is not None:
            setattr(rack, k, v)
    db.commit()
    db.refresh(rack)
    _bump_topo_version()
    log_audit(request, "update", "rack", str(rack_id), {"fields": list(payload.keys())})
    return rack


@router.delete("/api/racks/{rack_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_rack(rack_id: int, request: Request, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")
    # Detach devices assigned to this rack before deleting
    db.query(Device).filter(Device.rack_id == rack_id).update({"rack_id": None})
    log_audit(request, "delete", "rack", str(rack_id), {"label": rack.label})
    db.delete(rack)
    db.commit()
    _bump_topo_version()
