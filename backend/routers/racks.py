"""CRUD endpoints for racks."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Device, get_db
from database import Rack as RackModel
from schemas import RackCreate, RackOut, RackUpdate

router = APIRouter()


@router.get("/api/racks", response_model=List[RackOut])
def list_racks(db: Session = Depends(get_db)):
    return db.query(RackModel).order_by(RackModel.id).all()


@router.post("/api/racks", response_model=RackOut, status_code=201)
def create_rack(body: RackCreate, db: Session = Depends(get_db)):
    rack = RackModel(**body.model_dump())
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@router.put("/api/racks/{rack_id}", response_model=RackOut)
def update_rack(rack_id: int, body: RackUpdate, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(rack, k, v)
    db.commit()
    db.refresh(rack)
    return rack


@router.delete("/api/racks/{rack_id}", status_code=204)
def delete_rack(rack_id: int, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    # Detach devices assigned to this rack before deleting
    db.query(Device).filter(Device.rack_id == rack_id).update({"rack_id": None})
    db.delete(rack)
    db.commit()
