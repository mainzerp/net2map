"""Long-running latency monitor (``python -m latency.monitor``).

Each round it reads the latency settings, probes all target devices
concurrently, keeps a rolling window of the last samples per device, publishes
per-device state to Redis, and rolls samples up per minute into the
``latency_samples`` table. Baselines (median of the last 24 h of minute
averages) are refreshed every 10 minutes; rollups older than the retention are
purged hourly.

Only one instance runs at a time (Redis lock). Without Redis the monitor still
runs, but state is kept in memory only and the API falls back to the rollups.
Database or Redis errors are logged and the loop continues.
"""
import asyncio
import contextlib
import json
import logging
import signal
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

from latency import stats, store
from latency.probe import Sample, probe
from latency.settings import LatencySettings, read_settings
from shared.redis_client import get_redis
from shared.state import _log_event

_log = logging.getLogger("latency.monitor")

STATE_KEY = "net2map:latency:state"
HEARTBEAT_KEY = "net2map:latency:heartbeat"
BASELINE_KEY = "net2map:latency:baseline"
LOCK_KEY = "net2map:latency:monitor_lock"

WINDOW_SIZE = 6
PROBE_CONCURRENCY = 32
PROBE_TIMEOUT_SEC = 1
BASELINE_REFRESH_SEC = 600
PURGE_INTERVAL_SEC = 3600
# Unflushed minutes kept in memory while the database is unreachable.
MAX_PENDING_MINUTES = 15

ProbeFn = Callable[[int, str, int, int], Awaitable[Sample]]


def lock_ttl(interval_sec: int) -> int:
    return max(30, 3 * interval_sec)


class LatencyMonitor:
    def __init__(
        self,
        probe_fn: ProbeFn = probe,
        session_factory: Optional[Callable] = None,
        redis_factory: Callable = get_redis,
        now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.probe_fn = probe_fn
        self._session_factory = session_factory
        self.redis_factory = redis_factory
        self.now_fn = now_fn
        self.owner_token = uuid.uuid4().hex
        self.windows: dict[int, deque] = {}
        # (device_id, minute start) -> samples not yet written to latency_samples
        self.pending: dict[tuple[int, datetime], list[Sample]] = {}
        self.baselines: dict[int, Optional[float]] = {}
        self.state: dict[int, dict] = {}
        self.last_baseline_refresh = 0.0
        self.last_purge = 0.0
        self._warned_no_redis = False
        self._waiting_for_lock = False

    # ── infrastructure ───────────────────────────────────────────────────────

    def session(self):
        if self._session_factory is not None:
            return self._session_factory()
        import database

        return database.SessionLocal()

    def _redis(self):
        r = self.redis_factory()
        if r is None and not self._warned_no_redis:
            self._warned_no_redis = True
            _log_event(logging.WARNING, "latency_monitor_no_redis",
                       message="REDIS_URL not set or Redis unavailable; state kept in memory only")
        return r

    def _load_config(self) -> tuple[LatencySettings, list[tuple[int, str]]]:
        db = self.session()
        try:
            settings = read_settings(db)
            targets = store.select_targets(db, settings) if settings.enabled else []
            return settings, targets
        finally:
            db.close()

    def acquire_lock(self, ttl: int) -> bool:
        """Take or renew the single-instance lock; True when this process owns it."""
        r = self._redis()
        if r is None:
            return True
        try:
            if r.set(LOCK_KEY, self.owner_token, nx=True, ex=ttl):
                owned = True
            elif r.get(LOCK_KEY) == self.owner_token:
                r.expire(LOCK_KEY, ttl)
                owned = True
            else:
                owned = False
        except Exception as exc:
            # Fail open: a second instance only duplicates probes; rollup
            # writes merge on (device_id, bucket_ts).
            _log.warning("latency monitor lock check failed (%s); continuing", exc)
            return True
        if not owned and not self._waiting_for_lock:
            self._waiting_for_lock = True
            _log_event(logging.INFO, "latency_monitor_lock_busy",
                       message="another latency monitor holds the lock; waiting")
        elif owned and self._waiting_for_lock:
            self._waiting_for_lock = False
            _log_event(logging.INFO, "latency_monitor_lock_acquired")
        return owned

    def release_lock(self) -> None:
        r = self.redis_factory()
        if r is None:
            return
        try:
            if r.get(LOCK_KEY) == self.owner_token:
                r.delete(LOCK_KEY)
        except Exception as exc:
            _log.warning("latency monitor lock release failed: %s", exc)

    # ── probing and aggregation ──────────────────────────────────────────────

    async def probe_all(self, targets: list[tuple[int, str]], pings: int) -> list[Sample]:
        sem = asyncio.Semaphore(PROBE_CONCURRENCY)

        async def _one(device_id: int, ip: str):
            async with sem:
                return await self.probe_fn(device_id, ip, pings, PROBE_TIMEOUT_SEC)

        results = await asyncio.gather(*(_one(d, ip) for d, ip in targets), return_exceptions=True)
        samples = []
        for (device_id, ip), result in zip(targets, results):
            if isinstance(result, BaseException):
                _log.warning("latency probe failed for device %s (%s): %s", device_id, ip, result)
                continue
            samples.append(result)
        return samples

    def record(self, samples: list[Sample], target_ids: set[int]) -> None:
        """Add samples to the rolling windows and the pending minute buckets."""
        for device_id in list(self.windows):
            if device_id not in target_ids:
                del self.windows[device_id]
        for sample in samples:
            self.windows.setdefault(sample.device_id, deque(maxlen=WINDOW_SIZE)).append(sample)
            key = (sample.device_id, store.minute_floor(sample.ts))
            self.pending.setdefault(key, []).append(sample)

    def compute_state(self, target_ids: set[int], now: datetime) -> dict[int, dict]:
        state = {}
        for device_id in target_ids:
            window = list(self.windows.get(device_id, ()))
            if not window:
                continue
            agg = stats.aggregate_window(window)
            baseline = self.baselines.get(device_id)
            state[device_id] = {
                "device_id": device_id,
                "rtt_ms": stats.round_ms(agg["rtt_ms"]),
                "jitter_ms": stats.round_ms(agg["jitter_ms"]),
                "loss_pct": agg["loss_pct"],
                "baseline_ms": stats.round_ms(baseline),
                "status": stats.classify(agg["count"], agg["loss_pct"], agg["rtt_ms"], baseline),
                "updated_at": store.iso(window[-1].ts),
            }
        self.state = state
        return state

    def take_due_rollups(self, now: datetime, include_current: bool = False) -> list[dict]:
        """Pop rollups of completed minutes (all minutes when include_current)."""
        current = store.minute_floor(now)
        due = [key for key in self.pending if include_current or key[1] < current]
        return [store.build_rollup(dev, minute, self.pending.pop((dev, minute))) for dev, minute in due]

    def _requeue(self, rollups: list[dict], now: datetime) -> None:
        """Keep unflushed rollups for a later retry, bounded to recent minutes."""
        horizon = store.minute_floor(now) - timedelta(minutes=MAX_PENDING_MINUTES)
        for rollup in rollups:
            if rollup["bucket_ts"] < horizon:
                continue
            # Re-expand as one synthetic sample so build_rollup reproduces it.
            self.pending.setdefault((rollup["device_id"], rollup["bucket_ts"]), []).append(Sample(
                device_id=rollup["device_id"], ts=rollup["bucket_ts"],
                rtt_avg_ms=rollup["rtt_avg_ms"], rtt_min_ms=rollup["rtt_min_ms"],
                rtt_max_ms=rollup["rtt_max_ms"], jitter_ms=rollup["jitter_ms"],
                loss_pct=rollup["loss_pct"], sent=rollup["probes"],
            ))

    def _flush_sync(self, rollups: list[dict]) -> int:
        db = self.session()
        try:
            return store.flush_rollups(db, rollups)
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    async def flush(self, now: datetime, include_current: bool = False) -> int:
        rollups = self.take_due_rollups(now, include_current)
        if not rollups:
            return 0
        try:
            return await asyncio.to_thread(self._flush_sync, rollups)
        except Exception as exc:
            _log_event(logging.ERROR, "latency_monitor_flush_failed", error=str(exc), rollups=len(rollups))
            self._requeue(rollups, now)
            return 0

    def _refresh_baselines_sync(self, target_ids: set[int], now: datetime) -> dict[int, Optional[float]]:
        db = self.session()
        try:
            values = store.load_baseline_values(db, target_ids, now)
        finally:
            db.close()
        return {device_id: stats.compute_baseline(values.get(device_id, [])) for device_id in target_ids}

    async def refresh_baselines(self, target_ids: set[int], now: datetime) -> None:
        try:
            self.baselines = await asyncio.to_thread(self._refresh_baselines_sync, target_ids, now)
        except Exception as exc:
            _log_event(logging.ERROR, "latency_monitor_baseline_failed", error=str(exc))
            return
        self.last_baseline_refresh = time.monotonic()
        r = self._redis()
        if r is None:
            return
        try:
            pipe = r.pipeline()
            pipe.delete(BASELINE_KEY)
            mapping = {str(k): json.dumps(v) for k, v in self.baselines.items()}
            if mapping:
                pipe.hset(BASELINE_KEY, mapping=mapping)
            pipe.execute()
        except Exception as exc:
            _log.warning("latency baseline publish failed: %s", exc)

    def _purge_sync(self, retention_days: int, now: datetime) -> int:
        db = self.session()
        try:
            return store.purge_older_than(db, now - timedelta(days=retention_days))
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    async def purge(self, retention_days: int, now: datetime) -> None:
        try:
            deleted = await asyncio.to_thread(self._purge_sync, retention_days, now)
        except Exception as exc:
            _log_event(logging.ERROR, "latency_monitor_purge_failed", error=str(exc))
            return
        self.last_purge = time.monotonic()
        if deleted:
            _log_event(logging.INFO, "latency_monitor_purged", rows=deleted, retention_days=retention_days)

    def publish(self, state: dict[int, dict], settings: LatencySettings, targets: int, now: datetime) -> None:
        r = self._redis()
        if r is None:
            return
        try:
            existing = set(r.hkeys(STATE_KEY))
            wanted = {str(k) for k in state}
            pipe = r.pipeline()
            stale = existing - wanted
            if stale:
                pipe.hdel(STATE_KEY, *stale)
            if state:
                pipe.hset(STATE_KEY, mapping={str(k): json.dumps(v) for k, v in state.items()})
            ttl = lock_ttl(settings.interval_sec)
            pipe.set(
                HEARTBEAT_KEY,
                json.dumps({"updated_at": store.iso(now), "interval_sec": settings.interval_sec, "targets": targets}),
                ex=ttl,
            )
            # State and baselines expire with the heartbeat, so a stopped
            # monitor leaves no stale per-device data behind.
            pipe.expire(STATE_KEY, ttl)
            pipe.expire(BASELINE_KEY, ttl)
            pipe.execute()
        except Exception as exc:
            _log.warning("latency state publish failed: %s", exc)

    # ── main loop ────────────────────────────────────────────────────────────

    async def run_round(self) -> float:
        """Run one monitor round; returns the configured interval in seconds."""
        started = time.monotonic()
        try:
            settings, targets = await asyncio.to_thread(self._load_config)
        except Exception as exc:
            _log_event(logging.ERROR, "latency_monitor_config_failed", error=str(exc))
            return float(LatencySettings().interval_sec)

        if not await asyncio.to_thread(self.acquire_lock, lock_ttl(settings.interval_sec)):
            return float(settings.interval_sec)

        if not settings.enabled:
            targets = []
        target_ids = {device_id for device_id, _ in targets}

        samples = await self.probe_all(targets, settings.pings) if targets else []
        now = self.now_fn()
        self.record(samples, target_ids)
        await self.flush(now)

        if target_ids and (
            not self.last_baseline_refresh
            or time.monotonic() - self.last_baseline_refresh >= BASELINE_REFRESH_SEC
            or not target_ids.issubset(self.baselines)
        ):
            await self.refresh_baselines(target_ids, now)
        if not self.last_purge or time.monotonic() - self.last_purge >= PURGE_INTERVAL_SEC:
            await self.purge(settings.retention_days, now)

        state = self.compute_state(target_ids, now)
        await asyncio.to_thread(self.publish, state, settings, len(targets), now)
        _log.debug("latency round: %d targets, %d samples, %.2fs", len(targets), len(samples),
                   time.monotonic() - started)
        return float(settings.interval_sec)

    async def shutdown(self) -> None:
        await self.flush(self.now_fn(), include_current=True)
        await asyncio.to_thread(self.release_lock)

    async def run_forever(self, stop: asyncio.Event) -> None:
        _log_event(logging.INFO, "latency_monitor_started")
        while not stop.is_set():
            started = time.monotonic()
            try:
                interval = await self.run_round()
            except Exception as exc:  # never let one bad round end the loop
                _log_event(logging.ERROR, "latency_monitor_round_failed", error=str(exc))
                interval = float(LatencySettings().interval_sec)
            delay = max(0.5, interval - (time.monotonic() - started))
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=delay)
        await self.shutdown()
        _log_event(logging.INFO, "latency_monitor_stopped")


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, AttributeError, ValueError):
            loop.add_signal_handler(sig, stop.set)
    await LatencyMonitor().run_forever(stop)


if __name__ == "__main__":
    from config import settings as app_settings

    logging.basicConfig(
        level=getattr(logging, app_settings.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
