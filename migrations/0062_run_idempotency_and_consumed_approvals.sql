ALTER TABLE "runs" ADD COLUMN "approvals_consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "idempotency_request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_workspace_idempotency_key_unique" ON "runs" USING btree ("workspace_id","idempotency_key") WHERE "runs"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_consumed_approvals_never_queued" CHECK ("runs"."approvals_consumed_at" is null or "runs"."status" <> 'queued');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_idempotency_key_has_hash" CHECK (("runs"."idempotency_key" is null) = ("runs"."idempotency_request_hash" is null));