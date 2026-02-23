"""Map background image and map settings endpoints."""
import imghdr
import os

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from shared.file_settings import (
    ALLOWED_EXTENSIONS,
    ALLOWED_IMAGE_TYPES,
    MAP_BG_DIR,
    MAP_BG_FILENAME,
    MAX_FILE_SIZE,
    _clear_bg_files,
    _find_bg_file,
    _read_map_settings,
    _write_map_settings,
)

router = APIRouter()


@router.post("/api/map-background")
async def upload_map_background(file: UploadFile = File(...)):
    """Upload or replace the map background image."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")

    # Read and check size
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)} MB.")

    # Validate MIME type via magic bytes (skip for SVG which is text-based)
    if ext != ".svg":
        detected = imghdr.what(None, h=contents)
        if detected not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported image type: {detected or 'unknown'}. Allowed: png, jpeg, gif, webp.")

    _clear_bg_files()

    dest = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
    with open(dest, "wb") as f:
        f.write(contents)

    return {"ok": True, "filename": file.filename, "size": len(contents)}


@router.get("/api/map-background")
def get_map_background():
    """Return the stored background image file."""
    path = _find_bg_file()
    if not path:
        raise HTTPException(404, "No background image set")
    return FileResponse(path)


@router.delete("/api/map-background")
def delete_map_background():
    """Remove the background image."""
    _clear_bg_files()
    return {"ok": True}


@router.get("/api/map-settings")
def get_map_settings():
    """Return persisted map background settings (opacity, scale)."""
    return _read_map_settings()


@router.put("/api/map-settings")
async def update_map_settings(request: Request):
    """Update map background settings."""
    body = await request.json()
    allowed = {}
    if "opacity" in body:
        allowed["opacity"] = float(body["opacity"])
    if "scale" in body:
        allowed["scale"] = float(body["scale"])
    return _write_map_settings(allowed)
