-- ADR-0065 gives the harness that runs an agent loop its own name, `engine`, because `provider`
-- already means the *model* provider on `runs` and on `model_connections`. Migration 0024 renamed
-- `sessions.claude_session_id` to `sessions.engine_session_id` and added `sessions.engine`,
-- `runs.engine` and `runs.engine_version`. This migration moves the data that the rename leaves
-- behind — the discriminant inside the `agents.policy` JSON document, which no `ALTER TABLE` can
-- reach — and backfills the engine of every session that already has an identity.
--
-- Every statement is idempotent and order-independent with respect to the rows it does not touch,
-- so re-running the migration set against a partially migrated database is safe.
--
-- `runs.engine` is deliberately NOT backfilled. A historic run row never recorded which engine
-- executed it, and writing `claude-agent-sdk` onto it would make a guess indistinguishable from a
-- measurement — the same false-zero mistake `runs.accounting_state` exists to avoid (issue #134).
-- `NULL` reads as "this run predates the column", which is the truth. Stated here so a later reader
-- does not take the omission for an oversight.

-- `agents.policy` is a jsonb document whose discriminant was `provider`. Rewrite the key in place:
-- `- 'provider'` removes the old key and `|| jsonb_build_object(...)` adds the new one, carrying the
-- value across rather than assuming it. Only `claude-agent-sdk` was ever storable there — the
-- column has always been written through `AgentPolicySchema` — so the value needs no mapping table.
--
-- A row that already carries `engine` is left alone, which is what makes this re-runnable. A row
-- carrying NEITHER key is not a policy this schema ever wrote and is left for a reader to find,
-- rather than being given an invented engine.
UPDATE "agents"
SET "policy" = ("policy" - 'provider') || jsonb_build_object('engine', "policy" ->> 'provider')
WHERE "policy" IS NOT NULL
  AND "policy" ? 'provider'
  AND NOT ("policy" ? 'engine');
--> statement-breakpoint
-- Every session that already has an engine session id got it from the only engine this platform
-- has ever run, so its engine is known rather than guessed. A session with no identity yet is left
-- NULL: nothing has pinned it, and #318 is what pins it at first run.
--
-- This is the statement that makes the release's invariant hold:
--   select count(*) from sessions where engine is null and engine_session_id is not null  -- 0
UPDATE "sessions"
SET "engine" = 'claude-agent-sdk'
WHERE "engine" IS NULL
  AND "engine_session_id" IS NOT NULL;
--> statement-breakpoint
-- Migration 0024 added both engine CHECK constraints `NOT VALID`, and this migration validates
-- them. That split does NOT buy a weaker lock or a shorter cutover: drizzle's `migrate()` applies
-- every pending migration in one transaction, so 0024's ACCESS EXCLUSIVE locks are still held
-- while these scans run. What it buys is control over where the scan happens — here, after the
-- backfill above, so it checks the rows this migration wrote — and re-runnability: `VALIDATE` on
-- an already-validated constraint is a no-op (ADR-0069).
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_engine_valid";
--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_engine_valid";
