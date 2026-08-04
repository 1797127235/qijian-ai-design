-- Upgrade foreign keys created by the legacy Alembic schema.
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_project_id_fkey";
--> statement-breakpoint
ALTER TABLE "artifacts"
  ADD CONSTRAINT "artifacts_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "artifact_versions" DROP CONSTRAINT IF EXISTS "artifact_versions_artifact_id_fkey";
--> statement-breakpoint
ALTER TABLE "artifact_versions"
  ADD CONSTRAINT "artifact_versions_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;
