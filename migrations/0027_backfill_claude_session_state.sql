-- ENG-06 (#305): move every existing Claude transcript into the engine-scoped session store that
-- migration 0026 created, so a session that existed before the upgrade resumes after it with its
-- full history. ADR-0071 records the shape; this file is the data half of it.
--
-- **A single-revision cutover** (ADR-0071, in the sense of `docs/adr/0069-*`). The schema is
-- additive — `session_transcripts` and `session_messages` are left exactly as they are — but this
-- copy is ONE-SHOT: it moves what the legacy tables hold when `migrate` runs, and nothing copies
-- anything after that. A previous-release revision still serving during a rolling update keeps
-- appending to the legacy tables, and those turns would be missing from every later resume. So the
-- old revision is drained, or scaled to zero, before the new one starts and migrates; rollback is
-- restoring the pre-upgrade backup. Every `docs/deploy/*` guide carries the step. Removing the old
-- pair is the contract half, and it is a later unit's work, not this one's.
--
-- Every statement is idempotent: re-running the migration set against a partially migrated
-- database inserts nothing a previous run already inserted, so a retry is safe.
--
-- `session_transcripts.session_id` holds the id the ENGINE reported, and for a Claude session that
-- is the platform's own `sessions.id` — the platform passes `sessions.id` as `Options.sessionId`,
-- which is also why `session_transcripts_session_workspace_fk` has always held. The new tables key
-- on `sessions.id` deliberately (no other engine promises the two are equal), so the copy carries
-- `session_id` across unchanged and the existing foreign key is the evidence that it resolves.

-- One stream per old transcript key. `stream_key` is `project_key || '/' || subpath`, which is the
-- Claude adapter's own key rendered into the one field the platform promises not to interpret —
-- the main transcript's `subpath` is the empty string, so its stream key ends in a bare `/`.
INSERT INTO "session_state_streams" ("workspace_id", "session_id", "engine", "stream_key", "created_at", "updated_at")
SELECT "workspace_id", "session_id", 'claude-agent-sdk', "project_key" || '/' || "subpath", "created_at", "updated_at"
FROM "session_transcripts"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The entries, folded the way `load()` already folded them.
--
-- `session_messages` is append-only: a redelivered entry got a NEW `sequence` and kept its
-- `position`, and a read folded the LATEST delivery into the FIRST position. The new store holds one
-- row per entry instead, so the fold happens here, once, rather than on every read:
--
--   * `latest` picks the highest-`sequence` delivery of each `position` — the entry as the last
--     delivery left it, which is exactly what `load()` returned;
--   * `dense_rank()` over `position` renumbers the survivors from 1 with no gaps, because the new
--     store's `sequence` is dense within a stream and `replace-all`/`delete-last` depend on it;
--   * `entry_uuid` becomes `entry_key`, NULL and all: an entry the SDK gave no uuid has no
--     identity to dedup on (R-01 §7), and inventing one here would be an idempotency claim about
--     an entry that has none.
--
-- ORDER BY inside `dense_rank()` is `position` alone: `position` is a first-delivery sequence, so it
-- is already unique per key and already the order `load()` produced.
INSERT INTO "session_state_entries" ("workspace_id", "session_id", "engine", "stream_key", "sequence", "entry_key", "entry", "created_at")
SELECT
  "latest"."workspace_id",
  "latest"."session_id",
  'claude-agent-sdk',
  "latest"."project_key" || '/' || "latest"."subpath",
  dense_rank() OVER (
    PARTITION BY "latest"."workspace_id", "latest"."session_id", "latest"."project_key", "latest"."subpath"
    ORDER BY "latest"."position"
  ),
  "latest"."entry_uuid",
  "latest"."entry",
  "latest"."created_at"
FROM (
  SELECT DISTINCT ON ("workspace_id", "project_key", "session_id", "subpath", "position")
    "workspace_id", "project_key", "session_id", "subpath", "position", "entry_uuid", "entry", "created_at"
  FROM "session_messages"
  ORDER BY "workspace_id", "project_key", "session_id", "subpath", "position", "sequence" DESC
) AS "latest"
ON CONFLICT DO NOTHING;
