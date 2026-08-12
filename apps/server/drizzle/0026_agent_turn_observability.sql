CREATE TABLE "chat_model_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "chat_model_turns_run_turn_unique" UNIQUE("run_id","turn_index")
);
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "turn_index" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "argument_characters" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "argument_bytes" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "result_characters" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "result_bytes" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "prompt_tokens_before" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "prompt_tokens_after" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "prompt_token_delta" integer;
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" ADD COLUMN "shared_batch_size" integer;
--> statement-breakpoint
ALTER TABLE "chat_model_turns" ADD CONSTRAINT "chat_model_turns_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_model_turns_run_idx" ON "chat_model_turns" USING btree ("run_id","turn_index");
--> statement-breakpoint
ALTER TABLE "chat_tool_calls" DROP COLUMN "cost";
