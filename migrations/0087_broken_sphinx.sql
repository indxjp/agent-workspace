ALTER TABLE "audit_events" ADD COLUMN "details" jsonb;--> statement-breakpoint
-- safe: the column is new and NULL on every existing row, so the CHECK holds for all of them
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_details_only_agent_created" CHECK ("audit_events"."details" is null or "audit_events"."action" = 'agent-created');