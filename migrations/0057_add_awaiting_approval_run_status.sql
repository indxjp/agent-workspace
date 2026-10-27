-- P5-2 (#1299, ADR-0145 D1): `awaiting_approval` joins the run statuses, with the call it waits on
-- (`pending_approval`) and the calls a continuation may make (`approved_tool_calls`).
-- Additive: both checks are widened, never narrowed, the new check only constrains the new status, and
-- the previous revision never writes `awaiting_approval` and ignores the two new columns, so no
-- single-revision cutover is needed (ADR-0069's rule applies to incompatible changes).
ALTER TABLE "runs" DROP CONSTRAINT "runs_status_valid";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_ended_at_iff_terminal";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pending_approval" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "approved_tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_awaiting_approval_has_pending" CHECK ("runs"."status" <> 'awaiting_approval' or "runs"."pending_approval" is not null);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_valid" CHECK ("runs"."status" in ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ended_at_iff_terminal" CHECK (("runs"."status" in ('completed', 'failed', 'cancelled', 'awaiting_approval')) = ("runs"."ended_at" is not null));
