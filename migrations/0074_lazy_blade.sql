ALTER TABLE "skills" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "pending_delete" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "builtin_digest" text;