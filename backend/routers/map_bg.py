"""Map background image and map settings endpoints."""
import os
import re

import filetype
from defusedxml import ElementTree as SafeET
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from slowapi import Limiter
from slowapi.util import get_remote_address

from schemas import MapSettingsOut, MapSettingsUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error
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
limiter = Limiter(key_func=get_remote_address)


def _sanitize_svg(raw: bytes) -> bytes:
    """Strip script tags, event handlers, and external entities from SVG."""
    try:
        SafeET.fromstring(raw)
    except Exception:
        raise HTTPException(400, detail={"error": {"code": "INVALID_SVG", "message": "Invalid or malicious SVG file"}})
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'\s+on\w+\s*=\s*"[^"]*"', "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+on\w+\s*=\s*'[^']*'", "", text, flags=re.IGNORECASE)
    return text.encode("utf-8")


@router.post("/api/map-background",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
async def upload_map_background(request: Request, file: UploadFile = File(...)):
    """Upload or replace the map background image."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        api_error(400, "UNSUPPORTED_FILE_TYPE", f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}", field="file")

    # Read and check size
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        api_error(400, "FILE_TOO_LARGE", f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)} MB.", field="file")

    # Validate MIME type via magic bytes (skip for SVG which is text-based)
    if ext == ".svg":
        contents = _sanitize_svg(contents)
    else:
        kind = filetype.guess(contents)
        detected = kind.extension if kind else None
        if detected not in ALLOWED_IMAGE_TYPES:
            api_error(400, "UNSUPPORTED_IMAGE_TYPE", f"Unsupported image type: {detected or 'unknown'}. Allowed: png, jpeg, gif, webp.", field="file")

    _clear_bg_files()

    dest = os.path.join(MAP_BG_DIR, MAP_BG_FILENAME + ext)
    with open(dest, "wb") as f:
        f.write(contents)

    log_audit(request, "settings_change", "map_background", "", {"filename": file.filename, "size": len(contents)})
    return {"ok": True, "filename": file.filename, "size": len(contents)}


@router.get("/api/map-background")
def get_map_background():
    """Return the stored background image file."""
    path = _find_bg_file()
    if not path:
        api_error(404, "NO_BACKGROUND_IMAGE", "No background image set")
    return FileResponse(path)


@router.delete("/api/map-background",
               dependencies=[require_role("admin")])
def delete_map_background(request: Request):
    """Remove the background image."""
    _clear_bg_files()
    log_audit(request, "delete", "map_background", "")
    return {"ok": True}


@router.get("/api/map-settings", response_model=MapSettingsOut)
def get_map_settings():
    """Return persisted map background settings (opacity, scale)."""
    return _read_map_settings()


@router.put("/api/map-settings", response_model=MapSettingsOut,
            dependencies=[require_role("admin", "operator")])
def update_map_settings(body: MapSettingsUpdate, request: Request):
    """Update map background settings."""
    updates = body.model_dump(exclude_none=True)
    result = _write_map_settings(updates)
    log_audit(request, "settings_change", "map_settings", "", updates)
    return result
