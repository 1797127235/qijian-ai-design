CREATE TABLE IF NOT EXISTS "image_captions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_captions" ADD CONSTRAINT "image_captions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "image_captions" ADD CONSTRAINT "image_captions_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "image_captions_identity_unique" ON "image_captions" USING btree ("project_id","file_id","content_hash","analyzer_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_captions_project_file_idx" ON "image_captions" USING btree ("project_id","file_id");
