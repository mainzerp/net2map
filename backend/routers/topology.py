"""Topology query and device/rack position/meta update endpoints."""
import hashlib

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database import Device, TopologyLink, get_db
from database import Rack as RackModel
from database import SwitchClass as SwitchClassModel
from database import SwitchModel as SwitchModelModel
from database import Credential
from schemas import (
    DeviceMetaUpdate, DeviceOut, DevicePositionUpdate,
    RackOut, RackPositionUpdate, TopologyOut,
)

router = APIRouter()


@router.get("/api/topology")
def get_topology(request: Request, db: Session = Depends(get_db)):
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
    # ETag: hash of serialized result to allow browser-side caching
    body = result.model_dump_json()
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
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
        raise HTTPException(404, "Device not found")
    device.map_x = body.map_x
    device.map_y = body.map_y
    db.commit()
    db.refresh(device)
    return device


@router.patch("/api/topology/racks/{rack_id}/position", response_model=RackOut)
def update_rack_position(
    rack_id: int, body: RackPositionUpdate, db: Session = Depends(get_db)
):
    """Persist drag-and-drop position for a rack."""
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    rack.map_x = body.map_x
    rack.map_y = body.map_y
    db.commit()
    db.refresh(rack)
    return rack


@router.patch("/api/topology/devices/{device_id}/meta", response_model=DeviceOut)
def update_device_meta(
    device_id: int, body: DeviceMetaUpdate, db: Session = Depends(get_db)
):
    """Update device location, sys_name, vendor, model, rack assignment, and/or switch class assignment."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(404, "Device not found")

    payload = body.model_dump(exclude_unset=True)

    if "location" in payload:
        device.location = payload["location"]
    if "sys_name" in payload:
        device.sys_name = payload["sys_name"]
    if "vendor" in payload:
        device.vendor = payload["vendor"]
    if "model" in payload:
        device.model = payload["model"]
    if "rack_id" in payload:
        rack_id = payload["rack_id"]
        if rack_id is not None and not db.query(RackModel).filter(RackModel.id == rack_id).first():
            raise HTTPException(404, "Rack not found")
        device.rack_id = rack_id
    if "class_id" in payload:
        class_id = payload["class_id"]
        if class_id is not None and not db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first():
            raise HTTPException(404, "Switch class not found")
        device.class_id = class_id
    if "model_id" in payload:
        model_id = payload["model_id"]
        if model_id is not None and not db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first():
            raise HTTPException(404, "Switch model not found")
        device.model_id = model_id
    if "ignored" in payload and payload["ignored"] is not None:
        device.ignored = payload["ignored"]

    db.commit()
    db.refresh(device)
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
    import json
    body = json.dumps([d.model_dump() for d in result], default=str)
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(content=body, media_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})
