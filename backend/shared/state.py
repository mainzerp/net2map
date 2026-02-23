"""Shared in-process state: log buffer and scan job registry.

LOG_BUFFER is in-process memory. The app MUST run with --workers 1.
"""
import json
import logging
import threading
from collections import deque
from datetime import datetime
from typing import Dict

LOG_BUFFER: deque = deque(maxlen=5000)
LOG_BUFFER_LOCK: threading.Lock = threading.Lock()

SCAN_JOBS: Dict[str, dict] = {}
SCAN_JOBS_LOCK: threading.Lock = threading.Lock()

log = logging.getLogger(__name__)


def _log_event(level: int, event: str, **fields) -> None:
    payload = {
        "ts": datetime.utcnow().isoformat() + "Z",
        "level": logging.getLevelName(level),
        "event": event,
        **fields,
    }
    line = json.dumps(payload, ensure_ascii=False)
    with LOG_BUFFER_LOCK:
        LOG_BUFFER.append(payload)
    log.log(level, line)
