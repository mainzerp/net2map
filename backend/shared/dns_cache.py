"""Process-wide, thread-safe TTL cache for reverse DNS answers.

Lives outside scan_engine so the single instance survives re-imports of the
scan engine modules (tests import fresh copies) and can be cleared from
anywhere.
"""
import threading
import time
from collections import OrderedDict
from typing import Callable, Optional

POSITIVE_TTL_SEC = 3600
NEGATIVE_TTL_SEC = 600
MAX_ENTRIES = 20000


class TTLCache:
    """Small LRU-ordered cache of ip -> name with per-entry expiry."""

    def __init__(self, max_entries: int = MAX_ENTRIES, positive_ttl: float = POSITIVE_TTL_SEC,
                 negative_ttl: float = NEGATIVE_TTL_SEC, clock: Callable[[], float] = time.monotonic):
        self.max_entries = max_entries
        self.positive_ttl = positive_ttl
        self.negative_ttl = negative_ttl
        self.clock = clock
        self._data: "OrderedDict[str, tuple[str, float]]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[str]:
        """Cached value or None when missing or expired."""
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            value, expires = entry
            if expires <= self.clock():
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key: str, value: str) -> None:
        """Store a value; empty values use the negative TTL."""
        ttl = self.positive_ttl if value else self.negative_ttl
        with self._lock:
            now = self.clock()
            if key not in self._data and len(self._data) >= self.max_entries:
                self._evict(now)
            self._data[key] = (value, now + ttl)
            self._data.move_to_end(key)

    def _evict(self, now: float) -> None:
        # Drop expired entries first; if still full, drop the oldest quarter.
        for k in [k for k, (_, exp) in self._data.items() if exp <= now]:
            del self._data[k]
        if len(self._data) >= self.max_entries:
            for _ in range(max(1, self.max_entries // 4)):
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


DNS_CACHE = TTLCache()
