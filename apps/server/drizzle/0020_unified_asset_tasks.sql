CREATE TABLE IF NOT EXISTS "task_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"total" integer NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_summary" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "task_batches_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "batch_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "task_role" text DEFAULT 'image' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "queue_backend" text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "queue_job_id" text;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "payload_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "attempt" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "enqueued_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_batch_id_task_batches_id_fk"
	FOREIGN KEY ("batch_id") REFERENCES "public"."task_batches"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_jobs_queue_identity_unique"
	ON "agent_jobs" ("queue_backend", "queue_job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_batch_status_idx" ON "agent_jobs" ("batch_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_backend_status_idx" ON "agent_jobs" ("queue_backend", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_batches_project_status_idx" ON "task_batches" ("project_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_batches_project_created_idx" ON "task_batches" ("project_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_queue_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL UNIQUE,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"lock_owner" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone,
	CONSTRAINT "task_queue_outbox_task_id_agent_jobs_id_fk"
		FOREIGN KEY ("task_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade,
	CONSTRAINT "task_queue_outbox_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_queue_outbox_dispatch_idx"
	ON "task_queue_outbox" ("status", "available_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_queue_outbox_project_idx" ON "task_queue_outbox" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "generation_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL UNIQUE,
	"project_id" uuid NOT NULL,
	"operation_key" text NOT NULL UNIQUE,
	"status" text DEFAULT 'prepared' NOT NULL,
	"provider_request_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"target_artifact_id" uuid,
	"expected_target_version" integer NOT NULL,
	"result_file_id" uuid,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "generation_operations_task_id_agent_jobs_id_fk"
		FOREIGN KEY ("task_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade,
	CONSTRAINT "generation_operations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade,
	CONSTRAINT "generation_operations_result_file_id_stored_files_id_fk"
		FOREIGN KEY ("result_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_operations_project_status_idx"
	ON "generation_operations" ("project_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_operations_target_idx"
	ON "generation_operations" ("target_artifact_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_key" text NOT NULL UNIQUE,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_events_task_id_agent_jobs_id_fk"
		FOREIGN KEY ("task_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade,
	CONSTRAINT "task_events_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_events_project_id_idx" ON "task_events" ("project_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_events_task_id_idx" ON "task_events" ("task_id", "id");
