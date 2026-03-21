"""Tests for scan_engine/ping.py functions."""
import sys
from unittest.mock import MagicMock, patch

# The conftest mocks `scan_engine` as a MagicMock. We need the real modules
# for ping tests, so remove the mock entries and import fresh.
for _key in list(sys.modules.keys()):
    if _key == "scan_engine" or _key.startswith("scan_engine."):
        del sys.modules[_key]

import scan_engine.ping as _ping_mod

# Restore the top-level mock so other tests are not affected
sys.modules.setdefault("scan_engine", MagicMock())


def test_build_ping_cmd_windows():
    """_build_ping_cmd uses -n and -w on Windows."""
    with patch.object(_ping_mod.platform, "system", return_value="Windows"):
        cmd = _ping_mod._build_ping_cmd("10.0.0.1", 2)
        assert cmd == ["ping", "-n", "1", "-w", "2000", "10.0.0.1"]


def test_build_ping_cmd_linux():
    """_build_ping_cmd uses -c and -W on Linux."""
    with patch.object(_ping_mod.platform, "system", return_value="Linux"):
        cmd = _ping_mod._build_ping_cmd("10.0.0.1", 2)
        assert cmd == ["ping", "-c", "1", "-W", "2", "10.0.0.1"]


def test_ping_host_success():
    """_ping_host returns (True, rtt_ms) on success."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Reply from 10.0.0.1: bytes=32 time=5ms TTL=64"
    mock_result.stderr = ""

    with patch.object(_ping_mod.subprocess, "run", return_value=mock_result):
        ok, rtt = _ping_mod._ping_host("10.0.0.1", timeout_sec=1)
        assert ok is True
        assert rtt == 5


def test_ping_host_unreachable():
    """_ping_host returns (False, 0) when ping fails."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = "Request timed out."
    mock_result.stderr = ""

    with patch.object(_ping_mod.subprocess, "run", return_value=mock_result):
        ok, rtt = _ping_mod._ping_host("10.0.0.99", timeout_sec=1)
        assert ok is False
        assert rtt == 0


def test_ping_host_empty_ip():
    """_ping_host returns (False, 0) for empty IP without calling subprocess."""
    with patch.object(_ping_mod.subprocess, "run") as mock_run:
        ok, rtt = _ping_mod._ping_host("", timeout_sec=1)
        assert ok is False
        assert rtt == 0
        mock_run.assert_not_called()


def test_ping_host_exception():
    """_ping_host returns (False, 0) when subprocess raises."""
    with patch.object(_ping_mod.subprocess, "run", side_effect=Exception("boom")):
        ok, rtt = _ping_mod._ping_host("10.0.0.1", timeout_sec=1)
        assert ok is False
        assert rtt == 0


def test_ping_host_parses_decimal_rtt():
    """_ping_host parses fractional millisecond RTT values."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=1.23 ms"
    mock_result.stderr = ""

    with patch.object(_ping_mod.subprocess, "run", return_value=mock_result):
        ok, rtt = _ping_mod._ping_host("10.0.0.1", timeout_sec=1)
        assert ok is True
        assert rtt == 1  # int(1.23) = 1
