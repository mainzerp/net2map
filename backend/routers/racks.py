"""CRUD endpoints for racks."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Device, get_db
from database import Rack as RackModel
from routers.floors import ensure_floor_exists
from routers.topology import _bump_topo_version
from schemas import RackCreate, RackLayoutIn, RackOut, RackUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.rack_space import (
    carry_rack_floors,
    collect_rack_slots,
    conflict_details,
    device_slot,
    find_conflict,
    find_pairwise_conflict,
)

router = APIRouter()


@router.get("/racks", response_model=List[RackOut])
def list_racks(db: Session = Depends(get_db)):
    return db.query(RackModel).order_by(RackModel.id).all()


@router.post("/racks", response_model=RackOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_rack(body: RackCreate, request: Request, db: Session = Depends(get_db)):
    ensure_floor_exists(db, body.floor_id)
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
        if any(s.top > height for s in collect_rack_slots(db, rack_id, include_devices=False)):
            api_error(409, "U_POSITION_OUT_OF_RANGE", "Rack height would exclude a rack item")
    if "floor_id" in payload:
        ensure_floor_exists(db, payload["floor_id"])
        # floor_id is the only nullable rack field; explicit null clears it
        rack.floor_id = payload["floor_id"]
    # No other rack field is nullable; explicit null values are ignored
    for k, v in payload.items():
        if v is not None and k != "floor_id":
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
    # Detach devices assigned to this rack before deleting; they stay on the
    # rack's floor and lose their elevation slot (same as unracking via meta).
    racked_ids = [row[0] for row in db.query(Device.id).filter(Device.rack_id == rack_id).all()]
    carry_rack_floors(db, racked_ids)
    db.query(Device).filter(Device.rack_id == rack_id).update({"rack_id": None, "rack_u_position": None})
    log_audit(request, "delete", "rack", str(rack_id), {"label": rack.label})
    db.delete(rack)
    db.commit()
    _bump_topo_version()


@router.patch("/racks/{rack_id}/layout",
              dependencies=[require_role("admin", "operator")])
def update_rack_layout(rack_id: int, body: RackLayoutIn, request: Request, db: Session = Depends(get_db)):
    """Place devices in the rack elevation (1-based U space) in one transaction.

    Every entry must reference a device assigned to this rack, must fit inside
    rack.height_u, and the resulting layout may not contain conflicting
    objects (side-aware U overlap, see shared.rack_space).
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

    # PATCH leaves omitted devices in place; validate the complete resulting
    # device layout, then the entries against the rack items.
    entry_slots = [
        device_slot(
            devices[e.device_id], position=e.rack_u_position, height=e.u_height,
            side=e.rack_side, full_depth=e.full_depth,
        )
        for e in body.entries
    ]
    other_devices = collect_rack_slots(db, rack_id, exclude_device_ids=device_ids, include_items=False)
    pair = find_pairwise_conflict(entry_slots + other_devices)
    if pair:
        a, b = pair
        api_error(
            409, "U_OVERLAP",
            f"Devices {a.obj_id} and {b.obj_id} overlap in U-space on the same rack side",
            details=conflict_details(a, b),
        )

    # Rack items (patch panels, blanks, ...) occupy U space as well
    items = collect_rack_slots(db, rack_id, include_devices=False)
    for dev_slot in entry_slots:
        item = find_conflict(dev_slot, items)
        if item:
            api_error(
                409, "U_OVERLAP",
                f"Device {dev_slot.obj_id} overlaps {item.label} in U-space on the same rack side",
                details=conflict_details(dev_slot, item),
            )

    for e in body.entries:
        dev = devices[e.device_id]
        dev.rack_u_position = e.rack_u_position
        dev.u_height = e.u_height
        if e.rack_side is not None:
            dev.rack_side = e.rack_side
        if e.full_depth is not None:
            dev.full_depth = e.full_depth
    db.commit()
    _bump_topo_version()
    log_audit(request, "update", "rack_layout", str(rack_id), {"device_ids": device_ids})
    return {"updated": len(body.entries)}
