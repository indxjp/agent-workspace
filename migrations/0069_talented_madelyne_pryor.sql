ALTER TABLE "files" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_status_valid" CHECK ("files"."status" in ('pending', 'ready'));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_is_ready" CHECK ("files"."kind" <> 'folder' or "files"."status" = 'ready');