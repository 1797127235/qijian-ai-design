-- SQLAlchemy generated UUIDs in application code; the TS backend relies on database defaults.
ALTER TABLE "projects" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "artifact_versions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "stored_files" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
