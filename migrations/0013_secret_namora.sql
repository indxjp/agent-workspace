ALTER TABLE "run_usage_records" ALTER COLUMN "price_table_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "accounting_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "accounting_error" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_accounting_state_valid" CHECK ("runs"."accounting_state" in ('pending', 'complete', 'partial', 'failed', 'unavailable'));--> statement-breakpoint
-- Backfill only: at this point in the migration no row can have been inserted under the new
-- 'pending' default yet, so every row this UPDATE reaches predates issue #134's settlement path.
-- They were never durably settled by it, and defaulting them to 'complete' would be exactly the
-- false zero this column exists to remove — 'unavailable' says the accounting is unknown, not good.
UPDATE "runs" SET "accounting_state" = 'unavailable';