"""Latency monitor settings stored in app_settings (key/value strings).

Readers clamp and fall back to defaults so a bad stored value never stops the
monitor; PUT /settings/{key} validates strictly via ``validate_setting_value``.
"""
from dataclasses import dataclass

DEFAULT_ENABLED = True
DEFAULT_INTERVAL_SEC = 10
DEFAULT_PINGS = 3
DEFAULT_MODE = "all"
DEFAULT_RETENTION_DAYS = 30

INT_RANGES = {
    "latency_interval_sec": (5, 300, DEFAULT_INTERVAL_SEC),
    "latency_pings": (1, 10, DEFAULT_PINGS),
    "latency_retention_days": (1, 365, DEFAULT_RETENTION_DAYS),
}
MODES = ("all", "selected")
LATENCY_SETTING_KEYS = ("latency_enabled", "latency_mode", *INT_RANGES)

# Seeded into app_settings on startup (string values, like all settings).
SETTING_DEFAULTS = {
    "latency_enabled": "true",
    "latency_interval_sec": str(DEFAULT_INTERVAL_SEC),
    "latency_pings": str(DEFAULT_PINGS),
    "latency_mode": DEFAULT_MODE,
    "latency_retention_days": str(DEFAULT_RETENTION_DAYS),
}

_TRUE = {"true", "1", "yes", "on"}
_FALSE = {"false", "0", "no", "off"}


@dataclass(frozen=True)
class LatencySettings:
    enabled: bool = DEFAULT_ENABLED
    interval_sec: int = DEFAULT_INTERVAL_SEC
    pings: int = DEFAULT_PINGS
    mode: str = DEFAULT_MODE
    retention_days: int = DEFAULT_RETENTION_DAYS


def _clamped_int(raw, key: str) -> int:
    low, high, default = INT_RANGES[key]
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def parse_settings(raw: dict) -> LatencySettings:
    """Build LatencySettings from a ``key -> value`` dict, tolerating bad values."""
    enabled_raw = str(raw.get("latency_enabled", "true")).strip().lower()
    mode = str(raw.get("latency_mode", DEFAULT_MODE)).strip().lower()
    return LatencySettings(
        enabled=enabled_raw not in _FALSE,
        interval_sec=_clamped_int(raw.get("latency_interval_sec", DEFAULT_INTERVAL_SEC), "latency_interval_sec"),
        pings=_clamped_int(raw.get("latency_pings", DEFAULT_PINGS), "latency_pings"),
        mode=mode if mode in MODES else DEFAULT_MODE,
        retention_days=_clamped_int(
            raw.get("latency_retention_days", DEFAULT_RETENTION_DAYS), "latency_retention_days"
        ),
    )


def read_settings(db) -> LatencySettings:
    from database import AppSetting

    rows = db.query(AppSetting).filter(AppSetting.key.in_(LATENCY_SETTING_KEYS)).all()
    return parse_settings({row.key: row.value for row in rows})


def validate_setting_value(key: str, value: str) -> str:
    """Return the normalized value for a latency key or raise ValueError."""
    text = str(value).strip().lower()
    if key == "latency_enabled":
        if text in _TRUE:
            return "true"
        if text in _FALSE:
            return "false"
        raise ValueError("latency_enabled must be 'true' or 'false'")
    if key == "latency_mode":
        if text in MODES:
            return text
        raise ValueError("latency_mode must be 'all' or 'selected'")
    if key in INT_RANGES:
        low, high, _ = INT_RANGES[key]
        try:
            number = int(text)
        except ValueError:
            raise ValueError(f"{key} must be an integer") from None
        if not low <= number <= high:
            raise ValueError(f"{key} must be between {low} and {high}")
        return str(number)
    raise ValueError(f"{key} is not a latency setting")
