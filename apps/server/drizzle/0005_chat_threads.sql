ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_project_unique";
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "title" text DEFAULT '新对话' NOT NULL;
--> statement-breakpoint
UPDATE "chat_threads" AS thread
SET "title" = COALESCE(
	(
		SELECT left(message."text", 28)
		FROM "chat_messages" AS message
		WHERE message."thread_id" = thread."id" AND message."role" = 'user'
		ORDER BY message."sequence" ASC
		LIMIT 1
	),
	'新对话'
);
--> statement-breakpoint
CREATE INDEX "chat_threads_project_updated_idx" ON "chat_threads" USING btree ("project_id","updated_at");
