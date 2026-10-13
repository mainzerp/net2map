"""Device health collection and normalization for UPS and server devices.

Kept free of pysnmp dependencies: SNMP access is injected as two async
callables so the parsing stays unit-testable with fake OID -> value dicts.

- ``get(*oids)`` returns ``{oid: value_str}`` for the objects that answered.
- ``walk(oid)`` returns ``[(oid, value_str), ...]`` for a subtree.

Every collector returns a normalized dict (see ``parse_ups_health`` and
``parse_server_health``) or None when the device reported nothing. Failures
never raise: health is best effort and must not break a scan.

OID sources (verified against the published MIB files):
- RFC 1628 UPS-MIB (1.3.6.1.2.1.33)
- Eaton XUPS-MIB (1.3.6.1.4.1.534.1)
- HPE CPQPOWER-MIB, UPS branch (1.3.6.1.4.1.232.165.3)
- HPE CPQHLTH-MIB, CPQIDA-MIB, CPQSINFO-MIB, CPQSM2-MIB (1.3.6.1.4.1.232)
"""
import logging
from typing import Awaitable, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

log = logging.getLogger(__name__)

SnmpGet = Callable[..., Awaitable[Dict[str, str]]]
SnmpWalk = Callable[[str], Awaitable[List[Tuple[str, str]]]]

# --- RFC 1628 UPS-MIB ----------------------------------------------------------
OID_UPS_IDENT_MANUFACTURER = "1.3.6.1.2.1.33.1.1.1.0"
OID_UPS_IDENT_MODEL = "1.3.6.1.2.1.33.1.1.2.0"
OID_UPS_IDENT_SOFTWARE = "1.3.6.1.2.1.33.1.1.3.0"   # upsIdentUPSSoftwareVersion
OID_UPS_BATTERY_STATUS = "1.3.6.1.2.1.33.1.2.1.0"
OID_UPS_SECONDS_ON_BATTERY = "1.3.6.1.2.1.33.1.2.2.0"
OID_UPS_MINUTES_REMAINING = "1.3.6.1.2.1.33.1.2.3.0"
OID_UPS_CHARGE_REMAINING = "1.3.6.1.2.1.33.1.2.4.0"
OID_UPS_BATTERY_TEMPERATURE = "1.3.6.1.2.1.33.1.2.7.0"
OID_UPS_OUTPUT_SOURCE = "1.3.6.1.2.1.33.1.4.1.0"
OID_UPS_ALARMS_PRESENT = "1.3.6.1.2.1.33.1.6.1.0"
OID_UPS_INPUT_VOLTAGE = "1.3.6.1.2.1.33.1.3.3.1.3"         # table column, per input line
OID_UPS_OUTPUT_PERCENT_LOAD = "1.3.6.1.2.1.33.1.4.4.1.5"   # table column, per output line

UPS_MIB_SCALAR_OIDS = (
    OID_UPS_IDENT_MANUFACTURER, OID_UPS_IDENT_MODEL, OID_UPS_IDENT_SOFTWARE,
    OID_UPS_BATTERY_STATUS, OID_UPS_SECONDS_ON_BATTERY, OID_UPS_MINUTES_REMAINING,
    OID_UPS_CHARGE_REMAINING, OID_UPS_BATTERY_TEMPERATURE, OID_UPS_OUTPUT_SOURCE,
    OID_UPS_ALARMS_PRESENT,
)

# --- Eaton XUPS-MIB (fallback) --------------------------------------------------
OID_XUPS_IDENT_MANUFACTURER = "1.3.6.1.4.1.534.1.1.1.0"
OID_XUPS_IDENT_MODEL = "1.3.6.1.4.1.534.1.1.2.0"
OID_XUPS_IDENT_SOFTWARE = "1.3.6.1.4.1.534.1.1.3.0"
OID_XUPS_BAT_TIME_REMAINING = "1.3.6.1.4.1.534.1.2.1.0"   # seconds
OID_XUPS_BAT_CAPACITY = "1.3.6.1.4.1.534.1.2.4.0"         # percent
OID_XUPS_OUTPUT_LOAD = "1.3.6.1.4.1.534.1.4.1.0"          # percent
OID_XUPS_OUTPUT_SOURCE = "1.3.6.1.4.1.534.1.4.5.0"

XUPS_SCALAR_OIDS = (
    OID_XUPS_IDENT_MANUFACTURER, OID_XUPS_IDENT_MODEL, OID_XUPS_IDENT_SOFTWARE,
    OID_XUPS_BAT_TIME_REMAINING, OID_XUPS_BAT_CAPACITY, OID_XUPS_OUTPUT_LOAD, OID_XUPS_OUTPUT_SOURCE,
)

# --- HPE CPQPOWER-MIB UPS branch (fallback) -------------------------------------
OID_CPQ_UPS_IDENT_MANUFACTURER = "1.3.6.1.4.1.232.165.3.1.1.0"
OID_CPQ_UPS_IDENT_MODEL = "1.3.6.1.4.1.232.165.3.1.2.0"
OID_CPQ_UPS_IDENT_SOFTWARE = "1.3.6.1.4.1.232.165.3.1.3.0"
OID_CPQ_UPS_BAT_TIME_REMAINING = "1.3.6.1.4.1.232.165.3.2.1.0"   # seconds
OID_CPQ_UPS_BAT_CAPACITY = "1.3.6.1.4.1.232.165.3.2.4.0"         # percent
OID_CPQ_UPS_OUTPUT_LOAD = "1.3.6.1.4.1.232.165.3.4.1.0"          # percent
OID_CPQ_UPS_OUTPUT_SOURCE = "1.3.6.1.4.1.232.165.3.4.5.0"

CPQPOWER_UPS_SCALAR_OIDS = (
    OID_CPQ_UPS_IDENT_MANUFACTURER, OID_CPQ_UPS_IDENT_MODEL, OID_CPQ_UPS_IDENT_SOFTWARE,
    OID_CPQ_UPS_BAT_TIME_REMAINING, OID_CPQ_UPS_BAT_CAPACITY, OID_CPQ_UPS_OUTPUT_LOAD,
    OID_CPQ_UPS_OUTPUT_SOURCE,
)

# --- HPE server management (iLO / Insight agents) -------------------------------
OID_CPQ_HE_MIB_CONDITION = "1.3.6.1.4.1.232.6.1.3.0"          # cpqHeMibCondition
OID_CPQ_HE_THERMAL_CONDITION = "1.3.6.1.4.1.232.6.2.6.1.0"    # cpqHeThermalCondition
OID_CPQ_HE_FAN_STATUS = "1.3.6.1.4.1.232.6.2.6.4.0"           # cpqHeThermalSystemFanStatus
OID_CPQ_HE_POWER_CONDITION = "1.3.6.1.4.1.232.6.2.9.1.0"      # cpqHeFltTolPwrSupplyCondition
OID_CPQ_DA_MIB_CONDITION = "1.3.6.1.4.1.232.3.1.3.0"          # cpqDaMibCondition
OID_CPQ_SI_PRODUCT_NAME = "1.3.6.1.4.1.232.2.2.4.2.0"         # cpqSiProductName
OID_CPQ_SI_SERIAL = "1.3.6.1.4.1.232.2.2.2.1.0"               # cpqSiSysSerialNum
OID_CPQ_SM2_ROM_REVISION = "1.3.6.1.4.1.232.9.2.2.2.0"        # cpqSm2CntlrRomRevision (iLO firmware)
OID_CPQ_HE_TEMPERATURE_CELSIUS = "1.3.6.1.4.1.232.6.2.6.8.1.4"  # table column cpqHeTemperatureCelsius

SERVER_SCALAR_OIDS = (
    OID_CPQ_HE_MIB_CONDITION, OID_CPQ_HE_THERMAL_CONDITION, OID_CPQ_HE_FAN_STATUS,
    OID_CPQ_HE_POWER_CONDITION, OID_CPQ_DA_MIB_CONDITION, OID_CPQ_SI_PRODUCT_NAME,
    OID_CPQ_SI_SERIAL, OID_CPQ_SM2_ROM_REVISION,
)

# --- Enumerations -----------------------------------------------------------------
BATTERY_STATUS = {1: "unknown", 2: "normal", 3: "low", 4: "depleted"}

# RFC 1628 defines 1-7; XUPS-MIB / CPQPOWER-MIB extend the same enum.
OUTPUT_SOURCE = {
    1: "other", 2: "none", 3: "normal", 4: "bypass", 5: "battery", 6: "booster", 7: "reducer",
    8: "parallel_capacity", 9: "parallel_redundant", 10: "high_efficiency",
    11: "maintenance_bypass", 12: "energy_saver",
}

# CPQ condition: other(1) means "not supported / not present".
CONDITION = {1: "unknown", 2: "ok", 3: "degraded", 4: "failed"}

# Charge (percent) at or below which a UPS with active alarms counts as critical.
LOW_CHARGE_PERCENT = 20

# Valid sentinel-free temperature readings (cpqHeTemperatureCelsius returns
# -99 when the value cannot be determined).
_TEMP_MIN_VALID_C = 0
_TEMP_MAX_VALID_C = 200


def _int(value) -> Optional[int]:
    """Parse an SNMP integer string; None when missing or not numeric."""
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _text(value) -> Optional[str]:
    """Return a stripped non-empty string or None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _first(values: Dict[str, str], oids: Sequence[str], parse=_int):
    """Return the first parsed, non-None value among ``oids``."""
    for oid in oids:
        parsed = parse(values.get(oid))
        if parsed is not None:
            return parsed
    return None


def _row_index(oid: str) -> Tuple[int, ...]:
    """Sort key for table rows: the numeric arcs of the OID."""
    try:
        return tuple(int(p) for p in oid.strip(".").split("."))
    except ValueError:
        return ()


def _seconds_to_minutes(value) -> Optional[int]:
    seconds = _int(value)
    return None if seconds is None or seconds < 0 else seconds // 60


def ups_status(health: dict) -> str:
    """Derive the overall UPS status: ok | warning | critical | unknown.

    critical: battery depleted, no output power source, or alarms present
    with a charge at or below LOW_CHARGE_PERCENT.
    warning: on battery, battery low, on bypass, or any alarm present.
    """
    battery = health.get("battery_status")
    source = health.get("output_source")
    charge = health.get("charge_percent")
    alarms = health.get("alarms_present") or 0
    on_battery = source == "battery" or (health.get("seconds_on_battery") or 0) > 0

    if battery == "depleted" or source == "none":
        return "critical"
    if alarms > 0 and charge is not None and charge <= LOW_CHARGE_PERCENT:
        return "critical"
    if on_battery or battery == "low" or source in ("bypass", "maintenance_bypass") or alarms > 0:
        return "warning"
    if battery == "normal" or source not in (None, "other") or charge is not None:
        return "ok"
    return "unknown"


def parse_ups_health(
    values: Dict[str, str],
    load_rows: Iterable[Tuple[str, str]] = (),
    input_voltage_rows: Iterable[Tuple[str, str]] = (),
) -> Optional[dict]:
    """Normalize UPS values into the "ups" health shape.

    ``values`` holds scalar GET results (RFC 1628 plus optional XUPS /
    CPQPOWER fallback objects). RFC 1628 values win; vendor objects only fill
    gaps. Returns None when no UPS value at all was reported.
    """
    values = values or {}
    loads = [v for v in (_int(val) for _, val in load_rows) if v is not None and v >= 0]
    voltages = sorted(
        ((_row_index(oid), _int(val)) for oid, val in input_voltage_rows),
        key=lambda item: item[0],
    )
    input_voltage = next((v for _, v in voltages if v is not None and v >= 0), None)

    battery_code = _int(values.get(OID_UPS_BATTERY_STATUS))
    source_code = _first(values, (OID_UPS_OUTPUT_SOURCE, OID_XUPS_OUTPUT_SOURCE, OID_CPQ_UPS_OUTPUT_SOURCE))
    runtime = _int(values.get(OID_UPS_MINUTES_REMAINING))
    if runtime is None:
        runtime = _first(values, (OID_XUPS_BAT_TIME_REMAINING, OID_CPQ_UPS_BAT_TIME_REMAINING),
                         parse=_seconds_to_minutes)
    load = max(loads) if loads else _first(values, (OID_XUPS_OUTPUT_LOAD, OID_CPQ_UPS_OUTPUT_LOAD))

    health = {
        "kind": "ups",
        "manufacturer": _first(values, (OID_UPS_IDENT_MANUFACTURER, OID_XUPS_IDENT_MANUFACTURER,
                                        OID_CPQ_UPS_IDENT_MANUFACTURER), parse=_text),
        "model": _first(values, (OID_UPS_IDENT_MODEL, OID_XUPS_IDENT_MODEL, OID_CPQ_UPS_IDENT_MODEL),
                        parse=_text),
        "software": _first(values, (OID_UPS_IDENT_SOFTWARE, OID_XUPS_IDENT_SOFTWARE, OID_CPQ_UPS_IDENT_SOFTWARE),
                           parse=_text),
        "battery_status": BATTERY_STATUS.get(battery_code) if battery_code is not None else None,
        "seconds_on_battery": _int(values.get(OID_UPS_SECONDS_ON_BATTERY)),
        "runtime_minutes": runtime,
        "charge_percent": _first(values, (OID_UPS_CHARGE_REMAINING, OID_XUPS_BAT_CAPACITY, OID_CPQ_UPS_BAT_CAPACITY)),
        "battery_temperature_c": _int(values.get(OID_UPS_BATTERY_TEMPERATURE)),
        "output_source": OUTPUT_SOURCE.get(source_code, "other") if source_code is not None else None,
        "load_percent": load,
        "input_voltage": input_voltage,
        "alarms_present": _int(values.get(OID_UPS_ALARMS_PRESENT)),
    }
    if all(v is None for k, v in health.items() if k != "kind"):
        return None
    health["status"] = ups_status(health)
    return health


def server_status(health: dict) -> str:
    """Derive the overall server status from the subsystem conditions."""
    conditions = [health.get(k) for k in ("overall", "thermal", "power_supply", "fans", "storage")]
    if "failed" in conditions:
        return "critical"
    if "degraded" in conditions:
        return "warning"
    if "ok" in conditions:
        return "ok"
    return "unknown"


def parse_server_health(
    values: Dict[str, str],
    temperature_rows: Iterable[Tuple[str, str]] = (),
) -> Optional[dict]:
    """Normalize HPE CPQ values into the "server" health shape.

    Returns None when the server answered none of the objects.
    """
    values = values or {}

    def _cond(oid: str) -> Optional[str]:
        code = _int(values.get(oid))
        return CONDITION.get(code, "unknown") if code is not None else None

    temps = [
        t for t in (_int(val) for _, val in temperature_rows)
        if t is not None and _TEMP_MIN_VALID_C < t < _TEMP_MAX_VALID_C
    ]
    health = {
        "kind": "server",
        "overall": _cond(OID_CPQ_HE_MIB_CONDITION),
        "thermal": _cond(OID_CPQ_HE_THERMAL_CONDITION),
        "power_supply": _cond(OID_CPQ_HE_POWER_CONDITION),
        "fans": _cond(OID_CPQ_HE_FAN_STATUS),
        "storage": _cond(OID_CPQ_DA_MIB_CONDITION),
        "temperature_max_c": max(temps) if temps else None,
        "temperature_sensors": len(temps) if temps else None,
        "product_name": _text(values.get(OID_CPQ_SI_PRODUCT_NAME)),
        "serial_number": _text(values.get(OID_CPQ_SI_SERIAL)),
        "ilo_firmware": _text(values.get(OID_CPQ_SM2_ROM_REVISION)),
    }
    if all(v is None for k, v in health.items() if k != "kind"):
        return None
    health["status"] = server_status(health)
    return health


async def collect_ups_health(get: SnmpGet, walk: SnmpWalk, extra_oids: Sequence[str] = ()) -> Optional[dict]:
    """Read RFC 1628 UPS-MIB (plus ``extra_oids`` vendor fallbacks) and normalize.

    The vendor fallback GET is separate so an agent that rejects unknown
    objects in a multi-OID request cannot hide the standard values.
    """
    try:
        values = dict(await get(*UPS_MIB_SCALAR_OIDS) or {})
        if extra_oids:
            try:
                values.update({k: v for k, v in (await get(*extra_oids) or {}).items() if k not in values})
            except Exception:
                log.debug("UPS vendor fallback read failed")
        load_rows = await walk(OID_UPS_OUTPUT_PERCENT_LOAD) or []
        voltage_rows = await walk(OID_UPS_INPUT_VOLTAGE) or []
        return parse_ups_health(values, load_rows, voltage_rows)
    except Exception as exc:
        log.debug("UPS health collection failed: %s", exc)
        return None


async def collect_server_health(get: SnmpGet, walk: SnmpWalk) -> Optional[dict]:
    """Read the HPE CPQ health objects and normalize."""
    try:
        values = dict(await get(*SERVER_SCALAR_OIDS) or {})
        temperature_rows = await walk(OID_CPQ_HE_TEMPERATURE_CELSIUS) or []
        return parse_server_health(values, temperature_rows)
    except Exception as exc:
        log.debug("Server health collection failed: %s", exc)
        return None


def health_model(health: Optional[dict]) -> str:
    """Model string from a health snapshot ("" when unknown)."""
    if not health:
        return ""
    return health.get("model") or health.get("product_name") or ""


def health_firmware(health: Optional[dict]) -> str:
    """Firmware string from a health snapshot ("" when unknown)."""
    if not health:
        return ""
    return health.get("software") or health.get("ilo_firmware") or ""
