-- This migration supports both a fresh database and the previous Alembic schema.
DROP TABLE IF EXISTS "ai_tasks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "canvas_layouts" CASCADE;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "permission" text DEFAULT 'ask' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "permission" text DEFAULT 'ask' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "owner_id" CASCADE;
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "project_type";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "area_sqm";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "artifact_type" text NOT NULL,
  "current_version_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "version_no" integer NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "payload" jsonb NOT NULL,
  "input_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" text NOT NULL,
  "change_reason" text,
  "content_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "artifact_versions_number_unique" UNIQUE("artifact_id", "version_no")
);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'artifact_versions' AND column_name = 'version'
  ) THEN
    ALTER TABLE "artifact_versions" RENAME COLUMN "version" TO "version_no";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
UPDATE "artifact_versions" SET "created_by" = 'designer' WHERE "created_by" IS NULL;
--> statement-breakpoint
ALTER TABLE "artifact_versions" ALTER COLUMN "created_by" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifact_versions" DROP COLUMN IF EXISTS "created_by_id" CASCADE;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "desk_state" (
  "project_id" uuid PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "viewport" jsonb DEFAULT '{"x":40,"y":20,"zoom":0.62}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "desk_state" ("project_id") SELECT "id" FROM "projects" ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stored_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "original_filename" text NOT NULL,
  "media_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_hash" text NOT NULL,
  "object_key" text NOT NULL UNIQUE,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stored_files" DROP COLUMN IF EXISTS "uploaded_by_id" CASCADE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "artifact_versions_artifact_idx" ON "artifact_versions" ("artifact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_project_idx" ON "artifacts" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_type_idx" ON "artifacts" ("artifact_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stored_files_project_idx" ON "stored_files" ("project_id");
--> statement-breakpoint
DROP TABLE IF EXISTS "designers" CASCADE;
