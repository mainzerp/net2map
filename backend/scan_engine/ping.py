"""ICMP ping helpers."""
import platform
import re
import subprocess


def _build_ping_cmd(ip: str, timeout_sec: int) -> list:
    if platform.system() == "Windows":
        return ["ping", "-n", "1", "-w", str(int(timeout_sec * 1000)), ip]
    return ["ping", "-c", "1", "-W", str(int(timeout_sec)), ip]


def _ping_host(ip: str, timeout_sec: int = 1) -> tuple[bool, int]:
    """Best-effort ICMP ping via system command. Returns (reachable, rtt_ms)."""
    if not ip:
        return False, 0

    cmds = [_build_ping_cmd(ip, timeout_sec)]

    for cmd in cmds:
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(1, timeout_sec + 1),
            )
        except Exception:
            continue

        out = f"{completed.stdout}\n{completed.stderr}".lower()
        if completed.returncode != 0:
            continue

        # Parse common rtt formats: time=1.23 ms / time<1ms / durchschnitt = 2ms
        patterns = [
            r"time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms",
            r"average\s*=\s*([0-9]+)ms",
            r"durchschnitt\s*=\s*([0-9]+)ms",
        ]
        for pattern in patterns:
            m = re.search(pattern, out)
            if m:
                try:
                    return True, int(float(m.group(1)))
                except ValueError:
                    pass
        return True, 1

    return False, 0
