"""Topology query and device/rack position/meta update endpoints."""
import hashlib
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database import Building, Device, Floor, TopologyLink, get_db
from database import Rack as RackModel
from database import SwitchClass as SwitchClassModel
from database import SwitchModel as SwitchModelModel
from schemas import (
    BulkDeviceMetaUpdate,
    DeviceMetaUpdate,
    DeviceOut,
    DevicePositionUpdate,
    RackOut,
    RackPositionUpdate,
    TopologyOut,
)
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
from shared.rack_space import (
    RackSlot,
    carry_rack_floors,
    collect_rack_slots,
    conflict_details,
    device_slot,
    find_conflict,
    find_pairwise_conflict,
)
from shared.redis_client import get_redis

router = APIRouter()

# Module-level version counter and cache (fallback when Redis is unavailable).
_topo_version = 0
_topo_cache: dict = {}  # {"version": int, "body": str, "etag": str}


def _get_topo_version() -> int:
    r = get_redis()
    if r:
        try:
            val = r.get("net2map:topo_version")
            return int(val) if val else 0
        except Exception:
            pass
    return _topo_version


def _bump_topo_version():
    global _topo_version
    r = get_redis()
    if r:
        try:
            r.incr("net2map:topo_version")
            return
        except Exception:
            pass
    _topo_version += 1


def _get_topo_cache() -> dict:
    r = get_redis()
    if r:
        try:
            raw = r.get("net2map:topo_cache")
            return json.loads(raw) if raw else {}
        except Exception:
            pass
    return _topo_cache


def _set_topo_cache(data: dict):
    global _topo_cache
    r = get_redis()
    if r:
        try:
            r.set("net2map:topo_cache", json.dumps(data), ex=300)
            return
        except Exception:
            pass
    _topo_cache = data


@router.get("/topology")
def get_topology(request: Request, db: Session = Depends(get_db)):
    topo_version = _get_topo_version()
    topo_cache = _get_topo_cache()

    # Fast-path: if cache is current and client has matching ETag, return 304
    if topo_cache.get("version") == topo_version:
        if request.headers.get("if-none-match") == topo_cache["etag"]:
            return Response(status_code=304)
        return Response(
            content=topo_cache["body"],
            media_type="application/json",
            headers={"ETag": topo_cache["etag"], "Cache-Control": "no-cache"},
        )

    # Only show devices that are not ignored
    nodes   = db.query(Device).filter(
        Device.ignored.is_(False),
    ).all()
    node_ips = {d.ip for d in nodes}
    # Drop links that reference devices not present in the node list
    links   = [
        link for link in db.query(TopologyLink).all()
        if link.local_ip in node_ips and link.remote_ip in node_ips
    ]
    racks   = db.query(RackModel).order_by(RackModel.id).all()
    classes = db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()
    models  = db.query(SwitchModelModel).order_by(SwitchModelModel.id).all()
    buildings = db.query(Building).order_by(Building.sort_order, Building.id).all()

    # Build a lookup for ports_per_row from switch models
    model_ppr = {m.id: m.ports_per_row for m in models}
    model_tp  = {m.id: m.total_ports   for m in models}

    # Build DeviceOut objects with resolved ports_per_row
    node_dicts = []
    for d in nodes:
        dout = DeviceOut.model_validate(d)
        if d.model_id and d.model_id in model_ppr:
            dout.ports_per_row = model_ppr[d.model_id]
        if d.model_id and d.model_id in model_tp:
            dout.total_ports = model_tp[d.model_id]
        node_dicts.append(dout)

    result  = TopologyOut(
        nodes=node_dicts, links=links, racks=racks, classes=classes, models=models, buildings=buildings,
    )
    body = result.model_dump_json()
    etag = f'"v{topo_version}"'

    _set_topo_cache({"version": topo_version, "body": body, "etag": etag})

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(content=body, media_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.patch("/topology/devices/{device_id}/position", response_model=DeviceOut,
              dependencies=[require_role("admin", "operator")])
def update_device_position(
    device_id: int, body: DevicePositionUpdate, db: Session = Depends(get_db)
):
    """Persist drag-and-drop position."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        api_error(404, "DEVICE_NOT_FOUND", "Device not found")
    device.map_x = body.map_x
    device.map_y = body.map_y
    db.commit()
    db.refresh(device)
    _bump_topo_version()
    return device


@router.patch("/topology/racks/{rack_id}/position", response_model=RackOut,
              dependencies=[require_role("admin", "operator")])
def update_rack_position(
    rack_id: int, body: RackPositionUpdate, db: Session = Depends(get_db)
):
    """Persist drag-and-drop position for a rack."""
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        api_error(404, "RACK_NOT_FOUND", "Rack not found")
    rack.map_x = body.map_x
    rack.map_y = body.map_y
    db.commit()
    db.refresh(rack)
    _bump_topo_version()
    return rack


def _check_device_slot(db: Session, rack: RackModel, slot: RackSlot, exclude_device_ids) -> None:
    """Reject a device placement outside the rack or conflicting with occupied U space (409)."""
    if slot.top > rack.height_u:
        api_error(
            409, "U_POSITION_OUT_OF_RANGE",
            f"Device {slot.obj_id} occupies U{slot.position}-U{slot.top} "
            f"but rack {rack.id} only has {rack.height_u}U",
        )
    conflict = find_conflict(slot, collect_rack_slots(db, rack.id, exclude_device_ids=exclude_device_ids))
    if conflict:
        side = "both sides" if slot.full_depth else f"the {slot.side} side"
        api_error(
            409, "U_OVERLAP",
            f"Device {slot.obj_id} at U{slot.position}-U{slot.top} ({side}) overlaps {conflict.label}",
            details=conflict_details(slot, conflict),
        )


def _validate_bulk_placement(db: Session, device_ids, updates: dict) -> None:
    """Validate the rack placement resulting from a bulk meta update.

    Only devices that end up in a rack with a U position are checked: against
    the rack's other occupants and against each other.
    """
    targets = db.query(Device).filter(Device.id.in_(device_ids)).all()
    by_rack: dict = {}
    for d in targets:
        rack_id = updates.get("rack_id", d.rack_id)
        if rack_id is None or d.rack_u_position is None:
            continue
        slot = device_slot(d, side=updates.get("rack_side"), full_depth=updates.get("full_depth"))
        by_rack.setdefault(rack_id, []).append(slot)
    moved_ids = [d.id for d in targets]
    for rack_id, slots in by_rack.items():
        rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
        if not rack:
            continue
        for slot in slots:
            _check_device_slot(db, rack, slot, moved_ids)
        pair = find_pairwise_conflict(slots)
        if pair:
            a, b = pair
            api_error(
                409, "U_OVERLAP",
                f"Devices {a.obj_id} and {b.obj_id} would overlap in U-space on the same rack side",
                details=conflict_details(a, b),
            )


@router.patch("/topology/devices/bulk-meta",
              dependencies=[require_role("admin", "operator")])
def bulk_update_device_meta(body: BulkDeviceMetaUpdate, request: Request, db: Session = Depends(get_db)):
    """Bulk update ignored/rack/class for multiple devices."""
    updates = {}
    if body.ignored is not None:
        updates["ignored"] = body.ignored
    if body.clear_rack:
        updates["rack_id"] = None
        updates["rack_u_position"] = None
    elif body.rack_id is not None:
        if not db.query(RackModel).filter(RackModel.id == body.rack_id).first():
            api_error(404, "RACK_NOT_FOUND", "Rack not found")
        updates["rack_id"] = body.rack_id
    if body.class_id is not None:
        target_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == body.class_id).first()
        if not target_class:
            api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")
        if not target_class.allow_outside_rack:
            if body.clear_rack:
                api_error(400, "OUTSIDE_RACK_NOT_ALLOWED", "Selected switch class requires rack assignment")
            if body.rack_id is None:
                unracked = db.query(Device).filter(
                    Device.id.in_(body.device_ids),
                    Device.rack_id.is_(None),
                ).count()
                if unracked > 0:
                    api_error(400, "OUTSIDE_RACK_NOT_ALLOWED", "Selected switch class requires rack assignment")
        updates["class_id"] = body.class_id
    if body.clear_floor:
        updates["floor_id"] = None
    elif body.floor_id is not None:
        if not db.query(Floor).filter(Floor.id == body.floor_id).first():
            api_error(404, "FLOOR_NOT_FOUND", "Floor not found")
        updates["floor_id"] = body.floor_id
    if body.rack_side is not None:
        updates["rack_side"] = body.rack_side
    if body.full_depth is not None:
        updates["full_depth"] = body.full_depth
    if not updates:
        api_error(400, "NO_FIELDS", "No fields to update")
    if not body.clear_rack and {"rack_id", "rack_side", "full_depth"} & updates.keys():
        _validate_bulk_placement(db, body.device_ids, updates)
    if body.clear_rack and "floor_id" not in updates:
        # Unracked devices stay on their rack's floor.
        carry_rack_floors(db, body.device_ids)
    count = db.query(Device).filter(Device.id.in_(body.device_ids)).update(updates, synchronize_session="fetch")

    db.commit()
    _bump_topo_version()
    log_audit(request, "bulk_update", "device_meta", "", {"device_ids": body.device_ids, "fields": list(updates.keys())})
    return {"updated": count}


@router.patch("/topology/devices/{device_id}/meta", response_model=DeviceOut,
              dependencies=[require_role("admin", "operator")])
def update_device_meta(
    device_id: int, body: DeviceMetaUpdate, request: Request, db: Session = Depends(get_db)
):
    """Update device location, sys_name, vendor, model, rack assignment, and/or switch class assignment."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        api_error(404, "DEVICE_NOT_FOUND", "Device not found")

    payload = body.model_dump(exclude_unset=True)

    target_rack_id = payload["rack_id"] if "rack_id" in payload else device.rack_id
    target_class_id = payload["class_id"] if "class_id" in payload else device.class_id

    if target_rack_id is not None and not db.query(RackModel).filter(RackModel.id == target_rack_id).first():
        api_error(404, "RACK_NOT_FOUND", "Rack not found")

    target_class = None
    if target_class_id is not None:
        target_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == target_class_id).first()
        if not target_class:
            api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")

    if target_rack_id is None and target_class_id is not None:
        if not target_class.allow_outside_rack:
            api_error(400, "OUTSIDE_RACK_NOT_ALLOWED", "Selected switch class requires rack assignment")

    if payload.get("floor_id") is not None and not db.query(Floor).filter(Floor.id == payload["floor_id"]).first():
        api_error(404, "FLOOR_NOT_FOUND", "Floor not found")

    # Validate the resulting rack placement before mutating the device
    placement_fields = {"rack_id", "rack_u_position", "u_height", "rack_side", "full_depth"}
    if target_rack_id is not None and placement_fields & payload.keys():
        if "rack_u_position" in payload:
            target_position = payload["rack_u_position"]
        else:
            target_position = device.rack_u_position
        if target_position is not None:
            slot = device_slot(
                device,
                position=target_position,
                height=payload.get("u_height"),
                side=payload.get("rack_side"),
                full_depth=payload.get("full_depth"),
            )
            rack = db.query(RackModel).filter(RackModel.id == target_rack_id).first()
            _check_device_slot(db, rack, slot, [device.id])

    if "location" in payload:
        device.location = payload["location"]
    if "sys_name" in payload:
        device.sys_name = payload["sys_name"]
    if "vendor" in payload:
        device.vendor = payload["vendor"] or ""
        # A non-empty vendor set via the API is a manual override; an emptied
        # vendor hands control back to auto-detection on the next scan.
        device.vendor_override = bool(payload["vendor"])
    if "vendor_override" in payload and payload["vendor_override"] is not None:
        # Explicit flag control (e.g. "reset to auto-detected") wins over the
        # implicit derivation from the vendor field.
        device.vendor_override = payload["vendor_override"]
    if "model" in payload:
        device.model = payload["model"]
    if "rack_id" in payload:
        if payload["rack_id"] is None and device.rack_id is not None and "floor_id" not in payload:
            # Leaving the rack keeps the device on the rack's floor (an
            # explicit floor_id in the same request wins).
            old_rack = db.query(RackModel).filter(RackModel.id == device.rack_id).first()
            if old_rack is not None and old_rack.floor_id is not None:
                device.floor_id = old_rack.floor_id
        device.rack_id = payload["rack_id"]
        if payload["rack_id"] is None:
            # A device outside any rack has no elevation slot either.
            device.rack_u_position = None
    if "class_id" in payload:
        device.class_id = payload["class_id"]
    if "floor_id" in payload:
        # Explicit null clears the floor; it wins over the floor carried
        # over from a rack the device leaves in the same request
        device.floor_id = payload["floor_id"]
    if "model_id" in payload:
        model_id = payload["model_id"]
        if model_id is not None and not db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first():
            api_error(404, "SWITCH_MODEL_NOT_FOUND", "Switch model not found")
        device.model_id = model_id
    if "ignored" in payload and payload["ignored"] is not None:
        device.ignored = payload["ignored"]
    if "label" in payload:
        device.label = payload["label"]
    if "enabled" in payload:
        device.enabled = payload["enabled"]
    if "rack_u_position" in payload:
        # Explicit null unplaces the device from the rack elevation
        device.rack_u_position = payload["rack_u_position"]
    if "u_height" in payload and payload["u_height"] is not None:
        device.u_height = payload["u_height"]
    if payload.get("rack_side") is not None:
        device.rack_side = payload["rack_side"]
    if payload.get("full_depth") is not None:
        device.full_depth = payload["full_depth"]
    if "latency_monitored" in payload and payload["latency_monitored"] is not None:
        device.latency_monitored = payload["latency_monitored"]
    if "device_type" in payload and payload["device_type"] is not None:
        device.device_type = payload["device_type"]

    db.commit()
    db.refresh(device)
    _bump_topo_version()
    log_audit(request, "update", "device_meta", str(device_id), {"fields": list(payload.keys())})
    # Resolve ports_per_row from switch model
    dout = DeviceOut.model_validate(device)
    if device.model_id:
        sm = db.query(SwitchModelModel).filter(SwitchModelModel.id == device.model_id).first()
        if sm:
            dout.ports_per_row = sm.ports_per_row
            dout.total_ports   = sm.total_ports
    return dout


@router.get("/devices")
def list_all_devices(
    request: Request,
    db: Session = Depends(get_db),
):
    """Returns all network devices."""
    devices = db.query(Device).order_by(Device.ip).all()
    models  = db.query(SwitchModelModel).all()
    model_ppr = {m.id: m.ports_per_row for m in models}
    model_tp  = {m.id: m.total_ports   for m in models}

    result = []
    for d in devices:
        dout = DeviceOut.model_validate(d)
        if d.model_id and d.model_id in model_ppr:
            dout.ports_per_row = model_ppr[d.model_id]
        if d.model_id and d.model_id in model_tp:
            dout.total_ports = model_tp[d.model_id]
        result.append(dout)
    body = json.dumps([d.model_dump() for d in result], default=str)
    etag = f'"{ hashlib.sha256(body.encode()).hexdigest()[:32]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(content=body, media_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})
