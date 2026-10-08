"""Add the network latency monitor storage.

Revision ID: 022
Revises: 021
Create Date: 2026-10-08

- devices.latency_monitored: per-device opt-in used when the latency monitor
  runs in "selected" mode (setting latency_mode).
- latency_samples: per-minute latency rollups written by the latency-monitor
  service (one row per device and minute, unique on device_id + bucket_ts),
  purged after latency_retention_days.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("latency_monitored", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "latency_samples",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "device_id", sa.Integer(),
            sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("bucket_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rtt_avg_ms", sa.Float(), nullable=True),
        sa.Column("rtt_min_ms", sa.Float(), nullable=True),
        sa.Column("rtt_max_ms", sa.Float(), nullable=True),
        sa.Column("jitter_ms", sa.Float(), nullable=True),
        sa.Column("loss_pct", sa.Float(), nullable=False),
        sa.Column("probes", sa.Integer(), nullable=False),
        sa.UniqueConstraint("device_id", "bucket_ts", name="uq_latency_samples_device_bucket"),
    )
    op.create_index("ix_latency_samples_bucket_ts", "latency_samples", ["bucket_ts"])


def downgrade() -> None:
    op.drop_index("ix_latency_samples_bucket_ts", table_name="latency_samples")
    op.drop_table("latency_samples")
    op.drop_column("devices", "latency_monitored")
