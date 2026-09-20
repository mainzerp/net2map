"""Map background image and map settings endpoints."""
import os
import re
import xml.etree.ElementTree as ET

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

_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"

# Allowlist of SVG elements kept in uploaded backgrounds. Anything else
# (script, foreignObject, set/animate, style, a, ...) is dropped entirely.
_SVG_ALLOWED_ELEMENTS = {
    "svg", "g", "defs", "title", "desc", "symbol", "use", "marker",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "image", "pattern", "clippath",
    "lineargradient", "radialgradient", "stop",
}

_UNSAFE_URI_RE = re.compile(r"[\x00-\x20]*(?:javascript|vbscript)\s*:", re.IGNORECASE)
_EXTERNAL_URL_RE = re.compile(r"url\(\s*[\"']?\s*(?!#)", re.IGNORECASE)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _sanitize_svg_element(elem) -> None:
    """Recursively strip disallowed elements and dangerous attributes in place."""
    for child in list(elem):
        if _local_name(child.tag) not in _SVG_ALLOWED_ELEMENTS:
            elem.remove(child)
            continue
        _sanitize_svg_element(child)

    for attr in list(elem.attrib):
        local = _local_name(attr)
        value = elem.attrib[attr]
        if local.startswith("on"):
            del elem.attrib[attr]
        elif _UNSAFE_URI_RE.match(value):
            del elem.attrib[attr]
        elif local == "href":
            # Only internal fragment references and inline data images survive
            if not (value.startswith("#") or value.startswith("data:image/")):
                del elem.attrib[attr]
        elif _EXTERNAL_URL_RE.search(value):
            del elem.attrib[attr]


def _sanitize_svg(raw: bytes) -> bytes:
    """Parse SVG and re-serialize it with only allowlisted content."""
    try:
        root = SafeET.fromstring(raw)
    except Exception:
        raise HTTPException(400, detail={"error": {"code": "INVALID_SVG", "message": "Invalid or malicious SVG file"}})
    if _local_name(root.tag) != "svg":
        raise HTTPException(400, detail={"error": {"code": "INVALID_SVG", "message": "File is not an SVG document"}})
    _sanitize_svg_element(root)
    ET.register_namespace("", _SVG_NS)
    ET.register_namespace("xlink", _XLINK_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


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
    return FileResponse(
        path,
        headers={
            # SVG is served from the app origin; keep it inert even if a
            # malicious file ever lands on disk. "inline" keeps <img> usable.
            "Content-Security-Policy": "script-src 'none'",
            "Content-Disposition": "inline",
        },
    )


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
