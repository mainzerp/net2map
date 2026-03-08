"""Topology query and device/rack position/meta update endpoints."""
import hashlib
import json
import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database import Device, TopologyLink, get_db
from database import Rack as RackModel
from database import SwitchClass as SwitchClassModel
from database import SwitchModel as SwitchModelModel
from database import Credential
from schemas import (
    BulkDeviceMetaUpdate, DeviceMetaUpdate, DeviceOut, DevicePositionUpdate,
    RackOut, RackPositionUpdate, TopologyOut,
)
from shared.auth import require_role
from shared.audit import log_audit
from shared.errors import api_error
from shared.redis_client import get_redis

router = APIRouter()

# Module-level version counter and cache (fallback when Redis is unavailable).
_topo_version = 0
_topo_cache: dict = {}  # {"version": int, "body": str, "etag": str}


def _get_topo_version() -> int:
    r = get_redis()
    if r:
        try:
            val = r.get("netmap:topo_version")
            return int(val) if val else 0
        except Exception:
            pass
    return _topo_version


def _bump_topo_version():
    global _topo_version
    r = get_redis()
    if r:
        try:
            r.incr("netmap:topo_version")
            return
        except Exception:
            pass
    _topo_version += 1


def _get_topo_cache() -> dict:
    r = get_redis()
    if r:
        try:
            raw = r.get("netmap:topo_cache")
            return json.loads(raw) if raw else {}
        except Exception:
            pass
    return _topo_cache


def _set_topo_cache(data: dict):
    global _topo_cache
    r = get_redis()
    if r:
        try:
            r.set("netmap:topo_cache", json.dumps(data), ex=300)
            return
        except Exception:
            pass
    _topo_cache = data


@router.get("/api/topology")
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

    # Only show devices that have a matching credential entry (assigned switches)
    cred_ips = {c.ip for c in db.query(Credential.ip).all()}
    nodes   = db.query(Device).filter(
        Device.ignored == False,
        Device.ip.in_(cred_ips),
    ).all()
    links   = db.query(TopologyLink).all()
    racks   = db.query(RackModel).order_by(RackModel.id).all()
    classes = db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()
    models  = db.query(SwitchModelModel).order_by(SwitchModelModel.id).all()

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

    result  = TopologyOut(nodes=node_dicts, links=links, racks=racks, classes=classes, models=models)
    body = result.model_dump_json()
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'

    _set_topo_cache({"version": topo_version, "body": body, "etag": etag})

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(content=body, media_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.patch("/api/topology/devices/{device_id}/position", response_model=DeviceOut)
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


@router.patch("/api/topology/racks/{rack_id}/position", response_model=RackOut)
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


@router.patch("/api/topology/devices/bulk-meta",
              dependencies=[require_role("admin", "operator")])
def bulk_update_device_meta(body: BulkDeviceMetaUpdate, request: Request, db: Session = Depends(get_db)):
    """Bulk update ignored/rack/class for multiple devices."""
    updates = {}
    if body.ignored is not None:
        updates["ignored"] = body.ignored
    if body.rack_id is not None:
        updates["rack_id"] = body.rack_id
    if body.class_id is not None:
        updates["class_id"] = body.class_id
    if not updates:
        api_error(400, "NO_FIELDS", "No fields to update")
    count = db.query(Device).filter(Device.id.in_(body.device_ids)).update(updates, synchronize_session="fetch")
    db.commit()
    _bump_topo_version()
    log_audit(request, "bulk_update", "device_meta", "", {"device_ids": body.device_ids, "fields": list(updates.keys())})
    return {"updated": count}


@router.patch("/api/topology/devices/{device_id}/meta", response_model=DeviceOut,
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
        raise HTTPException(404, "Rack not found")

    target_class = None
    if target_class_id is not None:
        target_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == target_class_id).first()
        if not target_class:
            raise HTTPException(404, "Switch class not found")

    if target_rack_id is None:
        if target_class_id is None:
            raise HTTPException(400, "Unracked devices require a switch class that allows outside-rack placement")
        if not target_class.allow_outside_rack:
            raise HTTPException(400, "Selected switch class requires rack assignment")

    if "location" in payload:
        device.location = payload["location"]
    if "sys_name" in payload:
        device.sys_name = payload["sys_name"]
    if "vendor" in payload:
        device.vendor = payload["vendor"]
    if "model" in payload:
        device.model = payload["model"]
    if "rack_id" in payload:
        device.rack_id = payload["rack_id"]
    if "class_id" in payload:
        device.class_id = payload["class_id"]
    if "model_id" in payload:
        model_id = payload["model_id"]
        if model_id is not None and not db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first():
            api_error(404, "SWITCH_MODEL_NOT_FOUND", "Switch model not found")
        device.model_id = model_id
    if "ignored" in payload and payload["ignored"] is not None:
        device.ignored = payload["ignored"]

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


@router.get("/api/devices")
def list_all_devices(request: Request, db: Session = Depends(get_db)):
    """Returns all devices including ignored ones (for the settings UI)."""
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
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(content=body, media_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})
