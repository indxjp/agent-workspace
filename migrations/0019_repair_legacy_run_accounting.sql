-- Before this release, session rows existed without their SDK identity even after they had runs.
-- Fresh launches have always supplied the platform session UUID to Claude, so a run proves the
-- conversation exists under that same identity. Preserve resume behavior across the upgrade.
UPDATE "sessions"
SET "claude_session_id" = "id"
WHERE "claude_session_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "runs"
    WHERE "runs"."session_id" = "sessions"."id"
  );--> statement-breakpoint
-- Migration 0013 conservatively marked every pre-accounting run unavailable, including rows that
-- already had a real price-table version and cost. Those rows were fully priced under the old
-- non-null ledger contract, so restore the state their durable data proves before adding guards.
UPDATE "runs"
SET "accounting_state" = 'complete'
WHERE "accounting_state" = 'unavailable'
  AND "price_table_version" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_price_version_matches_accounting_state" CHECK (("runs"."accounting_state" in ('complete', 'partial')) = ("runs"."price_table_version" is not null));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_unpriced_cost_zero" CHECK ("runs"."accounting_state" in ('complete', 'partial') or "runs"."cost_usd" = 0);
