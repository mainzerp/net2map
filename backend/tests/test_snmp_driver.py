"""Exercise the installed SNMP driver outside the API suite's module mocks."""

import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("scenario", ["credentials", "get", "walk", "raw", "duplicate", "retry", "discovery"])
def test_real_snmp_driver(scenario):
    probe = Path(__file__).with_name("_snmp_driver_probe.py")
    completed = subprocess.run(
        [sys.executable, str(probe), scenario],
        cwd=probe.parent.parent,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
