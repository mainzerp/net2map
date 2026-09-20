"""ICMP ping helpers."""
import platform


def _build_ping_cmd(ip: str, timeout_sec: int) -> list:
    if platform.system() == "Windows":
        return ["ping", "-n", "1", "-w", str(int(timeout_sec * 1000)), ip]
    return ["ping", "-c", "1", "-W", str(int(timeout_sec)), ip]
