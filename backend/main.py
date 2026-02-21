"""FastAPI application – NetMap backend."""
import json
import logging
import os
import socket
import shutil
from datetime import datetime
from typing import List

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from database import (
    Credential, Device, Port, TopologyLink, SnmpProfile,
    Rack as RackModel, SwitchClass as SwitchClassModel,
    create_tables, get_db,
)
from schemas import (
    CredentialCreate, CredentialOut, CredentialUpdate,
    DeviceOut, DevicePositionUpdate, DeviceMetaUpdate,
    ScanResult, TopologyOut, TopologyLinkOut,
    SnmpProfileCreate, SnmpProfileUpdate, SnmpProfileOut,
    RackCreate, RackUpdate, RackOut,
    SwitchClassCreate, SwitchClassUpdate, SwitchClassOut,
)
from snmp_scanner import (
    LldpNeighbor, SwitchData, auto_layout, scan_switch,
    extract_model, is_virtual, speed_label,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="NetMap API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_tables()

# ─── SNMP Profiles ───────────────────────────────────────────────────────────────

@app.get("/api/snmp-profiles", response_model=List[SnmpProfileOut])
def list_snmp_profiles(db: Session = Depends(get_db)):
    return db.query(SnmpProfile).order_by(SnmpProfile.id).all()


@app.post("/api/snmp-profiles", response_model=SnmpProfileOut, status_code=201)
def create_snmp_profile(body: SnmpProfileCreate, db: Session = Depends(get_db)):
    profile = SnmpProfile(**body.model_dump())
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@app.put("/api/snmp-profiles/{profile_id}", response_model=SnmpProfileOut)
def update_snmp_profile(profile_id: int, body: SnmpProfileUpdate, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(profile, k, v)
    db.commit()
    db.refresh(profile)
    return profile


@app.delete("/api/snmp-profiles/{profile_id}", status_code=204)
def delete_snmp_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    # Detach credentials that use this profile before deleting
    db.query(Credential).filter(Credential.profile_id == profile_id).update({"profile_id": None})
    db.delete(profile)
    db.commit()


# ─── Racks ────────────────────────────────────────────────────────────────────

@app.get("/api/racks", response_model=List[RackOut])
def list_racks(db: Session = Depends(get_db)):
    return db.query(RackModel).order_by(RackModel.id).all()


@app.post("/api/racks", response_model=RackOut, status_code=201)
def create_rack(body: RackCreate, db: Session = Depends(get_db)):
    rack = RackModel(**body.model_dump())
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@app.put("/api/racks/{rack_id}", response_model=RackOut)
def update_rack(rack_id: int, body: RackUpdate, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(rack, k, v)
    db.commit()
    db.refresh(rack)
    return rack


@app.delete("/api/racks/{rack_id}", status_code=204)
def delete_rack(rack_id: int, db: Session = Depends(get_db)):
    rack = db.query(RackModel).filter(RackModel.id == rack_id).first()
    if not rack:
        raise HTTPException(404, "Rack not found")
    # Detach devices assigned to this rack before deleting
    db.query(Device).filter(Device.rack_id == rack_id).update({"rack_id": None})
    db.delete(rack)
    db.commit()


# ─── Switch Classes ───────────────────────────────────────────────────────────

@app.get("/api/switch-classes", response_model=List[SwitchClassOut])
def list_switch_classes(db: Session = Depends(get_db)):
    return db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()


@app.post("/api/switch-classes", response_model=SwitchClassOut, status_code=201)
def create_switch_class(body: SwitchClassCreate, db: Session = Depends(get_db)):
    sc = SwitchClassModel(**body.model_dump())
    db.add(sc)
    db.commit()
    db.refresh(sc)
    return sc


@app.put("/api/switch-classes/{class_id}", response_model=SwitchClassOut)
def update_switch_class(class_id: int, body: SwitchClassUpdate, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        raise HTTPException(404, "Switch class not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(sc, k, v)
    db.commit()
    db.refresh(sc)
    return sc


@app.delete("/api/switch-classes/{class_id}", status_code=204)
def delete_switch_class(class_id: int, db: Session = Depends(get_db)):
    sc = db.query(SwitchClassModel).filter(SwitchClassModel.id == class_id).first()
    if not sc:
        raise HTTPException(404, "Switch class not found")
    # Detach devices assigned to this class before deleting
    db.query(Device).filter(Device.class_id == class_id).update({"class_id": None})
    db.delete(sc)
    db.commit()


# ─── Credentials ──────────────────────────────────────────────────────────────

@app.get("/api/credentials", response_model=List[CredentialOut])
def list_credentials(db: Session = Depends(get_db)):
    return db.query(Credential).order_by(Credential.id).all()


@app.post("/api/credentials", response_model=CredentialOut, status_code=201)
def create_credential(body: CredentialCreate, db: Session = Depends(get_db)):
    existing = db.query(Credential).filter(Credential.ip == body.ip).first()
    if existing:
        raise HTTPException(400, f"IP {body.ip} already exists")
    cred = Credential(**body.model_dump())
    db.add(cred)
    db.commit()
    db.refresh(cred)
    return cred


@app.put("/api/credentials/{cred_id}", response_model=CredentialOut)
def update_credential(cred_id: int, body: CredentialUpdate, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        raise HTTPException(404, "Credential not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(cred, k, v)
    db.commit()
    db.refresh(cred)
    return cred


@app.delete("/api/credentials/{cred_id}", status_code=204)
def delete_credential(cred_id: int, db: Session = Depends(get_db)):
    cred = db.query(Credential).filter(Credential.id == cred_id).first()
    if not cred:
        raise HTTPException(404, "Credential not found")
    db.delete(cred)
    db.commit()


# ─── SNMP Scan ────────────────────────────────────────────────────────────────

@app.post("/api/scan", response_model=ScanResult)
def run_scan(db: Session = Depends(get_db)):
    """
    Scan all enabled credentials via SNMPv2c or SNMPv3.
    Discovered devices and LLDP links are upserted into the DB.
    """
    credentials = db.query(Credential).filter(Credential.enabled == True).all()
    if not credentials:
        return ScanResult(scanned=0, found=0, links=0, errors=["No enabled credentials"])

    errors: List[str] = []
    switch_data: dict[str, SwitchData] = {}

    # --- scan each credential ---
    for cred in credentials:
        # Resolve effective SNMP settings: profile overrides per-device fields
        p = cred.profile
        snmp_version      = p.snmp_version      if p else cred.snmp_version
        community         = p.community         if p else cred.community
        v3_security_level = p.v3_security_level if p else cred.v3_security_level
        v3_username       = p.v3_username       if p else cred.v3_username
        v3_auth_protocol  = p.v3_auth_protocol  if p else cred.v3_auth_protocol
        v3_auth_password  = p.v3_auth_password  if p else cred.v3_auth_password
        v3_priv_protocol  = p.v3_priv_protocol  if p else cred.v3_priv_protocol
        v3_priv_password  = p.v3_priv_password  if p else cred.v3_priv_password
        try:
            data = scan_switch(
                ip               = cred.ip,
                snmp_version     = snmp_version,
                community        = community,
                snmp_port        = cred.snmp_port,
                v3_security_level= v3_security_level,
                v3_username      = v3_username,
                v3_auth_protocol = v3_auth_protocol,
                v3_auth_password = v3_auth_password,
                v3_priv_protocol = v3_priv_protocol,
                v3_priv_password = v3_priv_password,
            )
            if data:
                switch_data[cred.ip] = data
            else:
                errors.append(f"{cred.ip}: no SNMP response")
        except Exception as exc:
            errors.append(f"{cred.ip}: {exc}")

    if not switch_data:
        return ScanResult(scanned=len(credentials), found=0, links=0, errors=errors)

    # --- determine positions for genuinely new IPs ---
    existing_ips = {d.ip for d in db.query(Device.ip).all()}
    new_ips = [ip for ip in switch_data if ip not in existing_ips]
    # keep positions of existing + layout new ones around them
    all_ips_ordered = list(existing_ips) + new_ips
    layout = auto_layout(all_ips_ordered)

    # --- upsert devices ---
    for ip, sw in switch_data.items():
        model = extract_model(sw.sys_descr, sw.vendor)

        device = db.query(Device).filter(Device.ip == ip).first()
        if device:
            device.sys_name  = sw.sys_name  or device.sys_name
            device.sys_descr = sw.sys_descr or device.sys_descr
            device.location  = sw.location  or device.location
            device.model     = model        or device.model
            device.vendor    = sw.vendor
            device.last_seen = datetime.utcnow()
        else:
            x, y = layout.get(ip, (100.0, 100.0))
            device = Device(
                ip=ip,
                sys_name  = sw.sys_name,
                sys_descr = sw.sys_descr,
                model     = model,
                vendor    = sw.vendor,
                location  = sw.location,
                map_x     = x,
                map_y     = y,
            )
            db.add(device)

    db.flush()  # get IDs

    # --- upsert ports ---
    for ip, sw in switch_data.items():
        device = db.query(Device).filter(Device.ip == ip).first()
        if not device:
            continue
        # delete old ports for this device then re-insert
        db.query(Port).filter(Port.device_id == device.id).delete()
        for iface in sw.interfaces.values():
            if is_virtual(iface.descr, sw.vendor):
                continue
            port = Port(
                device_id   = device.id,
                if_index    = iface.index,
                if_descr    = iface.descr,
                if_alias    = iface.alias,
                speed_mbps  = iface.speed_mbps,
                oper_status = iface.oper_status,
            )
            db.add(port)

    # --- upsert LLDP topology links ---
    # remove stale links then rebuild
    scanned_ips = set(switch_data.keys())
    db.query(TopologyLink).filter(TopologyLink.local_ip.in_(scanned_ips)).delete(
        synchronize_session=False
    )

    link_count = 0
    for ip, sw in switch_data.items():
        for nbr in sw.lldp_neighbors:
            if not nbr.remote_sys:
                continue
            remote_ip  = _resolve_ip(nbr.remote_sys, switch_data)
            spd_label  = speed_label(sw.interfaces[nbr.local_port_idx].speed_mbps)\
                         if nbr.local_port_idx in sw.interfaces else "1G"
            link = TopologyLink(
                local_ip      = ip,
                local_port    = nbr.local_port_desc or str(nbr.local_port_idx),
                remote_ip     = remote_ip,
                remote_sys    = nbr.remote_sys,
                remote_port   = nbr.remote_port,
                speed_label   = spd_label,
            )
            db.add(link)
            link_count += 1

    db.commit()

    return ScanResult(
        scanned = len(credentials),
        found   = len(switch_data),
        links   = link_count,
        errors  = errors,
    )


# ─── Topology ─────────────────────────────────────────────────────────────────

@app.get("/api/topology", response_model=TopologyOut)
def get_topology(db: Session = Depends(get_db)):
    nodes   = db.query(Device).all()
    links   = db.query(TopologyLink).all()
    racks   = db.query(RackModel).order_by(RackModel.id).all()
    classes = db.query(SwitchClassModel).order_by(SwitchClassModel.id).all()
    return TopologyOut(nodes=nodes, links=links, racks=racks, classes=classes)


@app.patch("/api/topology/devices/{device_id}/position", response_model=DeviceOut)
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


@app.patch("/api/topology/devices/{device_id}/meta", response_model=DeviceOut)
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

    db.commit()
    db.refresh(device)
    return device


# ─── Map Background ──────────────────────────────────────────────────────────

MAP_BG_DIR = "/data"
MAP_BG_FILENAME = "map-background"
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


def _find_bg_file():
    """Return the path of the stored background image, or None."""
    for ext in ALLOWED_EXTENSIONS:
        path = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
        if os.path.isfile(path):
            return path
    return None


def _clear_bg_files():
    """Remove any existing background image files."""
    for ext in ALLOWED_EXTENSIONS:
        path = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
        if os.path.isfile(path):
            os.remove(path)


@app.post("/api/map-background")
async def upload_map_background(file: UploadFile = File(...)):
    """Upload or replace the map background image."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")

    # Read and check size
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)} MB.")

    _clear_bg_files()

    dest = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
    with open(dest, "wb") as f:
        f.write(contents)

    return {"ok": True, "filename": file.filename, "size": len(contents)}


@app.get("/api/map-background")
def get_map_background():
    """Return the stored background image file."""
    path = _find_bg_file()
    if not path:
        raise HTTPException(404, "No background image set")
    return FileResponse(path)


@app.delete("/api/map-background")
def delete_map_background():
    """Remove the background image."""
    _clear_bg_files()
    return {"ok": True}


# ─── Map Settings ─────────────────────────────────────────────────────────────

MAP_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "map-settings.json")
DEFAULT_MAP_SETTINGS = {"opacity": 0.3, "scale": 1.0}


def _read_map_settings():
    try:
        with open(MAP_SETTINGS_PATH, "r") as f:
            return {**DEFAULT_MAP_SETTINGS, **json.load(f)}
    except (FileNotFoundError, json.JSONDecodeError):
        return {**DEFAULT_MAP_SETTINGS}


def _write_map_settings(data):
    merged = {**_read_map_settings(), **data}
    with open(MAP_SETTINGS_PATH, "w") as f:
        json.dump(merged, f)
    return merged


@app.get("/api/map-settings")
def get_map_settings():
    """Return persisted map background settings (opacity, scale)."""
    return _read_map_settings()


@app.put("/api/map-settings")
async def update_map_settings(request: Request):
    """Update map background settings."""
    body = await request.json()
    allowed = {}
    if "opacity" in body:
        allowed["opacity"] = float(body["opacity"])
    if "scale" in body:
        allowed["scale"] = float(body["scale"])
    return _write_map_settings(allowed)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _resolve_ip(sys_name: str, switch_data: dict) -> str:
    """Try to find the management IP of a device by sysName in the scan batch."""
    for ip, sw in switch_data.items():
        if sw.sys_name and sys_name.lower() in sw.sys_name.lower():
            return ip
    try:
        return socket.gethostbyname(sys_name)
    except Exception:
        return ""


