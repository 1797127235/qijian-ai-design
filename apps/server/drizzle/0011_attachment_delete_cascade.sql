ALTER TABLE "chat_message_attachments" DROP CONSTRAINT "chat_message_attachments_file_id_stored_files_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE cascade ON UPDATE no action;
