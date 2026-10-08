"""Pure statistics for the latency monitor (no I/O)."""
import math
from typing import Iterable, Optional, Sequence

# Minimum number of minute rollups in the last 24 h before a baseline exists.
BASELINE_MIN_VALUES = 30
LOSS_THRESHOLD_PCT = 5.0

# Severity order used for sorting (most severe first).
STATUSES = ("down", "loss", "degraded", "ok", "unknown")
STATUS_SEVERITY = {status: index for index, status in enumerate(STATUSES)}


def _clean(values: Iterable[Optional[float]]) -> list[float]:
    return [float(v) for v in values if v is not None]


def median(values: Iterable[Optional[float]]) -> Optional[float]:
    data = sorted(_clean(values))
    if not data:
        return None
    mid = len(data) // 2
    if len(data) % 2:
        return data[mid]
    return (data[mid - 1] + data[mid]) / 2.0


def mean(values: Iterable[Optional[float]]) -> Optional[float]:
    data = _clean(values)
    if not data:
        return None
    return sum(data) / len(data)


def p95(values: Iterable[Optional[float]]) -> Optional[float]:
    """95th percentile, nearest-rank method."""
    data = sorted(_clean(values))
    if not data:
        return None
    rank = max(1, math.ceil(0.95 * len(data)))
    return data[rank - 1]


def window_loss_pct(samples: Sequence) -> Optional[float]:
    """Loss over all echo requests of the window, weighted by ``sent``."""
    total = sum(max(0, int(s.sent or 0)) for s in samples)
    if total <= 0:
        return None
    lost = sum((float(s.loss_pct) / 100.0) * max(0, int(s.sent or 0)) for s in samples)
    return round(lost * 100.0 / total, 2)


def aggregate_window(samples: Sequence) -> dict:
    """Aggregate a rolling window of Samples.

    Returns ``{"rtt_ms", "jitter_ms", "loss_pct", "count"}``: median of the
    per-sample average RTT, mean jitter, sent-weighted loss.
    """
    return {
        "rtt_ms": median(s.rtt_avg_ms for s in samples),
        "jitter_ms": mean(s.jitter_ms for s in samples),
        "loss_pct": window_loss_pct(samples),
        "count": len(samples),
    }


def compute_baseline(rtt_values: Iterable[Optional[float]]) -> Optional[float]:
    """Median of the last 24 h minute averages; None below BASELINE_MIN_VALUES."""
    data = _clean(rtt_values)
    if len(data) < BASELINE_MIN_VALUES:
        return None
    return median(data)


def classify(
    sample_count: int,
    loss_pct: Optional[float],
    rtt_ms: Optional[float],
    baseline_ms: Optional[float],
) -> str:
    """Status of one device from its window aggregate and baseline."""
    if sample_count <= 0 or loss_pct is None:
        return "unknown"
    if loss_pct >= 100.0:
        return "down"
    if loss_pct > LOSS_THRESHOLD_PCT:
        return "loss"
    if baseline_ms is not None and rtt_ms is not None and rtt_ms > max(3.0 * baseline_ms, baseline_ms + 5.0):
        return "degraded"
    return "ok"


def round_ms(value: Optional[float], digits: int = 3) -> Optional[float]:
    return None if value is None else round(float(value), digits)
