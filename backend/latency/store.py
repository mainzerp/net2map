"""Database access for the latency monitor and the latency API (sync sessions).

Timestamps are UTC. SQLite (tests, bare local dev) returns naive datetimes for
``DateTime(timezone=True)`` columns; ``as_utc`` treats those as UTC.
"""
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional, Sequence

from sqlalchemy import BigInteger, Integer, cast, func

from latency.settings import LatencySettings
from latency.stats import mean

# Hard cap on monitored devices per round.
MAX_TARGETS = 200


def as_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def minute_floor(value: datetime) -> datetime:
    return as_utc(value).replace(second=0, microsecond=0)


def iso(value: Optional[datetime]) -> Optional[str]:
    value = as_utc(value)
    return value.isoformat() if value else None


def target_query(db, settings: LatencySettings):
    """Devices the monitor probes: enabled, not ignored, opted in for mode "selected"."""
    from database import Device

    query = db.query(Device).filter(Device.enabled.is_(True), Device.ignored.is_(False))
    if settings.mode == "selected":
        query = query.filter(Device.latency_monitored.is_(True))
    return query.order_by(Device.id).limit(MAX_TARGETS)


def select_targets(db, settings: LatencySettings) -> list[tuple[int, str]]:
    return [(d.id, d.ip) for d in target_query(db, settings).all() if d.ip]


def _probe_weighted_mean(pairs: Iterable[tuple[Optional[float], int]]) -> Optional[float]:
    """Mean of values weighted by their probe count; unweighted when all weights are 0."""
    data = [(v, w) for v, w in pairs if v is not None]
    if not data:
        return None
    total = sum(w for _, w in data)
    if not total:
        return mean(v for v, _ in data)
    return sum(v * w for v, w in data) / total


def build_rollup(device_id: int, bucket_ts: datetime, samples: Sequence) -> dict:
    """Aggregate the Samples of one device and minute into a rollup row dict.

    Averages are weighted by ``sent`` so a requeued rollup (one synthetic sample
    carrying the probes of a whole minute) keeps its weight when merged with
    fresh samples.
    """
    probes = sum(max(0, int(s.sent or 0)) for s in samples)
    lost = sum((float(s.loss_pct) / 100.0) * max(0, int(s.sent or 0)) for s in samples)
    mins = [s.rtt_min_ms for s in samples if s.rtt_min_ms is not None]
    maxs = [s.rtt_max_ms for s in samples if s.rtt_max_ms is not None]
    return {
        "device_id": device_id,
        "bucket_ts": minute_floor(bucket_ts),
        "rtt_avg_ms": _probe_weighted_mean((s.rtt_avg_ms, max(0, int(s.sent or 0))) for s in samples),
        "rtt_min_ms": min(mins) if mins else None,
        "rtt_max_ms": max(maxs) if maxs else None,
        "jitter_ms": _probe_weighted_mean((s.jitter_ms, max(0, int(s.sent or 0))) for s in samples),
        "loss_pct": round(lost * 100.0 / probes, 2) if probes else 100.0,
        "probes": probes,
    }


def _weighted(a: Optional[float], wa: int, b: Optional[float], wb: int) -> Optional[float]:
    if a is None:
        return b
    if b is None:
        return a
    total = wa + wb
    return (a * wa + b * wb) / total if total else (a + b) / 2.0


def _merge_into(row, rollup: dict) -> None:
    """Merge a rollup into an existing row of the same device and minute."""
    old_probes, new_probes = int(row.probes or 0), int(rollup["probes"] or 0)
    row.rtt_avg_ms = _weighted(row.rtt_avg_ms, old_probes, rollup["rtt_avg_ms"], new_probes)
    row.jitter_ms = _weighted(row.jitter_ms, old_probes, rollup["jitter_ms"], new_probes)
    mins = [v for v in (row.rtt_min_ms, rollup["rtt_min_ms"]) if v is not None]
    maxs = [v for v in (row.rtt_max_ms, rollup["rtt_max_ms"]) if v is not None]
    row.rtt_min_ms = min(mins) if mins else None
    row.rtt_max_ms = max(maxs) if maxs else None
    row.loss_pct = _weighted(row.loss_pct, old_probes, rollup["loss_pct"], new_probes)
    row.probes = old_probes + new_probes


def flush_rollups(db, rollups: Iterable[dict]) -> int:
    """Insert rollups; merge into an existing row for the same device and minute.

    Rows of devices deleted meanwhile are skipped. Returns the number written.
    """
    from database import Device, LatencySample

    rollups = list(rollups)
    if not rollups:
        return 0
    device_ids = {r["device_id"] for r in rollups}
    existing_devices = {row.id for row in db.query(Device.id).filter(Device.id.in_(device_ids)).all()}
    written = 0
    for rollup in rollups:
        if rollup["device_id"] not in existing_devices:
            continue
        row = (
            db.query(LatencySample)
            .filter(LatencySample.device_id == rollup["device_id"], LatencySample.bucket_ts == rollup["bucket_ts"])
            .first()
        )
        if row is None:
            db.add(LatencySample(**rollup))
        else:
            _merge_into(row, rollup)
        written += 1
    db.commit()
    return written


def load_baseline_values(db, device_ids: Iterable[int], now: datetime) -> dict[int, list[float]]:
    """Minute rtt_avg values of the last 24 h per device."""
    from database import LatencySample

    ids = list(device_ids)
    if not ids:
        return {}
    since = as_utc(now) - timedelta(hours=24)
    rows = (
        db.query(LatencySample.device_id, LatencySample.rtt_avg_ms)
        .filter(
            LatencySample.device_id.in_(ids),
            LatencySample.bucket_ts >= since,
            LatencySample.rtt_avg_ms.isnot(None),
        )
        .all()
    )
    values: dict[int, list[float]] = {}
    for device_id, rtt in rows:
        values.setdefault(device_id, []).append(rtt)
    return values


def purge_older_than(db, cutoff: datetime) -> int:
    from database import LatencySample

    deleted = (
        db.query(LatencySample)
        .filter(LatencySample.bucket_ts < as_utc(cutoff))
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(deleted or 0)


def latest_rows(db, device_ids: Iterable[int], since: datetime) -> dict:
    """Most recent rollup per device with bucket_ts >= since."""
    from database import LatencySample

    ids = list(device_ids)
    if not ids:
        return {}
    rows = (
        db.query(LatencySample)
        .filter(LatencySample.device_id.in_(ids), LatencySample.bucket_ts >= as_utc(since))
        .order_by(LatencySample.bucket_ts.asc())
        .all()
    )
    latest = {}
    for row in rows:
        latest[row.device_id] = row  # ascending order: last one wins
    return latest


def _bucket_index_expr(db, bucket_sec: int):
    """SQL expression for floor(epoch(bucket_ts) / bucket_sec), per dialect."""
    from database import LatencySample

    dialect = db.get_bind().dialect.name
    if dialect == "sqlite":
        # strftime('%s') reads the stored UTC wall clock; integer division floors.
        return cast(func.strftime("%s", LatencySample.bucket_ts), Integer) / bucket_sec
    return cast(func.floor(func.extract("epoch", LatencySample.bucket_ts) / bucket_sec), BigInteger)


def bucketed_device_means(db, since: datetime, bucket_sec: int, device_id: Optional[int] = None) -> list[tuple]:
    """Per (device, bucket) means: ``[(device_id, bucket_index, rtt, jitter, loss), ...]``.

    Aggregated in SQL so the result stays bounded (devices x buckets) even for
    the 7 d network series.
    """
    from database import LatencySample

    bucket = _bucket_index_expr(db, bucket_sec).label("bucket")
    query = (
        db.query(
            LatencySample.device_id,
            bucket,
            func.avg(LatencySample.rtt_avg_ms),
            func.avg(LatencySample.jitter_ms),
            func.avg(LatencySample.loss_pct),
        )
        .filter(LatencySample.bucket_ts >= as_utc(since))
    )
    if device_id is not None:
        query = query.filter(LatencySample.device_id == device_id)
    rows = query.group_by(LatencySample.device_id, bucket).all()
    return [
        (
            dev,
            int(idx),
            None if rtt is None else float(rtt),
            None if jitter is None else float(jitter),
            None if loss is None else float(loss),
        )
        for dev, idx, rtt, jitter, loss in rows
        if idx is not None
    ]
