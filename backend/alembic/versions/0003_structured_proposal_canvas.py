"""Add mutable layout storage for structured proposal canvases.

Revision ID: 0003_structured_proposal_canvas
Revises: 0002_ai_tasks
Create Date: 2026-08-03 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0003_structured_proposal_canvas"
down_revision = "0002_ai_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "canvas_layouts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("proposal_canvas_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["proposal_canvas_id"], ["artifacts.id"]),
        sa.ForeignKeyConstraint(["updated_by_id"], ["designers.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("proposal_canvas_id"),
    )
    op.create_index("ix_canvas_layouts_project_id", "canvas_layouts", ["project_id"], unique=False)
    op.create_index("ix_canvas_layouts_proposal_canvas_id", "canvas_layouts", ["proposal_canvas_id"], unique=False)


def downgrade() -> None:
    op.drop_table("canvas_layouts")
