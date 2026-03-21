"""CRUD endpoints for switch models."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Device, get_db
from database import SwitchModel as SwitchModelModel
from schemas import SwitchModelCreate, SwitchModelOut, SwitchModelUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()


@router.get("/api/switch-models", response_model=List[SwitchModelOut])
def list_switch_models(db: Session = Depends(get_db)):
    return db.query(SwitchModelModel).order_by(SwitchModelModel.id).all()


@router.post("/api/switch-models", response_model=SwitchModelOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_switch_model(body: SwitchModelCreate, request: Request, db: Session = Depends(get_db)):
    sm = SwitchModelModel(**body.model_dump())
    db.add(sm)
    db.commit()
    db.refresh(sm)
    log_audit(request, "create", "switch_model", str(sm.id), {"name": sm.name})
    return sm


@router.put("/api/switch-models/{model_id}", response_model=SwitchModelOut,
            dependencies=[require_role("admin", "operator")])
def update_switch_model(model_id: int, body: SwitchModelUpdate, request: Request, db: Session = Depends(get_db)):
    sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first()
    if not sm:
        api_error(404, "SWITCH_MODEL_NOT_FOUND", "Switch model not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(sm, k, v)
    db.commit()
    db.refresh(sm)
    log_audit(request, "update", "switch_model", str(model_id), {"fields": list(body.model_dump(exclude_none=True).keys())})
    return sm


@router.delete("/api/switch-models/{model_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_switch_model(model_id: int, request: Request, db: Session = Depends(get_db)):
    sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first()
    if not sm:
        api_error(404, "SWITCH_MODEL_NOT_FOUND", "Switch model not found")
    # Detach devices assigned to this model before deleting
    db.query(Device).filter(Device.model_id == model_id).update({"model_id": None})
    log_audit(request, "delete", "switch_model", str(model_id), {"name": sm.name})
    db.delete(sm)
    db.commit()
