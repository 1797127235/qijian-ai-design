ALTER TABLE "stored_files" ADD COLUMN "page_count" integer;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "run_id" uuid;
--> statement-breakpoint
CREATE TABLE "chat_message_attachments" (
	"message_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "chat_message_attachments_message_file_unique" UNIQUE("message_id","file_id"),
	CONSTRAINT "chat_message_attachments_message_position_unique" UNIQUE("message_id","position")
);
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_message_attachments_file_idx" ON "chat_message_attachments" USING btree ("file_id");
--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (PARTITION BY "thread_id" ORDER BY "started_at" DESC, "id" DESC) AS rn
	FROM "chat_runs"
	WHERE "status" = 'running'
)
UPDATE "chat_runs"
SET "status" = 'interrupted', "error" = '部署迁移时修复重复运行记录', "finished_at" = now()
FROM ranked
WHERE "chat_runs"."id" = ranked."id" AND ranked.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runs_thread_running_unique" ON "chat_runs" USING btree ("thread_id") WHERE "status" = 'running';
