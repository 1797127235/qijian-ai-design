"""Add durable AI generation tasks.

Revision ID: 0002_ai_tasks
Revises: 0001_initial_schema
Create Date: 2026-08-03 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0002_ai_tasks"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("task_type", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("input_artifact_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("output_artifact_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("provider", sa.String(length=80), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["input_artifact_version_id"], ["artifact_versions.id"]),
        sa.ForeignKeyConstraint(["output_artifact_id"], ["artifacts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_tasks_project_id", "ai_tasks", ["project_id"], unique=False)
    op.create_index("ix_ai_tasks_task_type", "ai_tasks", ["task_type"], unique=False)
    op.create_index("ix_ai_tasks_status", "ai_tasks", ["status"], unique=False)


def downgrade() -> None:
    op.drop_table("ai_tasks")
