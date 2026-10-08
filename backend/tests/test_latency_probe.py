"""Ping output parsing and command building for the latency probe."""
import asyncio
from unittest.mock import patch

from latency import probe as probe_mod
from latency.probe import build_probe_cmd, parse_ping_output

LINUX_PARTIAL_LOSS = """PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.

--- 10.0.0.1 ping statistics ---
3 packets transmitted, 2 received, 33.3333% packet loss, time 402ms
rtt min/avg/max/mdev = 0.412/0.530/0.648/0.118 ms
"""

LINUX_TOTAL_LOSS = """PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.

--- 10.0.0.2 ping statistics ---
3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2050ms
"""

LINUX_NO_RTT_LINE = """--- 10.0.0.3 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 400ms
"""

BUSYBOX = """--- 10.0.0.4 ping statistics ---
3 packets transmitted, 3 packets received, 0% packet loss
round-trip min/avg/max = 1.100/1.200/1.300 ms
"""

WINDOWS_DE = """Ping-Statistik fuer 10.0.0.5:
    Pakete: Gesendet = 3, Empfangen = 3, Verloren = 0
Ca. Zeitangaben in Millisek.:
    Minimum = 1ms, Maximum = 3ms, Mittelwert = 2ms
"""


def test_parse_linux_partial_loss():
    res = parse_ping_output(LINUX_PARTIAL_LOSS, 3)
    assert res.sent == 3 and res.received == 2
    assert res.loss_pct == 33.33
    assert res.rtt_min_ms == 0.412
    assert res.rtt_avg_ms == 0.530
    assert res.rtt_max_ms == 0.648
    assert res.jitter_ms == 0.118


def test_parse_linux_total_loss():
    res = parse_ping_output(LINUX_TOTAL_LOSS, 3)
    assert res.sent == 3 and res.received == 0
    assert res.loss_pct == 100.0
    assert res.rtt_avg_ms is None and res.jitter_ms is None


def test_parse_linux_without_rtt_line():
    res = parse_ping_output(LINUX_NO_RTT_LINE, 3)
    assert res.loss_pct == 0.0
    assert res.rtt_avg_ms is None


def test_parse_busybox_without_mdev():
    res = parse_ping_output(BUSYBOX, 3)
    assert res.loss_pct == 0.0
    assert res.rtt_avg_ms == 1.2
    assert res.jitter_ms is None


def test_parse_windows_german_locale():
    res = parse_ping_output(WINDOWS_DE, 3)
    assert res.sent == 3 and res.loss_pct == 0.0
    assert res.rtt_avg_ms == 2.0
    assert res.jitter_ms == 1.0


def test_parse_garbage_counts_as_total_loss():
    for output in ("", "ping: unknown host foo"):
        res = parse_ping_output(output, 4)
        assert res.sent == 4 and res.loss_pct == 100.0 and res.rtt_avg_ms is None


def test_build_probe_cmd_linux():
    with patch.object(probe_mod.platform, "system", return_value="Linux"):
        assert build_probe_cmd("10.0.0.1", 3, 1) == ["ping", "-c", "3", "-i", "0.2", "-W", "1", "-q", "10.0.0.1"]


def test_build_probe_cmd_windows():
    with patch.object(probe_mod.platform, "system", return_value="Windows"):
        assert build_probe_cmd("10.0.0.1", 3, 1) == ["ping", "-n", "3", "-w", "1000", "10.0.0.1"]


def test_probe_builds_sample_from_ping_output():
    async def fake_run_ping(ip, count, timeout_sec):
        return LINUX_PARTIAL_LOSS

    with patch.object(probe_mod, "run_ping", fake_run_ping):
        sample = asyncio.run(probe_mod.probe(7, "10.0.0.1", 3))
    assert sample.device_id == 7
    assert sample.sent == 3
    assert sample.loss_pct == 33.33
    assert sample.rtt_avg_ms == 0.530
    assert sample.ts.tzinfo is not None


def test_run_ping_missing_binary_returns_empty():
    async def boom(*args, **kwargs):
        raise FileNotFoundError("ping")

    with patch.object(probe_mod.asyncio, "create_subprocess_exec", boom):
        assert asyncio.run(probe_mod.run_ping("10.0.0.1", 1, 1)) == ""
