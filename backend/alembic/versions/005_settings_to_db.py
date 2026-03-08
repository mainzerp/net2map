"""Move scan/DNS/map settings from JSON files into app_settings DB table.

Revision ID: 005
Revises: 004
Create Date: 2025-07-25

"""
from typing import Sequence, Union

from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO app_settings (key, value) VALUES
            ('scan_max_workers',  '4'),
            ('scan_snmp_timeout', '3'),
            ('scan_snmp_retries', '1'),
            ('dns_servers',       '[]'),
            ('map_opacity',       '0.3'),
            ('map_scale',         '1.0'),
            ('map_bg_color',      '#020817')
        ON CONFLICT (key) DO NOTHING
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM app_settings WHERE key IN (
            'scan_max_workers', 'scan_snmp_timeout', 'scan_snmp_retries',
            'dns_servers',
            'map_opacity', 'map_scale', 'map_bg_color'
        )
    """)
