"""Settings helpers: DB-backed scan/DNS/map settings and file-system map background I/O."""
import json
import logging
import os

from fastapi import HTTPException

_log = logging.getLogger(__name__)

# ─── Map Background (file-system) ──────────────────────────────────────────────

MAP_BG_DIR = "/data"
MAP_BG_FILENAME = "map-background"
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
ALLOWED_IMAGE_TYPES = {"png", "jpeg", "jpg", "gif", "webp"}
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


def _read_scan_settings():
    return {
        "max_workers": max(1, min(128, int(_read_db_setting("scan_max_workers", "12")))),
        "snmp_timeout": max(1, min(30, int(_read_db_setting("scan_snmp_timeout", "3")))),
        "snmp_retries": max(0, min(10, int(_read_db_setting("scan_snmp_retries", "1")))),
        "snmp_bulk_size": max(_BULK_SIZE_MIN, min(_BULK_SIZE_MAX, int(_read_db_setting("scan_snmp_bulk_size", "25")))),
    }


def _write_scan_settings(value: dict | None):
    payload = _normalize_scan_settings(value)
    _write_db_setting("scan_max_workers", str(payload["max_workers"]))
    _write_db_setting("scan_snmp_timeout", str(payload["snmp_timeout"]))
    _write_db_setting("scan_snmp_retries", str(payload["snmp_retries"]))
    _write_db_setting("scan_snmp_bulk_size", str(payload["snmp_bulk_size"]))
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

DEFAULT_MAP_SETTINGS = {"opacity": 0.3, "scale": 1.0, "bg_color": "#020817"}


def _read_map_settings():
    try:
        return {
            "opacity": float(_read_db_setting("map_opacity", "0.3")),
            "scale": float(_read_db_setting("map_scale", "1.0")),
            "bg_color": _read_db_setting("map_bg_color", "#020817"),
        }
    except (ValueError, TypeError):
        return {**DEFAULT_MAP_SETTINGS}


def _write_map_settings(data):
    current = _read_map_settings()
    merged = {**current, **data}
    _write_db_setting("map_opacity", str(merged["opacity"]))
    _write_db_setting("map_scale", str(merged["scale"]))
    _write_db_setting("map_bg_color", str(merged.get("bg_color", "#020817"))[:20])
    return merged
