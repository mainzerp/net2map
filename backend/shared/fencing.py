"""Database-side fencing for distributed leases.

A lease holder writes its fencing token into ``lease_fences`` inside the
same transaction as its data. The conditional upsert only succeeds while the
token is not lower than the highest token already stored for the lease, so a
holder whose lease expired and was reacquired by someone else (who received a
larger token) can no longer commit.

On PostgreSQL the upsert takes a row lock on the fence row that is held until
the transaction ends. Concurrent holders of the same lease therefore
serialize on that row: an older token either commits before the newer one or
re-evaluates the WHERE clause after the newer one committed and fails.
"""
from sqlalchemy import text
from sqlalchemy.engine import Connection

# Identical statement for PostgreSQL (>= 9.5) and SQLite (>= 3.24). A
# rejected update affects zero rows; an insert or accepted update affects one.
FENCE_UPSERT_SQL = text(
    "INSERT INTO lease_fences (name, token, updated_at)"
    " VALUES (:name, :token, CURRENT_TIMESTAMP)"
    " ON CONFLICT (name) DO UPDATE"
    " SET token = excluded.token, updated_at = excluded.updated_at"
    " WHERE lease_fences.token <= excluded.token"
)

_SUPPORTED_DIALECTS = {"postgresql", "sqlite"}


def apply_fence(connection: Connection, name: str, token: int) -> bool:
    """Record *token* for lease *name* in the current transaction.

    Returns True when the token is current (inserted, equal or newer) and
    False when a newer token has already been stored (stale lease holder).
    Unsupported dialects raise instead of silently skipping the fence.
    """
    dialect = connection.dialect.name
    if dialect not in _SUPPORTED_DIALECTS:
        raise RuntimeError("Lease fencing is not supported on dialect %r" % dialect)
    result = connection.execute(FENCE_UPSERT_SQL, {"name": name, "token": int(token)})
    return result.rowcount == 1
