ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "cover_file_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "cover_revision" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_cover_file_id_stored_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE no action;
