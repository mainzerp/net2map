"""Network latency monitor API: current summary and history series.

The latency-monitor service (``python -m latency.monitor``) publishes per-device
state to Redis and per-minute rollups to ``latency_samples``. Without Redis the
summary falls back to the latest rollup per device of the last 5 minutes.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database import Device, get_db
from latency import stats, store
from latency.monitor import HEARTBEAT_KEY, STATE_KEY
from latency.settings import read_settings
from schemas import LatencyHistoryOut, LatencySummaryOut
from shared.errors import api_error
from shared.redis_client import get_redis

router = APIRouter()
_log = logging.getLogger(__name__)

HISTORY_RANGES = {"1h": (timedelta(hours=1), 60), "24h": (timedelta(hours=24), 300), "7d": (timedelta(days=7), 1800)}
FALLBACK_WINDOW = timedelta(minutes=5)


def _device_name(device: Device) -> str:
    return device.label or device.sys_name or device.ip


def _parse_ts(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        return store.as_utc(datetime.fromisoformat(str(value)))
    except ValueError:
        return None


def _read_redis_state(r) -> tuple[dict[int, dict], Optional[dict]]:
    """Return (state per device id, heartbeat dict or None) from Redis."""
    raw_state = r.hgetall(STATE_KEY) or {}
    state = {}
    for field, payload in raw_state.items():
        try:
            state[int(field)] = json.loads(payload)
        except (TypeError, ValueError):
            continue
    heartbeat = None
    raw_hb = r.get(HEARTBEAT_KEY)
    if raw_hb:
        try:
            heartbeat = json.loads(raw_hb)
        except ValueError:
            heartbeat = None
    return state, heartbeat


def _fallback_state(db: Session, device_ids: list[int], now: datetime) -> dict[int, dict]:
    """State from the newest rollup per device (window = that single row)."""
    state = {}
    for device_id, row in store.latest_rows(db, device_ids, now - FALLBACK_WINDOW).items():
        state[device_id] = {
            "rtt_ms": stats.round_ms(row.rtt_avg_ms),
            "jitter_ms": stats.round_ms(row.jitter_ms),
            "loss_pct": row.loss_pct,
            "baseline_ms": None,
            "status": stats.classify(1, row.loss_pct, row.rtt_avg_ms, None),
            "updated_at": store.iso(row.bucket_ts),
        }
    return state


@router.get("/latency/summary", response_model=LatencySummaryOut)
def latency_summary(db: Session = Depends(get_db)):
    settings = read_settings(db)
    now = datetime.now(timezone.utc)
    targets = store.target_query(db, settings).all() if settings.enabled else []
    target_ids = [d.id for d in targets]

    state: dict[int, dict] = {}
    heartbeat = None
    updated_at = None
    monitor_alive = False
    r = get_redis()
    redis_ok = False
    if r is not None:
        try:
            state, heartbeat = _read_redis_state(r)
            redis_ok = True
        except Exception as exc:
            _log.warning("latency summary: Redis read failed, using rollups: %s", exc)
    if redis_ok:
        hb_ts = _parse_ts(heartbeat.get("updated_at")) if heartbeat else None
        if hb_ts is not None:
            interval = int(heartbeat.get("interval_sec") or settings.interval_sec)
            monitor_alive = now - hb_ts <= timedelta(seconds=max(30, 3 * interval))
            updated_at = store.iso(hb_ts)
    else:
        state = _fallback_state(db, target_ids, now)
        newest = [_parse_ts(s["updated_at"]) for s in state.values()]
        newest = [ts for ts in newest if ts is not None]
        if newest:
            updated_at = store.iso(max(newest))
            monitor_alive = now - max(newest) <= timedelta(minutes=3)

    devices = []
    for device in targets:
        entry = state.get(device.id) or {}
        status = entry.get("status") if entry.get("status") in stats.STATUS_SEVERITY else "unknown"
        live = monitor_alive
        devices.append({
            "device_id": device.id,
            "name": _device_name(device),
            "ip": device.ip,
            # A stopped monitor's last values are not current: report them as
            # unknown, keeping baseline and updated_at for "last seen".
            "rtt_ms": entry.get("rtt_ms") if live else None,
            "jitter_ms": entry.get("jitter_ms") if live else None,
            "loss_pct": entry.get("loss_pct") if live else None,
            "baseline_ms": entry.get("baseline_ms"),
            "status": status if live else "unknown",
            "updated_at": entry.get("updated_at"),
        })
    devices.sort(key=lambda d: (
        stats.STATUS_SEVERITY[d["status"]],
        d["rtt_ms"] is None,
        -(d["rtt_ms"] or 0.0),
    ))

    rtts = [d["rtt_ms"] for d in devices if d["rtt_ms"] is not None]
    network = {
        "median_ms": stats.round_ms(stats.median(rtts)),
        "p95_ms": stats.round_ms(stats.p95(rtts)),
        "loss_pct": stats.round_ms(stats.mean(d["loss_pct"] for d in devices), 2),
        "targets": len(devices),
        "reachable": sum(1 for d in devices if d["status"] not in ("down", "unknown")),
        "degraded": sum(1 for d in devices if d["status"] in ("degraded", "loss", "down")),
    }
    return {
        "enabled": settings.enabled,
        "interval_sec": settings.interval_sec,
        "mode": settings.mode,
        "monitor_alive": monitor_alive,
        "updated_at": updated_at,
        "network": network,
        "devices": devices,
    }


@router.get("/latency/history", response_model=LatencyHistoryOut)
def latency_history(
    range: Literal["1h", "24h", "7d"] = Query("1h"),
    device_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    if device_id is not None and not db.query(Device.id).filter(Device.id == device_id).first():
        api_error(404, "DEVICE_NOT_FOUND", "Device not found")
    span, bucket_sec = HISTORY_RANGES[range]
    now = datetime.now(timezone.utc)
    rows = store.bucketed_device_means(db, now - span, bucket_sec, device_id)

    per_bucket: dict[int, list[tuple]] = {}
    for _dev, idx, rtt, jitter, loss in rows:
        per_bucket.setdefault(idx, []).append((rtt, jitter, loss))

    points = []
    for idx in sorted(per_bucket):
        entries = per_bucket[idx]
        if device_id is not None:
            rtt = stats.mean(e[0] for e in entries)
            jitter = stats.mean(e[1] for e in entries)
        else:
            rtt = stats.median(e[0] for e in entries)
            jitter = stats.median(e[1] for e in entries)
        loss = stats.mean(e[2] for e in entries)
        points.append({
            "ts": datetime.fromtimestamp(idx * bucket_sec, tz=timezone.utc).isoformat(),
            "rtt_ms": stats.round_ms(rtt),
            "jitter_ms": stats.round_ms(jitter),
            "loss_pct": stats.round_ms(loss, 2),
        })
    return {"range": range, "device_id": device_id, "bucket_sec": bucket_sec, "points": points}
