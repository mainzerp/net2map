"""Pure latency statistics: median, p95, window aggregation, baseline, status."""
from datetime import datetime, timezone

from latency import stats
from latency.probe import Sample


def _sample(rtt, loss=0.0, jitter=None, sent=3):
    return Sample(device_id=1, ts=datetime.now(timezone.utc), rtt_avg_ms=rtt, rtt_min_ms=rtt,
                  rtt_max_ms=rtt, jitter_ms=jitter, loss_pct=loss, sent=sent)


def test_median_odd_even_empty_and_none():
    assert stats.median([3, 1, 2]) == 2
    assert stats.median([4, 1, 3, 2]) == 2.5
    assert stats.median([]) is None
    assert stats.median([None, 5, None]) == 5


def test_p95_nearest_rank():
    assert stats.p95(list(range(1, 101))) == 95
    assert stats.p95([7]) == 7
    assert stats.p95([]) is None


def test_aggregate_window_weights_loss_by_sent():
    window = [_sample(1.0, jitter=0.2), _sample(3.0, jitter=0.4), _sample(None, loss=100.0)]
    agg = stats.aggregate_window(window)
    assert agg["rtt_ms"] == 2.0
    assert abs(agg["jitter_ms"] - 0.3) < 1e-9
    assert agg["loss_pct"] == 33.33
    assert agg["count"] == 3


def test_aggregate_window_empty():
    agg = stats.aggregate_window([])
    assert agg == {"rtt_ms": None, "jitter_ms": None, "loss_pct": None, "count": 0}


def test_baseline_requires_minimum_values():
    assert stats.compute_baseline([1.0] * (stats.BASELINE_MIN_VALUES - 1)) is None
    assert stats.compute_baseline([1.0] * stats.BASELINE_MIN_VALUES) == 1.0
    assert stats.compute_baseline([None] * 100) is None


def test_classify_each_branch():
    assert stats.classify(0, None, None, None) == "unknown"
    assert stats.classify(3, 100.0, None, 1.0) == "down"
    assert stats.classify(3, 10.0, 1.0, 1.0) == "loss"
    assert stats.classify(3, 5.0, 1.0, 1.0) == "ok"  # exactly 5 % is not loss
    # baseline 1 ms: threshold max(3, 6) = 6 ms
    assert stats.classify(3, 0.0, 6.5, 1.0) == "degraded"
    assert stats.classify(3, 0.0, 5.9, 1.0) == "ok"
    # baseline 10 ms: threshold max(30, 15) = 30 ms
    assert stats.classify(3, 0.0, 31.0, 10.0) == "degraded"
    assert stats.classify(3, 0.0, 29.0, 10.0) == "ok"
    # no baseline: never degraded
    assert stats.classify(3, 0.0, 500.0, None) == "ok"


def test_status_severity_order():
    assert list(stats.STATUS_SEVERITY) == ["down", "loss", "degraded", "ok", "unknown"]
