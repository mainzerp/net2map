"""Map background image and map settings endpoints.

Deprecated: since migration 026 every floor has its own background and
settings (see routers/floors.py). These endpoints keep working and operate on
the default floor (first floor by building and floor order).
"""
from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import get_db
from routers.floors import (
    clear_floor_background,
    ensure_default_floor,
    floor_background_response,
    get_default_floor,
    store_floor_background,
)
from routers.topology import _bump_topo_version
from schemas import MapSettingsOut, MapSettingsUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.file_settings import DEFAULT_MAP_SETTINGS, read_validated_background

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


def _floor_map_settings(floor) -> dict:
    return {"opacity": floor.bg_opacity, "scale": floor.bg_scale, "bg_color": floor.bg_color}


@router.post("/map-background",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
async def upload_map_background(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload or replace the map background image."""
    ext, contents = await read_validated_background(file)

    def _store():
        # Sync DB and file I/O: run off the event loop.
        floor = ensure_default_floor(db)
        store_floor_background(db, floor, ext, contents)
        log_audit(request, "settings_change", "map_background", "",
                  {"filename": file.filename, "size": len(contents)})

    await run_in_threadpool(_store)
    return {"ok": True, "filename": file.filename, "size": len(contents)}


@router.get("/map-background")
def get_map_background(request: Request, db: Session = Depends(get_db)):
    """Return the stored background image file."""
    return floor_background_response(request, get_default_floor(db))


@router.delete("/map-background",
               dependencies=[require_role("admin")])
def delete_map_background(request: Request, db: Session = Depends(get_db)):
    """Remove the background image."""
    floor = get_default_floor(db)
    if floor:
        clear_floor_background(db, floor)
    log_audit(request, "delete", "map_background", "")
    return {"ok": True}


@router.get("/map-settings", response_model=MapSettingsOut)
def get_map_settings(db: Session = Depends(get_db)):
    """Return persisted map background settings (opacity, scale)."""
    floor = get_default_floor(db)
    return _floor_map_settings(floor) if floor else {**DEFAULT_MAP_SETTINGS}


@router.put("/map-settings", response_model=MapSettingsOut,
            dependencies=[require_role("admin", "operator")])
def update_map_settings(body: MapSettingsUpdate, request: Request, db: Session = Depends(get_db)):
    """Update map background settings."""
    updates = body.model_dump(exclude_none=True)
    floor = ensure_default_floor(db)
    if "opacity" in updates:
        floor.bg_opacity = updates["opacity"]
    if "scale" in updates:
        floor.bg_scale = updates["scale"]
    if "bg_color" in updates:
        floor.bg_color = updates["bg_color"]
    db.commit()
    db.refresh(floor)
    _bump_topo_version()
    log_audit(request, "settings_change", "map_settings", "", updates)
    return _floor_map_settings(floor)
