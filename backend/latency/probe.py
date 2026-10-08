"""ICMP probe for the latency monitor.

Runs the system ``ping`` binary as a subprocess (iputils on Linux, the same
binary the scan engine uses) and parses its summary lines. Parsing is a pure
function so it can be tested without a network.
"""
import asyncio
import contextlib
import logging
import platform
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

_log = logging.getLogger(__name__)

# Linux iputils: "3 packets transmitted, 2 received, 33.3333% packet loss, time 402ms"
# BusyBox:       "3 packets transmitted, 2 packets received, 33% packet loss"
_RE_LINUX_COUNTS = re.compile(r"(\d+)\s+packets?\s+transmitted,\s+(\d+)\s+(?:packets\s+)?received")
# iputils: "rtt min/avg/max/mdev = 0.045/0.052/0.061/0.007 ms"
# BusyBox: "round-trip min/avg/max = 0.045/0.052/0.061 ms"
_RE_LINUX_RTT = re.compile(
    r"min/avg/max(?:/(?:mdev|stddev))?\s*=\s*([\d.]+)/([\d.]+)/([\d.]+)(?:/([\d.]+))?\s*ms"
)
# Windows (English / German locale): "Sent = 3, Received = 3" / "Gesendet = 3, Empfangen = 3"
_RE_WIN_COUNTS = re.compile(r"(?:sent|gesendet)\s*=\s*(\d+),\s*(?:received|empfangen)\s*=\s*(\d+)", re.IGNORECASE)
_RE_WIN_MIN = re.compile(r"minimum\s*=\s*(\d+)\s*ms", re.IGNORECASE)
_RE_WIN_MAX = re.compile(r"maximum\s*=\s*(\d+)\s*ms", re.IGNORECASE)
_RE_WIN_AVG = re.compile(r"(?:average|mittelwert)\s*=\s*(\d+)\s*ms", re.IGNORECASE)

# Interval between echo requests; 0.2 s is the minimum iputils allows for
# unprivileged users.
PING_INTERVAL_SEC = 0.2


@dataclass
class Sample:
    """Result of one probe (``sent`` echo requests) against one device."""
    device_id: int
    ts: datetime
    rtt_avg_ms: Optional[float]
    rtt_min_ms: Optional[float]
    rtt_max_ms: Optional[float]
    jitter_ms: Optional[float]
    loss_pct: float
    sent: int


@dataclass
class PingResult:
    """Parsed ping summary, independent of the device it belongs to."""
    sent: int
    received: int
    loss_pct: float
    rtt_min_ms: Optional[float] = None
    rtt_avg_ms: Optional[float] = None
    rtt_max_ms: Optional[float] = None
    jitter_ms: Optional[float] = None


def parse_ping_output(output: str, count: int) -> PingResult:
    """Parse ping stdout into a PingResult.

    Unparseable output (unknown host, missing binary, killed process) counts
    as total loss of ``count`` echo requests.
    """
    text = output or ""
    sent = received = None
    m = _RE_LINUX_COUNTS.search(text) or _RE_WIN_COUNTS.search(text)
    if m:
        sent, received = int(m.group(1)), int(m.group(2))
    if not sent:
        return PingResult(sent=max(1, count), received=0, loss_pct=100.0)
    received = min(received, sent)
    loss_pct = round((sent - received) * 100.0 / sent, 2)
    result = PingResult(sent=sent, received=received, loss_pct=loss_pct)
    if received == 0:
        return result

    m = _RE_LINUX_RTT.search(text)
    if m:
        result.rtt_min_ms = float(m.group(1))
        result.rtt_avg_ms = float(m.group(2))
        result.rtt_max_ms = float(m.group(3))
        result.jitter_ms = float(m.group(4)) if m.group(4) is not None else None
        return result

    m_avg = _RE_WIN_AVG.search(text)
    if m_avg:
        result.rtt_avg_ms = float(m_avg.group(1))
        m_min, m_max = _RE_WIN_MIN.search(text), _RE_WIN_MAX.search(text)
        result.rtt_min_ms = float(m_min.group(1)) if m_min else None
        result.rtt_max_ms = float(m_max.group(1)) if m_max else None
        if result.rtt_min_ms is not None and result.rtt_max_ms is not None:
            # Windows reports no mdev; half the min/max spread is a rough stand-in.
            result.jitter_ms = (result.rtt_max_ms - result.rtt_min_ms) / 2.0
    return result


def build_probe_cmd(ip: str, count: int, timeout_sec: int) -> list[str]:
    if platform.system() == "Windows":
        return ["ping", "-n", str(count), "-w", str(int(timeout_sec * 1000)), ip]
    return ["ping", "-c", str(count), "-i", str(PING_INTERVAL_SEC), "-W", str(int(timeout_sec)), "-q", ip]


async def run_ping(ip: str, count: int, timeout_sec: int) -> str:
    """Run ping and return its stdout; empty string on timeout or start failure."""
    cmd = build_probe_cmd(ip, count, timeout_sec)
    guard = count * PING_INTERVAL_SEC + timeout_sec + 2.0
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    except (OSError, ValueError) as exc:
        _log.warning("latency probe could not start ping for %s: %s", ip, exc)
        return ""
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=guard)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        return ""
    except asyncio.CancelledError:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
        await proc.wait()
        raise
    return stdout.decode(errors="replace")


async def probe(device_id: int, ip: str, count: int, timeout_sec: int = 1) -> Sample:
    """Send ``count`` echo requests to ``ip`` and return a Sample."""
    ts = datetime.now(timezone.utc)
    output = await run_ping(ip, count, timeout_sec) if ip else ""
    res = parse_ping_output(output, count)
    return Sample(
        device_id=device_id,
        ts=ts,
        rtt_avg_ms=res.rtt_avg_ms,
        rtt_min_ms=res.rtt_min_ms,
        rtt_max_ms=res.rtt_max_ms,
        jitter_ms=res.jitter_ms,
        loss_pct=res.loss_pct,
        sent=res.sent,
    )
