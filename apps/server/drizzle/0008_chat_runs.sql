CREATE TABLE "chat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "chat_runs_user_message_id_unique" UNIQUE("user_message_id")
);
--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_runs_thread_status_idx" ON "chat_runs" USING btree ("thread_id","status");
--> statement-breakpoint
CREATE INDEX "chat_runs_project_status_idx" ON "chat_runs" USING btree ("project_id","status");
