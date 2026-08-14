ALTER TABLE "agent_jobs" ADD COLUMN "trace_context" jsonb;--> statement-breakpoint
ALTER TABLE "agent_jobs" DROP COLUMN "trace_root_id";--> statement-breakpoint
ALTER TABLE "agent_jobs" DROP COLUMN "trace_parent_id";