ALTER TABLE "sessions" RENAME COLUMN "claude_session_id" TO "engine_session_id";--> statement-breakpoint
DROP INDEX "sessions_workspace_claude_session_key";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "engine" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_workspace_engine_session_key" ON "sessions" USING btree ("workspace_id","engine_session_id");--> statement-breakpoint
-- Hand edit: both `NOT VALID` clauses below are not drizzle-kit output; restore them after any regeneration (ADR-0069).
ALTER TABLE "runs" ADD CONSTRAINT "runs_engine_valid" CHECK ("runs"."engine" in ('claude-agent-sdk')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_engine_valid" CHECK ("sessions"."engine" in ('claude-agent-sdk')) NOT VALID;