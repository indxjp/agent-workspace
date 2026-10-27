ALTER TABLE "runs" ADD COLUMN "approval_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "continues_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_continues_run_workspace_fk" FOREIGN KEY ("continues_run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_continues_run_id_unique" ON "runs" USING btree ("continues_run_id") WHERE "runs"."continues_run_id" is not null;--> statement-breakpoint
-- Hand edit: the backfill UPDATE below is not drizzle-kit output; it must run before the check. Restore it after any regeneration (ADR-0069).
-- A run paused before this migration waits 24 hours from when it paused, exactly as the
-- decision path computed it from ended_at until now.
UPDATE "runs" SET "approval_deadline_at" = "ended_at" + interval '24 hours' WHERE "status" = 'awaiting_approval';--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_awaiting_approval_has_deadline" CHECK ("runs"."status" <> 'awaiting_approval' or "runs"."approval_deadline_at" is not null);