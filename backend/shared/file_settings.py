"""Settings helpers: DB-backed scan/DNS/map settings and file-system map background I/O."""
import json
import logging
import os
import re
import xml.etree.ElementTree as ET

import filetype
from defusedxml import ElementTree as SafeET
from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from shared.errors import api_error

_log = logging.getLogger(__name__)

# ─── Map Background (file-system) ──────────────────────────────────────────────

# Directory holding the per-floor background images. Read at call time (not
# imported by value) so tests and migration 026 can point it at a tmp dir.
MAP_BG_DIR = "/data"
# Legacy single background (/data/map-background.<ext>), moved to the default
# floor by migration 026.
MAP_BG_FILENAME = "map-background"
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
ALLOWED_IMAGE_TYPES = {"png", "jpeg", "jpg", "gif", "webp"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


def floor_bg_filename(floor_id: int, ext: str) -> str:
    """File name of a floor background, e.g. "floor-3-background.png"."""
    return f"floor-{floor_id}-background{ext}"


def floor_bg_path(floor_id: int, ext: str) -> str:
    return os.path.join(MAP_BG_DIR, floor_bg_filename(floor_id, ext))


def find_floor_bg_file(floor_id: int, ext: str | None):
    """Return the path of a floor's stored background image, or None."""
    if not ext:
        return None
    path = floor_bg_path(floor_id, ext)
    return path if os.path.isfile(path) else None


def clear_floor_bg_files(floor_id: int):
    """Remove any background image file of a floor (all allowed extensions)."""
    for ext in ALLOWED_EXTENSIONS:
        path = floor_bg_path(floor_id, ext)
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError as exc:
                _log.warning("Could not remove floor background %s: %s", path, exc)


def store_floor_bg_file(floor_id: int, ext: str, contents: bytes) -> str:
    """Replace a floor's background image file and return its path."""
    clear_floor_bg_files(floor_id)
    dest = floor_bg_path(floor_id, ext)
    with open(dest, "wb") as f:
        f.write(contents)
    return dest


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


async def read_validated_background(file: UploadFile) -> tuple[str, bytes]:
    """Validate an uploaded background image and return (extension, contents).

    Checks the extension, enforces MAX_FILE_SIZE with a bounded read, verifies
    raster images via magic bytes and sanitizes SVG documents.
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        api_error(400, "UNSUPPORTED_FILE_TYPE", f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}", field="file")

    # Read bounded: at most MAX_FILE_SIZE + 1 bytes so an oversized upload is
    # rejected without buffering the whole body in memory.
    contents = await file.read(MAX_FILE_SIZE + 1)
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
    return ext, contents


def check_background_range(request: Request):
    """Reject multi-range or oversized Range headers with 416."""
    # Backgrounds do not need multipart ranges. Bound parsing work even on
    # older Starlette installations vulnerable to quadratic range merging.
    ranges = request.headers.getlist("range")
    if len(ranges) > 1 or any(len(value) > 128 or "," in value for value in ranges):
        api_error(416, "INVALID_RANGE", "Only a single bounded byte range is supported")


def background_file_response(path: str) -> FileResponse:
    """Serve a stored background image with hardening headers."""
    return FileResponse(
        path,
        headers={
            # SVG is served from the app origin; keep it inert even if a
            # malicious file ever lands on disk. "inline" keeps <img> usable.
            "Content-Security-Policy": "script-src 'none'",
            "Content-Disposition": "inline",
        },
    )


# ─── DB-backed settings helpers ────────────────────────────────────────────────

def _get_db_session():
    """Get a fresh DB session for settings read/write."""
    from database import SessionLocal
    return SessionLocal()


def _read_db_setting(key: str, default: str = "") -> str:
    db = _get_db_session()
    try:
        from database import AppSetting
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        return row.value if row else default
    finally:
        db.close()


def _write_db_setting(key: str, value: str):
    db = _get_db_session()
    try:
        from database import AppSetting
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(AppSetting(key=key, value=value))
        db.commit()
    finally:
        db.close()


# ─── Scan Settings (DB-backed) ────────────────────────────────────────────────

DEFAULT_SCAN_SETTINGS = {"max_workers": 12, "snmp_timeout": 3, "snmp_retries": 1, "snmp_bulk_size": 25}
# GETBULK max-repetitions bounds; mirrors snmp_scanner.BULK_SIZE_MIN/MAX
# (not imported here so this module stays free of pysnmp).
_BULK_SIZE_MIN, _BULK_SIZE_MAX = 5, 100


def _normalize_scan_settings(value: dict | None):
    value = value or {}
    merged = {key: value.get(key, default) for key, default in DEFAULT_SCAN_SETTINGS.items()}
    try:
        merged = {key: int(v) for key, v in merged.items()}
    except (TypeError, ValueError):
        raise HTTPException(400, "Settings must be integers")
    return {
        "max_workers": max(1, min(128, merged["max_workers"])),
        "snmp_timeout": max(1, min(30, merged["snmp_timeout"])),
        "snmp_retries": max(0, min(10, merged["snmp_retries"])),
        "snmp_bulk_size": max(_BULK_SIZE_MIN, min(_BULK_SIZE_MAX, merged["snmp_bulk_size"])),
    }


# Endpoint pruning: days after which unseen endpoints are removed (0 = off).
# Stored under app_settings key "endpoint_retention_days", shared with the
# generic /settings API and the scan pruning.
ENDPOINT_RETENTION_DEFAULT_DAYS = 30
ENDPOINT_RETENTION_MIN_DAYS, ENDPOINT_RETENTION_MAX_DAYS = 0, 3650


def _clamp_endpoint_retention(days: int) -> int:
    return max(ENDPOINT_RETENTION_MIN_DAYS, min(ENDPOINT_RETENTION_MAX_DAYS, int(days)))


def _read_endpoint_retention_days() -> int:
    raw = _read_db_setting("endpoint_retention_days", str(ENDPOINT_RETENTION_DEFAULT_DAYS))
    try:
        return _clamp_endpoint_retention(int(str(raw).strip()))
    except ValueError:
        return ENDPOINT_RETENTION_DEFAULT_DAYS


def _read_scan_settings():
    return {
        "max_workers": max(1, min(128, int(_read_db_setting("scan_max_workers", "12")))),
        "snmp_timeout": max(1, min(30, int(_read_db_setting("scan_snmp_timeout", "3")))),
        "snmp_retries": max(0, min(10, int(_read_db_setting("scan_snmp_retries", "1")))),
        "snmp_bulk_size": max(_BULK_SIZE_MIN, min(_BULK_SIZE_MAX, int(_read_db_setting("scan_snmp_bulk_size", "25")))),
        "endpoint_retention_days": _read_endpoint_retention_days(),
    }


def _write_scan_settings(value: dict | None):
    payload = _normalize_scan_settings(value)
    _write_db_setting("scan_max_workers", str(payload["max_workers"]))
    _write_db_setting("scan_snmp_timeout", str(payload["snmp_timeout"]))
    _write_db_setting("scan_snmp_retries", str(payload["snmp_retries"]))
    _write_db_setting("scan_snmp_bulk_size", str(payload["snmp_bulk_size"]))
    # Only written when given, so an older client that omits the field does
    # not reset a value set via /settings.
    retention = (value or {}).get("endpoint_retention_days")
    if retention is not None:
        try:
            retention = _clamp_endpoint_retention(int(retention))
        except (TypeError, ValueError):
            raise HTTPException(400, "Settings must be integers")
        _write_db_setting("endpoint_retention_days", str(retention))
    payload["endpoint_retention_days"] = _read_endpoint_retention_days()
    return payload


# ─── DNS Settings (DB-backed) ─────────────────────────────────────────────────

DEFAULT_DNS_SETTINGS = {"servers": []}


def _normalize_dns_servers(value) -> list[str]:
    import ipaddress
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
    raw = _read_db_setting("dns_servers", "[]")
    try:
        servers = json.loads(raw)
        return {"servers": _normalize_dns_servers(servers) if isinstance(servers, list) else []}
    except Exception:
        return {**DEFAULT_DNS_SETTINGS}


def _write_dns_settings(servers: list[str]):
    validated = _normalize_dns_servers(servers)
    _write_db_setting("dns_servers", json.dumps(validated))
    return {"servers": validated}


# ─── Map Settings (DB-backed) ─────────────────────────────────────────────────

# Map background settings live on each floor (floors.bg_opacity/bg_scale/
# bg_color) since migration 026; these are the defaults reported by the legacy
# GET /map-settings when no floor exists yet.
DEFAULT_MAP_SETTINGS = {"opacity": 0.3, "scale": 1.0, "bg_color": "#020817"}
