-- Issue #615 (80-08): `agent_pointer_moves` is every version an environment has pointed at. The
-- repository appends one row in the transaction that moves a pointer, so the newest row of an
-- (agent, environment) is its pointer and a rollback is the row before it.
--
-- Additive, so no single-revision cutover is needed (ADR-0069). During a rollout an old revision
-- still moves pointers without a row, so a history head can lag its pointer until the next move;
-- a rollback in that window steps back from the last recorded move.
CREATE TABLE "agent_pointer_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"version_id" uuid NOT NULL,
	"moved_by" uuid,
	"moved_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "agent_pointer_moves_environment_valid" CHECK ("agent_pointer_moves"."environment" in ('local', 'production')),
	CONSTRAINT "agent_pointer_moves_reason_valid" CHECK ("agent_pointer_moves"."reason" in ('set', 'promote', 'rollback'))
);
--> statement-breakpoint
ALTER TABLE "agent_pointer_moves" ADD CONSTRAINT "agent_pointer_moves_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pointer_moves" ADD CONSTRAINT "agent_pointer_moves_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pointer_moves" ADD CONSTRAINT "agent_pointer_moves_version_fk" FOREIGN KEY ("version_id","agent_id","workspace_id") REFERENCES "public"."agent_versions"("id","agent_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pointer_moves" ADD CONSTRAINT "agent_pointer_moves_moved_by_principal_workspace_fk" FOREIGN KEY ("workspace_id","moved_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_pointer_moves_workspace_agent_environment_idx" ON "agent_pointer_moves" USING btree ("workspace_id","agent_id","environment","moved_at");--> statement-breakpoint
-- The backfill gives every existing pointer one `set` row, so each head equals its pointer from the
-- start. `moved_by` is NULL: the pointer row never recorded who moved it.
INSERT INTO "agent_pointer_moves" ("workspace_id", "agent_id", "environment", "version_id", "moved_by", "moved_at", "reason")
SELECT p."workspace_id", p."agent_id", p."environment", p."version_id", NULL, p."updated_at", 'set'
FROM "agent_version_pointers" AS p;
