"""Redis client with lazy connection pool and graceful fallback."""
import logging

from config import settings

REDIS_URL = settings.redis_url

_pool = None
_log = logging.getLogger(__name__)


def get_redis():
    """Return a Redis client or None if REDIS_URL is not configured or redis is unavailable."""
    global _pool
    if not REDIS_URL:
        return None
    try:
        import redis as redis_lib
        if _pool is None:
            _pool = redis_lib.ConnectionPool.from_url(REDIS_URL, decode_responses=True)
        return redis_lib.Redis(connection_pool=_pool)
    except ImportError:
        return None
    except Exception as exc:
        _log.warning("Redis connection pool error: %s", exc)
        return None
