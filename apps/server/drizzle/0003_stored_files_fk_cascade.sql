-- The legacy upload table also needs project-level cascade semantics.
ALTER TABLE "stored_files" DROP CONSTRAINT IF EXISTS "stored_files_project_id_fkey";
--> statement-breakpoint
ALTER TABLE "stored_files"
  ADD CONSTRAINT "stored_files_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
