ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "display_name_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "display_name_generation_token" text;
