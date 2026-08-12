ALTER TABLE "chat_runs" ADD COLUMN IF NOT EXISTS "smith_run_id" text;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "trace_root_id" text;
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "trace_parent_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_run_status_idx" ON "agent_jobs" USING btree ("run_id","status");
