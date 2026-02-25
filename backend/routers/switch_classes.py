"""CRUD endpoints for switch classes."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Device, get_db
from database import SwitchClass as SwitchClassModel
from schemas import SwitchClassCreate, SwitchClassOut, SwitchClassUpdate

router = APIRouter()


@router.get("/api/switch-classes", response_model=List[SwitchClassOut])
def list_switch_classes(db: Session = Depends(get_db)):
    return db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()


@router.post("/api/switch-classes", response_model=SwitchClassOut, status_code=201)
def create_switch_class(body: SwitchClassCreate, db: Session = Depends(get_db)):
    sc = SwitchClassModel(**body.model_dump())
    db.add(sc)
    db.commit()
    db.refresh(sc)
    return sc


@router.put("/api/switch-classes/{class_id}", response_model=SwitchClassOut)
def update_switch_class(class_id: int, body: SwitchClassUpdate, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        raise HTTPException(404, "Switch class not found")
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
            raise HTTPException(
                409,
                "Cannot disable outside-rack placement while unracked devices are assigned to this class",
            )
    for k, v in payload.items():
        setattr(sc, k, v)
    db.commit()
    db.refresh(sc)
    return sc


@router.delete("/api/switch-classes/{class_id}", status_code=204)
def delete_switch_class(class_id: int, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        raise HTTPException(404, "Switch class not found")
    # Detach devices assigned to this class before deleting
    db.query(Device).filter(Device.class_id == class_id).update({"class_id": None})
    db.delete(sc)
    db.commit()
