-- Issue #613: `agents.materialised_version_id` records the version the agent row was last written
-- from, so "edited since the pointer moved" is `materialised_version_id IS DISTINCT FROM
-- pointer.version_id` instead of the `agents.updated_at <= agent_version_pointers.updated_at`
-- timestamp proxy.
--
-- Additive and nullable, so no single-revision cutover is needed (ADR-0069): a revision that
-- predates this column ignores it. During a rollout, an old revision that still serves a legacy
-- `PATCH` does not clear the column, so `aw dev` misses that one edit until the agent is edited
-- again. The result is the overwrite `aw push` already does by default.
--
-- ON DELETE is NO ACTION: a version is only deleted by its agent's cascade, which removes the
-- referencing row in the same statement. MATCH SIMPLE leaves NULL unchecked.
ALTER TABLE "agents" ADD COLUMN "materialised_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_materialised_version_fk" FOREIGN KEY ("materialised_version_id","id","workspace_id") REFERENCES "public"."agent_versions"("id","agent_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The backfill uses the old proxy one last time, so no existing agent reads as edited on upgrade:
-- an agent whose row was not written after its `local` pointer moved still equals that version.
UPDATE "agents" AS a
SET "materialised_version_id" = p."version_id"
FROM "agent_version_pointers" AS p
WHERE p."agent_id" = a."id"
  AND p."workspace_id" = a."workspace_id"
  AND p."environment" = 'local'
  AND a."updated_at" <= p."updated_at";
