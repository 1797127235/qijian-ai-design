CREATE TABLE "chat_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"cost" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "chat_tool_calls_run_call_unique" UNIQUE("run_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_tool_calls_run_status_idx" ON "chat_tool_calls" USING btree ("run_id","status");
