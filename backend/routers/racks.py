"""CRUD endpoints for racks."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Device, get_db
from database import Rack as RackModel
from routers.topology import _bump_topo_version
from schemas import RackCreate, RackLayoutIn, RackOut, RackUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()


@router.get("/racks", response_model=List[RackOut])
def list_racks(db: Session = Depends(get_db)):
    return db.query(RackModel).order_by(RackModel.id).all()


@router.post("/racks", response_model=RackOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_rack(body: RackCreate, request: Request, db: Session = Depends(get_db)):
    rack = RackModel(**body.model_dump())
    db.add(rack)
    db.commit()
    db.refresh(rack)
    _bump_topo_version()
    log_audit(request, "create", "rack", str(rack.id), {"label": rack.label})
    return rack


@router.put("/racks/{rack_id}", response_model=RackOut,
            dependencies=[require_role("admin", "operator")])
def update_rack(rack_id: int, body: RackUpdate, request: Request, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")
    payload = body.model_dump(exclude_unset=True)
    height = payload.get("height_u")
    if height is not None:
        occupied = db.query(Device).filter(
            Device.rack_id == rack_id, Device.rack_u_position.isnot(None),
        ).all()
        if any(d.rack_u_position + d.u_height - 1 > height for d in occupied):
            api_error(409, "U_POSITION_OUT_OF_RANGE", "Rack height would exclude an assigned device")
    # No rack field is nullable; explicit null values are ignored
    for k, v in payload.items():
        if v is not None:
            setattr(rack, k, v)
    db.commit()
    db.refresh(rack)
    _bump_topo_version()
    log_audit(request, "update", "rack", str(rack_id), {"fields": list(payload.keys())})
    return rack


@router.delete("/racks/{rack_id}", status_code=204,
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


@router.patch("/racks/{rack_id}/layout",
              dependencies=[require_role("admin", "operator")])
def update_rack_layout(rack_id: int, body: RackLayoutIn, request: Request, db: Session = Depends(get_db)):
    """Place devices in the rack elevation (1-based U space) in one transaction.

    Every entry must reference a device assigned to this rack, must fit inside
    rack.height_u, and no two entries may overlap in U-space.
    """
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")

    device_ids = [e.device_id for e in body.entries]
    if len(set(device_ids)) != len(device_ids):
        api_error(422, "DUPLICATE_DEVICE", "A device may appear only once in the layout")

    devices = {}
    if device_ids:
        devices = {d.id: d for d in db.query(Device).filter(Device.id.in_(device_ids)).all()}
    missing = [i for i in device_ids if i not in devices]
    if missing:
        api_error(404, "DEVICE_NOT_FOUND", f"Devices not found: {missing}")
    wrong_rack = [i for i in device_ids if devices[i].rack_id != rack_id]
    if wrong_rack:
        api_error(422, "DEVICE_NOT_IN_RACK", f"Devices not assigned to this rack: {wrong_rack}")

    # Range check: a device occupies [pos, pos + u_height - 1] and must fit in the rack
    for e in body.entries:
        if e.rack_u_position + e.u_height > rack.height_u + 1:
            api_error(
                409, "U_POSITION_OUT_OF_RANGE",
                f"Device {e.device_id} occupies U{e.rack_u_position}-U{e.rack_u_position + e.u_height - 1} "
                f"but rack {rack_id} only has {rack.height_u}U",
            )

    # PATCH leaves omitted devices in place; validate the complete resulting layout.
    positions = [(e.rack_u_position, e.u_height, e.device_id) for e in body.entries]
    positions.extend(
        (d.rack_u_position, d.u_height, d.id)
        for d in db.query(Device).filter(Device.rack_id == rack_id).all()
        if d.id not in devices and d.rack_u_position is not None
    )
    ordered = sorted(positions)
    for prev, cur in zip(ordered, ordered[1:]):
        if cur[0] <= prev[0] + prev[1] - 1:
            api_error(
                409, "U_OVERLAP",
                f"Devices {prev[2]} and {cur[2]} overlap in U-space",
                details=[{"device_ids": [prev[2], cur[2]]}],
            )

    for e in body.entries:
        devices[e.device_id].rack_u_position = e.rack_u_position
        devices[e.device_id].u_height = e.u_height
    db.commit()
    _bump_topo_version()
    log_audit(request, "update", "rack_layout", str(rack_id), {"device_ids": device_ids})
    return {"updated": len(body.entries)}
