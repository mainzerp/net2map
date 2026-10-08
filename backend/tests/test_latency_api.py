"""Latency API: summary (Redis and rollup fallback), history, settings, device flag."""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from database import AppSetting, Device, LatencySample
from latency.monitor import HEARTBEAT_KEY, STATE_KEY
from latency.store import minute_floor
from tests._latency_fakes import FakeRedis


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    import routers.settings as _s
    _s.limiter.reset()
    yield
    _s.limiter.reset()


def _devices(db):
    a = Device(sys_name="sw-a", ip="10.1.0.1", label="Core A")
    b = Device(sys_name="sw-b", ip="10.1.0.2")
    c = Device(sys_name="", ip="10.1.0.3")
    ignored = Device(sys_name="sw-ign", ip="10.1.0.4", ignored=True)
    db.add_all([a, b, c, ignored])
    db.commit()
    return a, b, c, ignored


def _set_setting(db, key, value):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    db.commit()


def _row(device, ts, rtt, loss=0.0, jitter=0.1):
    return LatencySample(device_id=device.id, bucket_ts=ts, rtt_avg_ms=rtt, rtt_min_ms=rtt, rtt_max_ms=rtt,
                         jitter_ms=jitter, loss_pct=loss, probes=18)


def test_summary_fallback_from_rollups(client, viewer_jwt_headers, db):
    a, b, c, _ = _devices(db)
    now = datetime.now(timezone.utc)
    db.add_all([
        _row(a, minute_floor(now - timedelta(minutes=3)), 9.0),
        _row(a, minute_floor(now - timedelta(minutes=1)), 2.0),
        _row(b, minute_floor(now - timedelta(minutes=1)), None, loss=100.0, jitter=None),
        _row(c, minute_floor(now - timedelta(minutes=30)), 1.0),  # too old for the fallback
    ])
    db.commit()

    r = client.get("/api/v1/latency/summary", headers=viewer_jwt_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True and body["mode"] == "all" and body["interval_sec"] == 10
    assert body["monitor_alive"] is True
    assert body["updated_at"] is not None
    ids = [d["device_id"] for d in body["devices"]]
    assert ids == [b.id, a.id, c.id]  # down, ok, unknown; ignored device excluded
    by_id = {d["device_id"]: d for d in body["devices"]}
    assert by_id[a.id]["name"] == "Core A" and by_id[a.id]["rtt_ms"] == 2.0 and by_id[a.id]["status"] == "ok"
    assert by_id[b.id]["name"] == "sw-b" and by_id[b.id]["status"] == "down"
    assert by_id[c.id]["name"] == "10.1.0.3" and by_id[c.id]["status"] == "unknown"
    net = body["network"]
    assert net["targets"] == 3 and net["reachable"] == 1 and net["degraded"] == 1
    assert net["median_ms"] == 2.0 and net["p95_ms"] == 2.0
    assert net["loss_pct"] == 50.0


def test_summary_empty_without_data(client, auth_headers):
    body = client.get("/api/v1/latency/summary", headers=auth_headers).json()
    assert body["monitor_alive"] is False
    assert body["updated_at"] is None
    assert body["devices"] == []
    assert body["network"] == {"median_ms": None, "p95_ms": None, "loss_pct": None,
                               "targets": 0, "reachable": 0, "degraded": 0}


def test_summary_from_redis_state_and_selected_mode(client, auth_headers, db):
    a, b, c, _ = _devices(db)
    b.latency_monitored = True
    c.latency_monitored = True
    _set_setting(db, "latency_mode", "selected")
    now = datetime.now(timezone.utc).isoformat()
    fake = FakeRedis()
    fake.hset(STATE_KEY, mapping={
        str(a.id): json.dumps({"device_id": a.id, "rtt_ms": 1.0, "loss_pct": 0.0, "status": "ok", "updated_at": now}),
        str(b.id): json.dumps({"device_id": b.id, "rtt_ms": 40.0, "jitter_ms": 2.0, "loss_pct": 0.0,
                               "baseline_ms": 2.0, "status": "degraded", "updated_at": now}),
        str(c.id): json.dumps({"device_id": c.id, "rtt_ms": 3.0, "loss_pct": 0.0, "status": "ok", "updated_at": now}),
    })
    fake.set(HEARTBEAT_KEY, json.dumps({"updated_at": now, "interval_sec": 10, "targets": 2}))

    with patch("routers.latency.get_redis", return_value=fake):
        body = client.get("/api/v1/latency/summary", headers=auth_headers).json()
    assert body["mode"] == "selected"
    assert body["monitor_alive"] is True
    assert [d["device_id"] for d in body["devices"]] == [b.id, c.id]  # a is not opted in
    assert body["devices"][0]["status"] == "degraded" and body["devices"][0]["baseline_ms"] == 2.0
    assert body["network"]["degraded"] == 1 and body["network"]["reachable"] == 2


def test_summary_stale_heartbeat_is_not_alive(client, auth_headers, db):
    old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    fake = FakeRedis()
    fake.set(HEARTBEAT_KEY, json.dumps({"updated_at": old, "interval_sec": 10, "targets": 0}))
    with patch("routers.latency.get_redis", return_value=fake):
        body = client.get("/api/v1/latency/summary", headers=auth_headers).json()
    assert body["monitor_alive"] is False
    assert body["updated_at"] is not None


def test_summary_dead_monitor_reports_unknown(client, auth_headers, db):
    a, _, _, _ = _devices(db)
    old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    fake = FakeRedis()
    fake.hset(STATE_KEY, mapping={
        str(a.id): json.dumps({"device_id": a.id, "rtt_ms": 40.0, "jitter_ms": 2.0, "loss_pct": 0.0,
                               "baseline_ms": 2.0, "status": "degraded", "updated_at": old}),
    })
    fake.set(HEARTBEAT_KEY, json.dumps({"updated_at": old, "interval_sec": 10, "targets": 1}))
    with patch("routers.latency.get_redis", return_value=fake):
        body = client.get("/api/v1/latency/summary", headers=auth_headers).json()
    assert body["monitor_alive"] is False
    entry = next(d for d in body["devices"] if d["device_id"] == a.id)
    assert entry["status"] == "unknown"
    assert entry["rtt_ms"] is None and entry["jitter_ms"] is None and entry["loss_pct"] is None
    assert entry["baseline_ms"] == 2.0 and entry["updated_at"] == old
    assert all(d["status"] == "unknown" for d in body["devices"])
    net = body["network"]
    assert net["median_ms"] is None and net["p95_ms"] is None and net["loss_pct"] is None
    assert net["reachable"] == 0 and net["degraded"] == 0


def test_history_device_and_network_buckets(client, auth_headers, db):
    a, b, _, _ = _devices(db)
    base = minute_floor(datetime.now(timezone.utc) - timedelta(minutes=10))
    db.add_all([
        _row(a, base, 1.0, loss=0.0),
        _row(a, base + timedelta(minutes=1), 3.0, loss=10.0),
        _row(b, base, 5.0, loss=20.0),
    ])
    db.commit()

    r = client.get(f"/api/v1/latency/history?range=1h&device_id={a.id}", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["range"] == "1h" and body["device_id"] == a.id and body["bucket_sec"] == 60
    assert [p["rtt_ms"] for p in body["points"]] == [1.0, 3.0]
    assert [p["loss_pct"] for p in body["points"]] == [0.0, 10.0]
    first_ts = datetime.fromisoformat(body["points"][0]["ts"])
    assert first_ts == base

    body = client.get("/api/v1/latency/history?range=1h", headers=auth_headers).json()
    assert body["device_id"] is None
    assert [p["rtt_ms"] for p in body["points"]] == [3.0, 3.0]  # median(1, 5), then 3
    assert [p["loss_pct"] for p in body["points"]] == [10.0, 10.0]  # mean(0, 20), then 10


def test_history_coarser_buckets_merge_minutes(client, auth_headers, db):
    a, _, _, _ = _devices(db)
    now = datetime.now(timezone.utc)
    base = now.replace(minute=(now.minute // 5) * 5, second=0, microsecond=0) - timedelta(minutes=30)
    db.add_all([_row(a, base, 1.0), _row(a, base + timedelta(minutes=1), 3.0),
                _row(a, now - timedelta(days=2), 50.0)])
    db.commit()
    body = client.get(f"/api/v1/latency/history?range=24h&device_id={a.id}", headers=auth_headers).json()
    assert body["bucket_sec"] == 300
    assert [p["rtt_ms"] for p in body["points"]] == [2.0]
    body = client.get(f"/api/v1/latency/history?range=7d&device_id={a.id}", headers=auth_headers).json()
    assert body["bucket_sec"] == 1800
    assert len(body["points"]) == 2


def test_history_rejects_invalid_range(client, auth_headers):
    assert client.get("/api/v1/latency/history?range=2h", headers=auth_headers).status_code == 422


def test_history_unknown_device_404(client, auth_headers):
    assert client.get("/api/v1/latency/history?range=1h&device_id=999", headers=auth_headers).status_code == 404


def test_latency_requires_auth(client):
    assert client.get("/api/v1/latency/summary").status_code == 401


@pytest.mark.parametrize("key,value,expected", [
    ("latency_interval_sec", "15", "15"),
    ("latency_enabled", "FALSE", "false"),
    ("latency_mode", "Selected", "selected"),
    ("latency_pings", "10", "10"),
    ("latency_retention_days", "365", "365"),
])
def test_latency_settings_accept_and_normalize(client, jwt_headers, key, value, expected):
    r = client.put(f"/api/v1/settings/{key}", json={"value": value}, headers=jwt_headers)
    assert r.status_code == 200
    assert r.json()["value"] == expected


@pytest.mark.parametrize("key,value", [
    ("latency_interval_sec", "4"),
    ("latency_interval_sec", "abc"),
    ("latency_pings", "11"),
    ("latency_retention_days", "0"),
    ("latency_mode", "some"),
    ("latency_enabled", "maybe"),
])
def test_latency_settings_reject_invalid(client, jwt_headers, key, value):
    r = client.put(f"/api/v1/settings/{key}", json={"value": value}, headers=jwt_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_SETTING_VALUE"


def test_device_meta_updates_latency_flag(client, jwt_headers, db):
    dev = Device(sys_name="lat-sw", ip="10.2.0.1")
    db.add(dev)
    db.commit()
    r = client.patch(f"/api/v1/topology/devices/{dev.id}/meta", json={"latency_monitored": True}, headers=jwt_headers)
    assert r.status_code == 200
    assert r.json()["latency_monitored"] is True
    db.refresh(dev)
    assert dev.latency_monitored is True

    listed = client.get("/api/v1/devices", headers=jwt_headers).json()
    assert any(d["id"] == dev.id and d["latency_monitored"] is True for d in listed)

    from database import AuditLog
    entry = db.query(AuditLog).filter(AuditLog.resource == "device_meta").order_by(AuditLog.id.desc()).first()
    assert entry is not None and "latency_monitored" in entry.details["fields"]


def test_device_meta_latency_flag_viewer_forbidden(client, viewer_jwt_headers, db):
    dev = Device(sys_name="lat-sw2", ip="10.2.0.2")
    db.add(dev)
    db.commit()
    r = client.patch(f"/api/v1/topology/devices/{dev.id}/meta", json={"latency_monitored": True},
                     headers=viewer_jwt_headers)
    assert r.status_code == 403


def test_device_meta_latency_flag_legacy_path_and_topology_payload(client, auth_headers, db):
    dev = Device(sys_name="lat-sw3", ip="10.2.0.3")
    db.add(dev)
    db.commit()
    nodes = client.get("/api/topology", headers=auth_headers).json()["nodes"]
    assert next(n for n in nodes if n["id"] == dev.id)["latency_monitored"] is False

    r = client.patch(f"/api/topology/devices/{dev.id}/meta", json={"latency_monitored": True}, headers=auth_headers)
    assert r.status_code == 200 and r.json()["latency_monitored"] is True

    nodes = client.get("/api/topology", headers=auth_headers).json()["nodes"]
    assert next(n for n in nodes if n["id"] == dev.id)["latency_monitored"] is True

    r = client.patch(f"/api/topology/devices/{dev.id}/meta", json={"latency_monitored": False}, headers=auth_headers)
    assert r.json()["latency_monitored"] is False
    db.refresh(dev)
    assert dev.latency_monitored is False
