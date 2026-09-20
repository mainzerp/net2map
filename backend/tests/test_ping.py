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
