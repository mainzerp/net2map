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

        def _run(l: asyncio.AbstractEventLoop):
            asyncio.set_event_loop(l)
            l.run_forever()

        t = threading.Thread(target=_run, args=(loop,), daemon=True)
        t.start()
        _bg_loop = loop
        return loop
