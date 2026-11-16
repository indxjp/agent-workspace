ALTER TABLE "runs" ADD COLUMN "spend_ceiling_usd" numeric(14, 6);--> statement-breakpoint
-- safe: spend_ceiling_usd was added NULL above and the CHECK passes NULL, so every existing row satisfies it
ALTER TABLE "runs" ADD CONSTRAINT "runs_spend_ceiling_positive" CHECK ("runs"."spend_ceiling_usd" is null or "runs"."spend_ceiling_usd" > 0);