"""CRUD endpoints for switch models."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Device, get_db
from database import SwitchModel as SwitchModelModel
from schemas import SwitchModelCreate, SwitchModelOut, SwitchModelUpdate

router = APIRouter()


@router.get("/api/switch-models", response_model=List[SwitchModelOut])
def list_switch_models(db: Session = Depends(get_db)):
    return db.query(SwitchModelModel).order_by(SwitchModelModel.id).all()


@router.post("/api/switch-models", response_model=SwitchModelOut, status_code=201)
def create_switch_model(body: SwitchModelCreate, db: Session = Depends(get_db)):
    sm = SwitchModelModel(**body.model_dump())
    db.add(sm)
    db.commit()
    db.refresh(sm)
    return sm


@router.put("/api/switch-models/{model_id}", response_model=SwitchModelOut)
def update_switch_model(model_id: int, body: SwitchModelUpdate, db: Session = Depends(get_db)):
    sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first()
    if not sm:
        raise HTTPException(404, "Switch model not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(sm, k, v)
    db.commit()
    db.refresh(sm)
    return sm


@router.delete("/api/switch-models/{model_id}", status_code=204)
def delete_switch_model(model_id: int, db: Session = Depends(get_db)):
    sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first()
    if not sm:
        raise HTTPException(404, "Switch model not found")
    # Detach devices assigned to this model before deleting
    db.query(Device).filter(Device.model_id == model_id).update({"model_id": None})
    db.delete(sm)
    db.commit()
