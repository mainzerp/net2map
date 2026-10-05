"""Redis client with lazy connection pool and graceful fallback."""
import logging

from config import settings

REDIS_URL = settings.redis_url
REDIS_TIMEOUT_SECONDS = 2.0

_pool = None
_log = logging.getLogger(__name__)


def get_redis():
    """Return a Redis client or None if REDIS_URL is not configured or redis is unavailable."""
    global _pool
    if not REDIS_URL:
        return None
    try:
        import redis as redis_lib
        from redis.backoff import NoBackoff
        from redis.retry import Retry

        if _pool is None:
            _pool = redis_lib.ConnectionPool.from_url(
                REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=REDIS_TIMEOUT_SECONDS,
                socket_timeout=REDIS_TIMEOUT_SECONDS,
                # Fail closed promptly; callers decide whether an operation can
                # be retried without duplicating a mutation or losing ownership.
                retry=Retry(NoBackoff(), 0),
            )
        return redis_lib.Redis(connection_pool=_pool)
    except ImportError:
        return None
    except Exception as exc:
        _log.warning("Redis connection pool error: %s", exc)
        return None
