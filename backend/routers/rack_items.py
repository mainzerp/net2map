"""CRUD endpoints for manually maintained rack items (patch panels, blanks, ...).

Rack items only occupy U space in the rack elevation: no ports, no cabling,
never scanned. They share the U space with placed devices, so every write
validates the fit within the rack and the absence of U overlaps.
"""
from typing import Iterable, List, Optional, Tuple

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Device, RackItem, get_db
from database import Rack as RackModel
from routers.topology import _bump_topo_version
from schemas import RackItemCreate, RackItemOut, RackItemUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()

# (bottom U, height, description) of one occupied range
URange = Tuple[int, int, str]


def item_ranges(db: Session, rack_id: int, exclude_item_id: Optional[int] = None) -> List[URange]:
    """U ranges occupied by the rack items of a rack."""
    query = db.query(RackItem).filter(RackItem.rack_id == rack_id)
    if exclude_item_id is not None:
        query = query.filter(RackItem.id != exclude_item_id)
    return [(i.rack_u_position, i.u_height, f"rack item {i.id}") for i in query.all()]


def device_ranges(db: Session, rack_id: int) -> List[URange]:
    """U ranges occupied by the placed devices of a rack."""
    devices = db.query(Device).filter(Device.rack_id == rack_id, Device.rack_u_position.isnot(None)).all()
    return [(d.rack_u_position, d.u_height, f"device {d.id}") for d in devices]


def find_overlap(position: int, height: int, ranges: Iterable[URange]) -> Optional[str]:
    """Return the description of the first range overlapping [position, position + height - 1]."""
    top = position + height - 1
    for start, size, desc in ranges:
        if position <= start + size - 1 and start <= top:
            return desc
    return None


def _get_rack(db: Session, rack_id: int) -> RackModel:
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")
    return rack


def _validate_placement(db: Session, rack: RackModel, position: int, height: int,
                        exclude_item_id: Optional[int] = None) -> None:
    if position + height > rack.height_u + 1:
        api_error(
            409, "U_POSITION_OUT_OF_RANGE",
            f"Rack item occupies U{position}-U{position + height - 1} "
            f"but rack {rack.id} only has {rack.height_u}U",
        )
    ranges = device_ranges(db, rack.id) + item_ranges(db, rack.id, exclude_item_id)
    conflict = find_overlap(position, height, ranges)
    if conflict:
        api_error(409, "U_OVERLAP", f"Rack item at U{position}-U{position + height - 1} overlaps {conflict}")


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
    _validate_placement(db, rack, body.rack_u_position, body.u_height)
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
    if position != item.rack_u_position or height != item.u_height:
        _validate_placement(db, _get_rack(db, item.rack_id), position, height, exclude_item_id=item.id)
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
