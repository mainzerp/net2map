"""Shared background asyncio event loop, reused across all scan invocations."""
import asyncio
import threading
from typing import Optional

_bg_loop: Optional[asyncio.AbstractEventLoop] = None
_bg_loop_lock = threading.Lock()


def _get_bg_loop() -> asyncio.AbstractEventLoop:
    """Return the shared background event loop, starting it lazily."""
    global _bg_loop
    if _bg_loop is not None and _bg_loop.is_running():
        return _bg_loop
    with _bg_loop_lock:
        if _bg_loop is not None and _bg_loop.is_running():
            return _bg_loop
        loop = asyncio.new_event_loop()
        started = threading.Event()

        def _run(event_loop: asyncio.AbstractEventLoop, started_event: threading.Event):
            asyncio.set_event_loop(event_loop)
            # Signal from inside the loop thread once run_forever() is active,
            # so callers never receive a loop that is not running yet.
            event_loop.call_soon(started_event.set)
            event_loop.run_forever()

        t = threading.Thread(target=_run, args=(loop, started), daemon=True)
        t.start()
        started.wait(timeout=5)
        _bg_loop = loop
        return loop
