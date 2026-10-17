-- Issue #799: an evaluation run is a row that is `running` until every case has a result, then
-- `completed`; `lease_until` keeps one request advancing it at a time. Additive: every existing row,
-- and every row an older revision inserts, is `completed`, which is what the promotion gate reads.
ALTER TABLE "agent_version_evaluations" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_version_evaluations" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_version_evaluations" ADD CONSTRAINT "agent_version_evaluations_status_valid" CHECK ("agent_version_evaluations"."status" in ('running', 'completed'));