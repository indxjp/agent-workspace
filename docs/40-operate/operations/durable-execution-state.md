# Durable execution state

Run event replay and SDK session transcripts are PostgreSQL-backed. `run_events` assigns a
contiguous per-run sequence under a transaction-scoped advisory lock and retains the newest
50,000 events per run by default. SSE `Last-Event-ID` reconnects read this ordered log; a cursor
older than the retained window receives an explicit `stream-reset` control frame.

`session_transcripts` records transcript existence and modification time. `session_messages` is an
append-only delivery log. Concurrent writers are serialized per transcript key. A repeated SDK
entry UUID is stored as another delivery and folded into the entry's original position at read
time, making provider retries idempotent without whole-transcript rewrites. Deleting a main
transcript cascades to its subagent transcripts and message rows. The tenant-scoped repository also
provides `purgeBefore(cutoff)` for a deployment retention job; no automatic transcript expiry is
enabled by default because the product has not selected a customer retention period.

Run bearer tokens are never stored. `run_tokens` retains the signed token ID, a SHA-256 digest,
expiry, and revocation time. The issuer commits that row before releasing a bearer to the runner.
The gateway checks the row on every authenticated provider request. Individual revocation is
available through the workspace-scoped repository, and every outstanding token is revoked when
its run enters a terminal state.

## Migration and rollback

Apply migrations with `pnpm db:migrate` before starting the web and gateway services. Migration
`0005_durable-sessions-run-tokens.sql` adds only new tables and indexes.

Rollback requires stopping the web, runner, and gateway first. Back up the three new tables, then
drop `session_messages`, `session_transcripts`, and `run_tokens` in that order. Rolling back loses
resume history and token-revocation records, so the signing secret must also be rotated before any
older gateway build is restarted. Reapplying the migration creates empty stores; it does not
reconstruct deleted transcript history.

