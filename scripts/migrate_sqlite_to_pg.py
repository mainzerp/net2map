"""
One-shot migration script: copy all data from the old SQLite database
(/data/netmap.db) into the running PostgreSQL container.

The SQLite and PostgreSQL schemas are identical (created by the same Alembic
migrations), so this is a straight column-for-column copy.

Usage inside the running backend container:
    SQLITE_PATH=/data/netmap.db PG_HOST=postgres python /app/migrate_sqlite_to_pg.py
"""

import os
import sqlite3
import sys

import psycopg2
from psycopg2.extras import execute_values

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SQLITE_PATH = os.environ.get("SQLITE_PATH", os.path.join(os.path.dirname(__file__), "netmap_migrate.db"))

PG_HOST = os.environ.get("PG_HOST", "localhost")
PG_PORT = int(os.environ.get("PG_PORT", "5432"))
PG_DB   = os.environ.get("PG_DB",   "netmap")
PG_USER = os.environ.get("PG_USER", "netmap")
PG_PASS = os.environ.get("PG_PASS", "netmap_pw")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def pg_insert(pg_cur, table, col_names, rows, conflict="DO NOTHING"):
    if not rows:
        print(f"  {table}: 0 rows (skip)")
        return
    sql = (
        f"INSERT INTO {table} ({', '.join(col_names)}) VALUES %s "
        f"ON CONFLICT {conflict}"
    )
    execute_values(pg_cur, sql, rows)
    print(f"  {table}: {len(rows)} rows inserted")


def migrate_table(sl, pc, table, conflict_col="id", transform=None):
    """Copy all rows from SQLite table to PostgreSQL, matching columns by name."""
    try:
        # Get PostgreSQL columns for this table
        pc.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name=%s ORDER BY ordinal_position",
            (table,)
        )
        pg_cols = [r[0] for r in pc.fetchall()]
        if not pg_cols:
            print(f"  {table}: table not found in PostgreSQL (skip)")
            return

        # Get SQLite columns
        sl_cols_raw = [r[1] for r in sl.execute(f"PRAGMA table_info({table})")]
        # Only use columns that exist in both
        common_cols = [c for c in pg_cols if c in sl_cols_raw]
        if not common_cols:
            print(f"  {table}: no common columns (skip)")
            return

        # Detect boolean columns in PostgreSQL
        pc.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name=%s AND data_type='boolean'",
            (table,)
        )
        bool_cols = {r[0] for r in pc.fetchall()}
        bool_idxs = {i for i, c in enumerate(common_cols) if c in bool_cols}

        rows = []
        for r in sl.execute(f"SELECT {', '.join(common_cols)} FROM {table}"):
            row = tuple(r[c] for c in common_cols)
            if bool_idxs:
                row = tuple(
                    bool(v) if i in bool_idxs else v
                    for i, v in enumerate(row)
                )
            rows.append(row)

        if transform:
            rows = [transform(row, common_cols) for row in rows]

        pg_insert(pc, table, common_cols, rows,
                  conflict=f"({conflict_col}) DO NOTHING" if conflict_col else "DO NOTHING")
    except Exception as e:
        print(f"  WARNING {table}: {e}")
        import traceback; traceback.print_exc()
        pg.rollback()
        pc.execute("SET session_replication_role = replica;")


def reset_sequence(pc, pg, table, col="id"):
    try:
        pc.execute(
            f"SELECT setval(pg_get_serial_sequence('{table}', '{col}'), "
            f"COALESCE((SELECT MAX({col}) FROM {table}), 1))"
        )
        print(f"  {table}.{col} sequence reset")
    except Exception as e:
        print(f"  WARNING resetting {table}: {e}")
        pg.rollback()
        pc.execute("SET session_replication_role = replica;")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not os.path.exists(SQLITE_PATH):
        sys.exit(f"SQLite file not found: {SQLITE_PATH}")

    print(f"Opening SQLite: {SQLITE_PATH}")
    sl = sqlite3.connect(SQLITE_PATH)
    sl.row_factory = sqlite3.Row

    print(f"Connecting to PostgreSQL at {PG_HOST}:{PG_PORT}/{PG_DB} ...")
    pg = psycopg2.connect(
        host=PG_HOST, port=PG_PORT,
        dbname=PG_DB, user=PG_USER, password=PG_PASS,
    )
    pc = pg.cursor()

    # Disable FK checks temporarily
    pc.execute("SET session_replication_role = replica;")

    # Migration order respects FK dependencies
    tables = [
        "app_settings",
        "racks",
        "switch_classes",
        "switch_models",
        "snmp_profiles",
        "credentials",
        "devices",
        "ports",
        "topology_links",
        "scan_runs",
        "scan_run_logs",
        "map_overlays",
    ]

    for table in tables:
        # Check if table exists in SQLite
        exists = sl.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not exists:
            print(f"\n{table}: not in SQLite (skip)")
            continue

        print(f"\n{table}")

        if table == "app_settings":
            rows = [(r["key"], r["value"]) for r in sl.execute("SELECT key, value FROM app_settings")]
            pg_insert(pc, "app_settings", ["key", "value"], rows,
                      conflict="(key) DO UPDATE SET value = EXCLUDED.value")
        else:
            migrate_table(sl, pc, table)

    # -----------------------------------------------------------------------
    # Sequence reset
    # -----------------------------------------------------------------------
    print("\nResetting sequences...")
    for table in ["credentials", "snmp_profiles", "switch_models", "switch_classes",
                  "racks", "devices", "ports", "scan_runs"]:
        reset_sequence(pc, pg, table)

    # Re-enable FK checks
    pc.execute("SET session_replication_role = DEFAULT;")
    pg.commit()

    sl.close()
    pg.close()
    print("\nMigration complete!")


if __name__ == "__main__":
    main()


