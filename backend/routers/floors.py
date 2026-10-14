"""Buildings and floors of the topology map, including per-floor background images."""
from typing import List

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import Building, Device, Floor, Rack, get_db
from routers.topology import _bump_topo_version
from schemas import BuildingCreate, BuildingOut, BuildingUpdate, FloorCreate, FloorOut, FloorUpdate
from shared import file_settings
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

DEFAULT_BUILDING_LABEL = "Main building"
DEFAULT_FLOOR_LABEL = "Ground floor"


# ─── Helpers ──────────────────────────────────────────────────────────────────

def ordered_buildings(db: Session) -> list[Building]:
    return db.query(Building).order_by(Building.sort_order, Building.id).all()


def get_default_floor(db: Session) -> Floor | None:
    """First floor ordered by building (sort_order, id), then floor (sort_order, id)."""
    return (
        db.query(Floor)
        .join(Building, Floor.building_id == Building.id)
        .order_by(Building.sort_order, Building.id, Floor.sort_order, Floor.id)
        .first()
    )


def ensure_default_floor(db: Session) -> Floor:
    """Return the default floor, creating "Main building" / "Ground floor" when none exists."""
    floor = get_default_floor(db)
    if floor:
        return floor
    building = db.query(Building).order_by(Building.sort_order, Building.id).first()
    if not building:
        building = Building(label=DEFAULT_BUILDING_LABEL, sort_order=0)
        db.add(building)
        db.flush()
    floor = Floor(building_id=building.id, label=DEFAULT_FLOOR_LABEL, sort_order=0)
    db.add(floor)
    db.commit()
    db.refresh(floor)
    _bump_topo_version()
    return floor


def _get_building(db: Session, building_id: int) -> Building:
    building = db.query(Building).filter(Building.id == building_id).first()
    if not building:
        api_error(404, "BUILDING_NOT_FOUND", "Building not found")
    return building


def get_floor_or_404(db: Session, floor_id: int) -> Floor:
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    if not floor:
        api_error(404, "FLOOR_NOT_FOUND", "Floor not found")
    return floor


def ensure_floor_exists(db: Session, floor_id: int | None):
    """Validate an optional floor reference (404 FLOOR_NOT_FOUND)."""
    if floor_id is not None:
        get_floor_or_404(db, floor_id)


def _detach_floors(db: Session, floor_ids: list[int]):
    """Null rack/device floor references explicitly (SQLite may not enforce ON DELETE SET NULL)."""
    if not floor_ids:
        return
    db.query(Rack).filter(Rack.floor_id.in_(floor_ids)).update({"floor_id": None}, synchronize_session=False)
    db.query(Device).filter(Device.floor_id.in_(floor_ids)).update({"floor_id": None}, synchronize_session=False)


def store_floor_background(db: Session, floor: Floor, ext: str, contents: bytes):
    """Replace the floor's background file with validated contents and bump bg_version."""
    file_settings.store_floor_bg_file(floor.id, ext, contents)
    floor.bg_ext = ext
    floor.bg_version = (floor.bg_version or 0) + 1
    db.commit()
    db.refresh(floor)
    _bump_topo_version()


def clear_floor_background(db: Session, floor: Floor):
    file_settings.clear_floor_bg_files(floor.id)
    floor.bg_ext = None
    floor.bg_version = (floor.bg_version or 0) + 1
    db.commit()
    db.refresh(floor)
    _bump_topo_version()


def floor_background_response(request: Request, floor: Floor | None):
    """Serve a floor background with the same hardening as GET /map-background."""
    file_settings.check_background_range(request)
    path = file_settings.find_floor_bg_file(floor.id, floor.bg_ext) if floor else None
    if not path:
        api_error(404, "NO_BACKGROUND_IMAGE", "No background image set")
    return file_settings.background_file_response(path)


# ─── Buildings ────────────────────────────────────────────────────────────────

@router.get("/buildings", response_model=List[BuildingOut])
def list_buildings(db: Session = Depends(get_db)):
    return ordered_buildings(db)


@router.post("/buildings", response_model=BuildingOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_building(body: BuildingCreate, request: Request, db: Session = Depends(get_db)):
    building = Building(**body.model_dump())
    db.add(building)
    db.commit()
    db.refresh(building)
    _bump_topo_version()
    log_audit(request, "create", "building", str(building.id), {"label": building.label})
    return building


@router.patch("/buildings/{building_id}", response_model=BuildingOut,
              dependencies=[require_role("admin", "operator")])
def update_building(building_id: int, body: BuildingUpdate, request: Request, db: Session = Depends(get_db)):
    building = _get_building(db, building_id)
    payload = body.model_dump(exclude_unset=True)
    for key, value in payload.items():
        # description is the only nullable field; explicit null clears it
        if value is not None or key == "description":
            setattr(building, key, value)
    db.commit()
    db.refresh(building)
    _bump_topo_version()
    log_audit(request, "update", "building", str(building_id), {"fields": list(payload.keys())})
    return building


@router.delete("/buildings/{building_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_building(building_id: int, request: Request, db: Session = Depends(get_db)):
    building = _get_building(db, building_id)
    floor_ids = [f.id for f in building.floors]
    _detach_floors(db, floor_ids)
    log_audit(request, "delete", "building", str(building_id), {"label": building.label, "floor_ids": floor_ids})
    db.delete(building)  # ORM cascade deletes the floors
    db.commit()
    for floor_id in floor_ids:
        file_settings.clear_floor_bg_files(floor_id)
    _bump_topo_version()


# ─── Floors ───────────────────────────────────────────────────────────────────

@router.post("/buildings/{building_id}/floors", response_model=FloorOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
def create_floor(building_id: int, body: FloorCreate, request: Request, db: Session = Depends(get_db)):
    _get_building(db, building_id)
    floor = Floor(building_id=building_id, **body.model_dump())
    db.add(floor)
    db.commit()
    db.refresh(floor)
    _bump_topo_version()
    log_audit(request, "create", "floor", str(floor.id), {"label": floor.label, "building_id": building_id})
    return floor


@router.patch("/floors/{floor_id}", response_model=FloorOut,
              dependencies=[require_role("admin", "operator")])
def update_floor(floor_id: int, body: FloorUpdate, request: Request, db: Session = Depends(get_db)):
    floor = get_floor_or_404(db, floor_id)
    payload = body.model_dump(exclude_unset=True)
    if payload.get("building_id") is not None:
        _get_building(db, payload["building_id"])
    # No floor field is nullable; explicit null values are ignored
    for key, value in payload.items():
        if value is not None:
            setattr(floor, key, value)
    db.commit()
    db.refresh(floor)
    _bump_topo_version()
    log_audit(request, "update", "floor", str(floor_id), {"fields": list(payload.keys())})
    return floor


@router.delete("/floors/{floor_id}", status_code=204,
               dependencies=[require_role("admin")])
def delete_floor(floor_id: int, request: Request, db: Session = Depends(get_db)):
    floor = get_floor_or_404(db, floor_id)
    _detach_floors(db, [floor_id])
    log_audit(request, "delete", "floor", str(floor_id), {"label": floor.label})
    db.delete(floor)
    db.commit()
    file_settings.clear_floor_bg_files(floor_id)
    _bump_topo_version()


# ─── Floor background ─────────────────────────────────────────────────────────

@router.post("/floors/{floor_id}/background", response_model=FloorOut,
             dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
async def upload_floor_background(
    floor_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
):
    """Upload or replace the background image of a floor."""
    # Sync DB and file I/O runs in the threadpool, off the event loop.
    floor = await run_in_threadpool(get_floor_or_404, db, floor_id)
    ext, contents = await file_settings.read_validated_background(file)

    def _store():
        store_floor_background(db, floor, ext, contents)
        log_audit(request, "update", "floor_background", str(floor_id),
                  {"filename": file.filename, "size": len(contents)})
        return FloorOut.model_validate(floor)

    return await run_in_threadpool(_store)


@router.get("/floors/{floor_id}/background")
def get_floor_background(floor_id: int, request: Request, db: Session = Depends(get_db)):
    """Return the stored background image of a floor (auth-exempt like /map-background)."""
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    return floor_background_response(request, floor)


@router.delete("/floors/{floor_id}/background", response_model=FloorOut,
               dependencies=[require_role("admin", "operator")])
def delete_floor_background(floor_id: int, request: Request, db: Session = Depends(get_db)):
    """Remove the background image of a floor."""
    floor = get_floor_or_404(db, floor_id)
    clear_floor_background(db, floor)
    log_audit(request, "delete", "floor_background", str(floor_id))
    return floor
