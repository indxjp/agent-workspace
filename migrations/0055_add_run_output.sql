ALTER TABLE "runs" ADD COLUMN "output_schema" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_output_only_when_completed" CHECK ("runs"."output" is null or "runs"."status" = 'completed');