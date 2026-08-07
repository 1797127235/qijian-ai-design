CREATE TABLE IF NOT EXISTS "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"artifact_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_project_status_idx" ON "agent_jobs" USING btree ("project_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_project_created_idx" ON "agent_jobs" USING btree ("project_id","created_at");
