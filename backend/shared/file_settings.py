"""File-system constants and read/write helpers for map, scan, and DNS settings."""
import json
import os

from fastapi import HTTPException

# ─── Map Background ────────────────────────────────────────────────────────────

MAP_BG_DIR = "/data"
MAP_BG_FILENAME = "map-background"
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
ALLOWED_IMAGE_TYPES = {"png", "jpeg", "gif", "webp"}
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


# ─── Map Settings ──────────────────────────────────────────────────────────────

MAP_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "map-settings.json")
DEFAULT_MAP_SETTINGS = {"opacity": 0.3, "scale": 1.0, "bg_color": "#020817"}


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


# ─── Scan Settings ─────────────────────────────────────────────────────────────

SCAN_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "scan-settings.json")
DEFAULT_SCAN_SETTINGS = {"max_workers": 4, "snmp_timeout": 3, "snmp_retries": 1}


def _normalize_scan_settings(value: dict | None):
    value = value or {}
    max_workers = value.get("max_workers", DEFAULT_SCAN_SETTINGS["max_workers"])
    snmp_timeout = value.get("snmp_timeout", DEFAULT_SCAN_SETTINGS["snmp_timeout"])
    snmp_retries = value.get("snmp_retries", DEFAULT_SCAN_SETTINGS["snmp_retries"])
    try:
        max_workers = int(max_workers)
        snmp_timeout = int(snmp_timeout)
        snmp_retries = int(snmp_retries)
    except (TypeError, ValueError):
        raise HTTPException(400, "Settings must be integers")
    max_workers = max(1, min(128, max_workers))
    snmp_timeout = max(1, min(30, snmp_timeout))
    snmp_retries = max(0, min(10, snmp_retries))
    return {"max_workers": max_workers, "snmp_timeout": snmp_timeout, "snmp_retries": snmp_retries}


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


# ─── DNS Settings ──────────────────────────────────────────────────────────────

DNS_SETTINGS_PATH = os.path.join(MAP_BG_DIR, "dns-settings.json")
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
