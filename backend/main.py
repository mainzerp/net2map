"""FastAPI application – NetMap backend."""
import json
import logging
import os
import socket
import shutil
import ipaddress
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from database import (
    Credential, Device, Port, TopologyLink, SnmpProfile,
    ScanRun, ScanRunSwitchMetric, SessionLocal,
    Rack as RackModel, SwitchClass as SwitchClassModel,
    create_tables, get_db,
)
from schemas import (
    CredentialCreate, CredentialOut, CredentialUpdate,
    DeviceOut, DevicePositionUpdate, DeviceMetaUpdate,
    ScanResult, ScanRunOut, ScanSwitchMetric, TopologyOut, TopologyLinkOut,
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


SCAN_JOBS: Dict[str, dict] = {}
SCAN_JOBS_LOCK = threading.Lock()


@app.on_event("startup")
def on_startup():
    create_tables()

# ─── SNMP Profiles ───────────────────────────────────────────────────────────────

@app.get("/api/snmp-profiles", response_model=List[SnmpProfileOut])
def list_snmp_profiles(db: Session = Depends(get_db)):
    return db.query(SnmpProfile).order_by(SnmpProfile.id).all()


@app.post("/api/snmp-profiles", response_model=SnmpProfileOut, status_code=201)
def create_snmp_profile(body: SnmpProfileCreate, db: Session = Depends(get_db)):
    payload = body.model_dump()
    payload["snmp_timeout"] = max(1, min(30, int(payload.get("snmp_timeout", 3))))
    payload["snmp_retries"] = max(0, min(10, int(payload.get("snmp_retries", 1))))
    payload["max_parallel_hosts"] = max(1, min(64, int(payload.get("max_parallel_hosts", 8))))
    profile = SnmpProfile(**payload)
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@app.put("/api/snmp-profiles/{profile_id}", response_model=SnmpProfileOut)
def update_snmp_profile(profile_id: int, body: SnmpProfileUpdate, db: Session = Depends(get_db)):
    profile = db.query(SnmpProfile).filter(SnmpProfile.id == profile_id).first()
    if not profile:
        raise HTTPException(404, "Profile not found")
    payload = body.model_dump(exclude_none=True)
    if "snmp_timeout" in payload:
        payload["snmp_timeout"] = max(1, min(30, int(payload["snmp_timeout"])))
    if "snmp_retries" in payload:
        payload["snmp_retries"] = max(0, min(10, int(payload["snmp_retries"])))
    if "max_parallel_hosts" in payload:
        payload["max_parallel_hosts"] = max(1, min(64, int(payload["max_parallel_hosts"])))

    for k, v in payload.items():
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

def _coerce_profile_policy(profile: Optional[SnmpProfile]) -> tuple[int, int, int]:
    if not profile:
        return 3, 1, 8
    timeout = max(1, min(30, int(profile.snmp_timeout or 3)))
    retries = max(0, min(10, int(profile.snmp_retries or 1)))
    max_hosts = max(1, min(64, int(profile.max_parallel_hosts or 8)))
    return timeout, retries, max_hosts


def _persist_scan_run(db: Session, result: ScanResult) -> int:
    run = ScanRun(
        status=result.status,
        scanned=result.scanned,
        found=result.found,
        links=result.links,
        max_workers=result.max_workers,
        total_duration_ms=result.total_duration_ms,
        error_count=len(result.errors or []),
    )
    db.add(run)
    db.flush()

    for metric in result.switch_metrics:
        db.add(ScanRunSwitchMetric(
            scan_run_id=run.id,
            ip=metric.ip,
            label=metric.label,
            duration_ms=metric.duration_ms,
            success=metric.success,
            error=metric.error,
        ))

    db.commit()
    return run.id


def _execute_scan(db: Session, cancel_event: Optional[threading.Event] = None) -> ScanResult:
    credentials = db.query(Credential).filter(Credential.enabled == True).all()
    scan_settings = _read_scan_settings()
    configured_max_workers = scan_settings.get("max_workers", 4)

    if not credentials:
        return ScanResult(
            scanned=0,
            found=0,
            links=0,
            errors=["No enabled credentials"],
            max_workers=configured_max_workers,
            total_duration_ms=0,
            switch_metrics=[],
            status="finished",
        )

    errors: List[str] = []
    switch_data: Dict[str, SwitchData] = {}
    switch_metrics: List[ScanSwitchMetric] = []

    scan_targets = []
    profile_limits: Dict[str, int] = {}

    for cred in credentials:
        p = cred.profile
        snmp_timeout, snmp_retries, profile_max_hosts = _coerce_profile_policy(p)
        profile_key = f"profile:{p.id}" if p else f"cred:{cred.id}"
        profile_limits[profile_key] = profile_max_hosts

        scan_targets.append({
            "ip": cred.ip,
            "label": cred.label,
            "profile_key": profile_key,
            "snmp_port": cred.snmp_port,
            "snmp_version": p.snmp_version if p else cred.snmp_version,
            "community": p.community if p else cred.community,
            "v3_security_level": p.v3_security_level if p else cred.v3_security_level,
            "v3_username": p.v3_username if p else cred.v3_username,
            "v3_auth_protocol": p.v3_auth_protocol if p else cred.v3_auth_protocol,
            "v3_auth_password": p.v3_auth_password if p else cred.v3_auth_password,
            "v3_priv_protocol": p.v3_priv_protocol if p else cred.v3_priv_protocol,
            "v3_priv_password": p.v3_priv_password if p else cred.v3_priv_password,
            "snmp_timeout": snmp_timeout,
            "snmp_retries": snmp_retries,
        })

    profile_semaphores = {
        k: threading.BoundedSemaphore(v) for k, v in profile_limits.items()
    }

    def _scan_target(target: dict):
        started = time.perf_counter()
        ip = target["ip"]
        label = target["label"]

        if cancel_event and cancel_event.is_set():
            duration_ms = int((time.perf_counter() - started) * 1000)
            return ip, label, None, "cancelled", duration_ms

        sem = profile_semaphores[target["profile_key"]]
        with sem:
            if cancel_event and cancel_event.is_set():
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, "cancelled", duration_ms
            try:
                data = scan_switch(
                    ip=ip,
                    snmp_version=target["snmp_version"],
                    community=target["community"],
                    snmp_port=target["snmp_port"],
                    snmp_timeout=target["snmp_timeout"],
                    snmp_retries=target["snmp_retries"],
                    v3_security_level=target["v3_security_level"],
                    v3_username=target["v3_username"],
                    v3_auth_protocol=target["v3_auth_protocol"],
                    v3_auth_password=target["v3_auth_password"],
                    v3_priv_protocol=target["v3_priv_protocol"],
                    v3_priv_password=target["v3_priv_password"],
                )
                duration_ms = int((time.perf_counter() - started) * 1000)
                if data:
                    return ip, label, data, "", duration_ms
                return ip, label, None, "no SNMP response", duration_ms
            except Exception as exc:
                duration_ms = int((time.perf_counter() - started) * 1000)
                return ip, label, None, str(exc), duration_ms

    scan_started = time.perf_counter()
    workers = max(1, min(int(configured_max_workers), len(scan_targets)))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_scan_target, target) for target in scan_targets]
        for fut in as_completed(futures):
            ip, label, data, error_msg, duration_ms = fut.result()
            if data:
                switch_data[ip] = data
                switch_metrics.append(ScanSwitchMetric(
                    ip=ip, label=label, duration_ms=duration_ms, success=True, error=""
                ))
            else:
                if error_msg and error_msg != "cancelled":
                    errors.append(f"{ip}: {error_msg}")
                switch_metrics.append(ScanSwitchMetric(
                    ip=ip, label=label, duration_ms=duration_ms,
                    success=False, error=error_msg or "no SNMP response"
                ))

    total_duration_ms = int((time.perf_counter() - scan_started) * 1000)
    switch_metrics.sort(key=lambda m: m.duration_ms, reverse=True)
    status = "cancelled" if (cancel_event and cancel_event.is_set()) else "finished"

    if not switch_data:
        return ScanResult(
            scanned=len(credentials),
            found=0,
            links=0,
            errors=errors,
            max_workers=workers,
            total_duration_ms=total_duration_ms,
            switch_metrics=switch_metrics,
            status=status,
        )

    existing_ips = {d.ip for d in db.query(Device.ip).all()}
    new_ips = [ip for ip in switch_data if ip not in existing_ips]
    all_ips_ordered = list(existing_ips) + new_ips
    layout = auto_layout(all_ips_ordered)

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
            db.add(Device(
                ip=ip,
                sys_name=sw.sys_name,
                sys_descr=sw.sys_descr,
                model=model,
                vendor=sw.vendor,
                location=sw.location,
                map_x=x,
                map_y=y,
            ))

    db.flush()

    dns_cache: Dict[str, str] = {}
    dns_servers = _read_dns_settings().get("servers", [])

    for ip, sw in switch_data.items():
        device = db.query(Device).filter(Device.ip == ip).first()
        if not device:
            continue

        peers_by_ifindex: Dict[int, List[tuple[str, str, str]]] = {}
        for mac, peer_ip in sw.arp_table.items():
            ifindex = sw.mac_ifindex.get(mac)
            if ifindex is None or not peer_ip:
                continue
            peer_host = _resolve_host(peer_ip, dns_cache, dns_servers)
            peers_by_ifindex.setdefault(ifindex, []).append((mac, peer_ip, peer_host))

        db.query(Port).filter(Port.device_id == device.id).delete()
        for iface in sw.interfaces.values():
            if is_virtual(iface.descr, sw.vendor):
                continue

            peer_mac = ""
            peer_ip = ""
            peer_host = ""
            if iface.index in peers_by_ifindex and peers_by_ifindex[iface.index]:
                peer_mac, peer_ip, peer_host = sorted(
                    peers_by_ifindex[iface.index], key=lambda x: x[1]
                )[0]

            db.add(Port(
                device_id=device.id,
                if_index=iface.index,
                if_descr=iface.descr,
                if_alias=iface.alias,
                speed_mbps=iface.speed_mbps,
                oper_status=iface.oper_status,
                peer_mac=peer_mac,
                peer_ip=peer_ip,
                peer_host=peer_host,
            ))

    scanned_ips = set(switch_data.keys())
    db.query(TopologyLink).filter(TopologyLink.local_ip.in_(scanned_ips)).delete(
        synchronize_session=False
    )

    link_count = 0
    for ip, sw in switch_data.items():
        for nbr in sw.lldp_neighbors:
            if not nbr.remote_sys:
                continue
            remote_ip = _resolve_ip(nbr.remote_sys, switch_data)
            spd_label = speed_label(sw.interfaces[nbr.local_port_idx].speed_mbps) \
                if nbr.local_port_idx in sw.interfaces else "1G"
            db.add(TopologyLink(
                local_ip=ip,
                local_port=nbr.local_port_desc or str(nbr.local_port_idx),
                remote_ip=remote_ip,
                remote_sys=nbr.remote_sys,
                remote_port=nbr.remote_port,
                speed_label=spd_label,
            ))
            link_count += 1

    result = ScanResult(
        scanned=len(credentials),
        found=len(switch_data),
        links=link_count,
        errors=errors,
        max_workers=workers,
        total_duration_ms=total_duration_ms,
        switch_metrics=switch_metrics,
        status=status,
    )
    result.run_id = _persist_scan_run(db, result)
    return result


def _run_scan_job(job_id: str, cancel_event: threading.Event):
    db = SessionLocal()
    try:
        result = _execute_scan(db, cancel_event)
    except Exception as exc:
        result = ScanResult(
            scanned=0,
            found=0,
            links=0,
            errors=[str(exc)],
            max_workers=1,
            total_duration_ms=0,
            switch_metrics=[],
            status="failed",
        )
    finally:
        db.close()

    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            return
        state["finished_at"] = datetime.utcnow().isoformat()
        state["result"] = result.model_dump()
        state["status"] = result.status if result.status in {"finished", "cancelled"} else "failed"


@app.post("/api/scan", response_model=ScanResult)
def run_scan(db: Session = Depends(get_db)):
    """Synchronous scan execution (compatibility endpoint)."""
    return _execute_scan(db, None)


@app.post("/api/scan/jobs")
def start_scan_job():
    """Start background scan job and return job ID immediately."""
    job_id = str(uuid.uuid4())
    cancel_event = threading.Event()

    with SCAN_JOBS_LOCK:
        SCAN_JOBS[job_id] = {
            "id": job_id,
            "status": "running",
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
            "result": None,
            "cancel_requested": False,
            "cancel_event": cancel_event,
            "thread": None,
        }

    t = threading.Thread(target=_run_scan_job, args=(job_id, cancel_event), daemon=True)
    with SCAN_JOBS_LOCK:
        SCAN_JOBS[job_id]["thread"] = t
    t.start()

    return {"job_id": job_id, "status": "running"}


@app.get("/api/scan/jobs/{job_id}")
def get_scan_job(job_id: str):
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            raise HTTPException(404, "Scan job not found")
        return {
            "id": state["id"],
            "status": state["status"],
            "started_at": state["started_at"],
            "finished_at": state["finished_at"],
            "cancel_requested": state["cancel_requested"],
            "result": state["result"],
        }


@app.post("/api/scan/jobs/{job_id}/cancel")
def cancel_scan_job(job_id: str):
    with SCAN_JOBS_LOCK:
        state = SCAN_JOBS.get(job_id)
        if not state:
            raise HTTPException(404, "Scan job not found")
        if state["status"] != "running":
            return {"id": job_id, "status": state["status"], "cancel_requested": state["cancel_requested"]}
        state["cancel_requested"] = True
        state["cancel_event"].set()
        return {"id": job_id, "status": state["status"], "cancel_requested": True}


@app.get("/api/scan-runs", response_model=List[ScanRunOut])
def list_scan_runs(limit: int = 20, db: Session = Depends(get_db)):
    clamped = max(1, min(200, limit))
    runs = db.query(ScanRun).order_by(ScanRun.created_at.desc()).limit(clamped).all()

    out: List[ScanRunOut] = []
    for run in runs:
        metrics = [
            ScanSwitchMetric(
                ip=m.ip,
                label=m.label,
                duration_ms=m.duration_ms,
                success=bool(m.success),
                error=m.error or "",
            )
            for m in run.switch_metrics
        ]
        out.append(ScanRunOut(
            id=run.id,
            status=run.status,
            scanned=run.scanned,
            found=run.found,
            links=run.links,
            max_workers=run.max_workers,
            total_duration_ms=run.total_duration_ms,
            error_count=run.error_count,
            created_at=run.created_at,
            switch_metrics=metrics,
        ))
    return out


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


# ─── Scan Settings ────────────────────────────────────────────────────────────

SCAN_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "scan-settings.json")
DEFAULT_SCAN_SETTINGS = {"max_workers": 4}


def _normalize_scan_settings(value: dict | None):
    value = value or {}
    max_workers = value.get("max_workers", DEFAULT_SCAN_SETTINGS["max_workers"])
    try:
        max_workers = int(max_workers)
    except (TypeError, ValueError):
        raise HTTPException(400, "'max_workers' must be an integer")
    max_workers = max(1, min(128, max_workers))
    return {"max_workers": max_workers}


def _read_scan_settings():
    try:
        with open(SCAN_SETTINGS_PATH, "r") as f:
            raw = json.load(f)
            return _normalize_scan_settings(raw)
    except (FileNotFoundError, json.JSONDecodeError):
        return {**DEFAULT_SCAN_SETTINGS}


def _write_scan_settings(value: dict | None):
    os.makedirs(os.path.dirname(SCAN_SETTINGS_PATH), exist_ok=True)
    payload = _normalize_scan_settings(value)
    with open(SCAN_SETTINGS_PATH, "w") as f:
        json.dump(payload, f)
    return payload


@app.get("/api/scan-settings")
def get_scan_settings():
    """Return scan execution settings."""
    return _read_scan_settings()


@app.put("/api/scan-settings")
async def update_scan_settings(request: Request):
    """Update scan execution settings."""
    body = await request.json()
    return _write_scan_settings(body)


# ─── DNS Settings ─────────────────────────────────────────────────────────────

DNS_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "dns-settings.json")
DEFAULT_DNS_SETTINGS = {"servers": []}


def _normalize_dns_servers(value) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(400, "'servers' must be an array of IP addresses")

    normalized: list[str] = []
    for item in value:
        server = str(item).strip()
        if not server:
            continue
        try:
            normalized.append(str(ipaddress.ip_address(server)))
        except ValueError:
            raise HTTPException(400, f"Invalid DNS server IP: {server}")

    # preserve order, remove duplicates
    return list(dict.fromkeys(normalized))


def _read_dns_settings():
    try:
        with open(DNS_SETTINGS_PATH, "r") as f:
            data = json.load(f)
            return {"servers": _normalize_dns_servers(data.get("servers", []))}
    except FileNotFoundError:
        return {**DEFAULT_DNS_SETTINGS}
    except json.JSONDecodeError:
        return {**DEFAULT_DNS_SETTINGS}


def _write_dns_settings(servers: list[str]):
    os.makedirs(os.path.dirname(DNS_SETTINGS_PATH), exist_ok=True)
    payload = {"servers": _normalize_dns_servers(servers)}
    with open(DNS_SETTINGS_PATH, "w") as f:
        json.dump(payload, f)
    return payload


@app.get("/api/dns-settings")
def get_dns_settings():
    """Return configured DNS servers for reverse lookups."""
    return _read_dns_settings()


@app.put("/api/dns-settings")
async def update_dns_settings(request: Request):
    """Update configured DNS servers for reverse lookups."""
    body = await request.json()
    return _write_dns_settings(body.get("servers", []))


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


def _resolve_host(ip: str, cache: dict[str, str], dns_servers: list[str] | None = None) -> str:
    """Best-effort reverse DNS lookup with per-scan cache."""
    if not ip:
        return ""
    if ip in cache:
        return cache[ip]

    if dns_servers:
        try:
            import dns.resolver
            import dns.reversename

            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = dns_servers
            resolver.timeout = 1.5
            resolver.lifetime = 2.5
            query_name = dns.reversename.from_address(ip)
            answers = resolver.resolve(query_name, "PTR")
            host = str(answers[0]).rstrip(".") if answers else ""
            cache[ip] = host
            return host
        except Exception:
            pass

    try:
        cache[ip] = socket.gethostbyaddr(ip)[0]
    except Exception:
        cache[ip] = ""
    return cache[ip]


