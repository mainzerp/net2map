"""Add users table with role-based access.

Revision ID: 006
Revises: 005
"""
import os

import sqlalchemy as sa

from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("username", sa.String, nullable=False, unique=True, index=True),
        sa.Column("email", sa.String, server_default=""),
        sa.Column("hashed_pw", sa.String, nullable=False),
        sa.Column("role", sa.String, server_default="viewer"),
        sa.Column("is_active", sa.Boolean, server_default="true"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    # Seed default admin user
    import bcrypt
    default_pw = os.environ.get("DEFAULT_ADMIN_PASSWORD", "changeme")
    hashed = bcrypt.hashpw(default_pw.encode(), bcrypt.gensalt()).decode()
    op.execute(
        sa.text(
            "INSERT INTO users (username, email, hashed_pw, role, is_active) "
            "VALUES (:username, :email, :hashed_pw, :role, true)"
        ).bindparams(username="admin", email="", hashed_pw=hashed, role="admin")
    )


def downgrade():
    op.drop_table("users")
