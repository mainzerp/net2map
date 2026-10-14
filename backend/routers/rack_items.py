"""CRUD endpoints for manually maintained rack items (patch panels, blanks, ...).

Rack items only occupy U space in the rack elevation: no ports, no cabling,
never scanned. They share the U space with placed devices, so every write
validates the fit within the rack and the absence of U overlaps (side-aware,
see shared.rack_space).
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Rack as RackModel
from database import RackItem, get_db
from routers.topology import _bump_topo_version
from schemas import RackItemCreate, RackItemOut, RackItemUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.rack_space import RackSlot, collect_rack_slots, conflict_details, find_conflict

router = APIRouter()


def _get_rack(db: Session, rack_id: int) -> RackModel:
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")
    return rack


def _validate_placement(db: Session, rack: RackModel, slot: RackSlot,
                        exclude_item_id: Optional[int] = None) -> None:
    if slot.top > rack.height_u:
        api_error(
            409, "U_POSITION_OUT_OF_RANGE",
            f"Rack item occupies U{slot.position}-U{slot.top} "
            f"but rack {rack.id} only has {rack.height_u}U",
        )
    excluded = [exclude_item_id] if exclude_item_id is not None else []
    conflict = find_conflict(slot, collect_rack_slots(db, rack.id, exclude_item_ids=excluded))
    if conflict:
        side = "both sides" if slot.full_depth else f"the {slot.side} side"
        api_error(
            409, "U_OVERLAP",
            f"Rack item at U{slot.position}-U{slot.top} ({side}) overlaps {conflict.label}",
            details=conflict_details(conflict),
        )


@router.get("/racks/{rack_id}/items", response_model=List[RackItemOut])
def list_rack_items(rack_id: int, db: Session = Depends(get_db)):
    _get_rack(db, rack_id)
    return (
        db.query(RackItem)
        .filter(RackItem.rack_id == rack_id)
        .order_by(RackItem.rack_u_position.desc(), RackItem.id)
        .all()
    )


@router.post("/racks/{rack_id}/items", response_model=RackItemOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_rack_item(rack_id: int, body: RackItemCreate, request: Request, db: Session = Depends(get_db)):
    rack = _get_rack(db, rack_id)
    slot = RackSlot(body.rack_u_position, body.u_height, body.rack_side, body.full_depth, "rack_item")
    _validate_placement(db, rack, slot)
    item = RackItem(rack_id=rack_id, **body.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    _bump_topo_version()
    log_audit(request, "create", "rack_item", str(item.id),
              {"rack_id": rack_id, "kind": item.kind, "label": item.label})
    return item


@router.patch("/rack-items/{item_id}", response_model=RackItemOut,
              dependencies=[require_role("admin", "operator")])
def update_rack_item(item_id: int, body: RackItemUpdate, request: Request, db: Session = Depends(get_db)):
    item = db.query(RackItem).filter(RackItem.id == item_id).first()
    if not item:
        api_error(404, "RACK_ITEM_NOT_FOUND", "Rack item not found")
    payload = body.model_dump(exclude_unset=True)
    position = payload.get("rack_u_position") or item.rack_u_position
    height = payload.get("u_height") or item.u_height
    side = payload.get("rack_side") or item.rack_side or "front"
    full_depth = payload["full_depth"] if payload.get("full_depth") is not None else bool(item.full_depth)
    if (position, height, side, full_depth) != (item.rack_u_position, item.u_height, item.rack_side, item.full_depth):
        slot = RackSlot(position, height, side, full_depth, "rack_item", item.id)
        _validate_placement(db, _get_rack(db, item.rack_id), slot, exclude_item_id=item.id)
    for key, value in payload.items():
        # Only the note is nullable; explicit null values for other fields are ignored
        if value is not None or key == "note":
            setattr(item, key, value)
    db.commit()
    db.refresh(item)
    _bump_topo_version()
    log_audit(request, "update", "rack_item", str(item_id), {"fields": list(payload.keys())})
    return item


@router.delete("/rack-items/{item_id}", status_code=204,
               dependencies=[require_role("admin", "operator")])
def delete_rack_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    item = db.query(RackItem).filter(RackItem.id == item_id).first()
    if not item:
        api_error(404, "RACK_ITEM_NOT_FOUND", "Rack item not found")
    log_audit(request, "delete", "rack_item", str(item_id), {"rack_id": item.rack_id, "label": item.label})
    db.delete(item)
    db.commit()
    _bump_topo_version()
