DROP TABLE IF EXISTS "memory_outcomes" CASCADE;
DROP TABLE IF EXISTS "memory_retrieval_traces" CASCADE;
DROP TABLE IF EXISTS "memory_conflicts" CASCADE;
DROP TABLE IF EXISTS "memory_versions" CASCADE;
DROP TABLE IF EXISTS "memory_items" CASCADE;
DROP TABLE IF EXISTS "memory_proposals" CASCADE;
DROP TABLE IF EXISTS "memory_events" CASCADE;
DROP TABLE IF EXISTS "memory_checkpoints" CASCADE;

CREATE TABLE IF NOT EXISTS "project_memories" (
	"project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"revision" integer DEFAULT 0 NOT NULL,
	"entries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compiled_context" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
