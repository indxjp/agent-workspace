# W2-DB-02 — A run row needs a session row, so this task persists three columns of one and no more

Status: accepted
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence)
Scope: `packages/core/src/db/repositories/runs.ts`, `apps/web/instrumentation.ts`; boundary with W2-CP-07

## D1 amendment

`openSession` now resumes an owned active session when a caller supplies its ID. The refusal of
every requested session ID described below was an earlier implementation stage. The current
`SessionRepository` has more than the initial two methods and three columns recorded here; its
schema and repository source are the current shape.

## Context

`runs.session_id` is `NOT NULL` and is tenant-paired, from `migrations/0000_init.sql`:

```sql
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_workspace_fk"
  FOREIGN KEY ("session_id","workspace_id")
  REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade;
```

Wave 1's composition root minted a session id per run and stored nothing — its own comment says the
`sessions` table exists and nothing in `apps/web` reads it. Against a `Map` that is fine. Against
that foreign key it is an insert that cannot succeed: converting runs to PostgreSQL is impossible
without a `sessions` row.

`sessions` in turn requires an `agents` row in the same workspace (`sessions_agent_workspace_fk`)
and a `memberships` row joining the user to it (`sessions_member_workspace_fk`).

Sessions are **W2-CP-07's task**. Its brief in the Wave 2 plan is a durable `SessionStore`
persisting *"session state, not only the session id"*, with the §14.9 release-blocker acceptance:
kill the runtime mid-session, start a fresh one, resume, and the conversation continues. It owns
`apps/web/server/sessions/**`, `apps/web/app/api/sessions/**` and `apps/runner/src/session.ts`.

## Decision

**This task creates the row and stops there.** `SessionRepository` has two methods, `ensure` and
`get`, over three columns — workspace (from the scope), agent, user. No state, no title, no
`claude_session_id`, no resume, no list, no archive.

The line is drawn where the foreign key is: what `runs` demands is that the row exist, and that is
what is built. Everything a *conversation* needs is W2-CP-07's, and none of this task's files are
in W2-CP-07's globs — `packages/core/src/db/repositories/runs.ts` and `apps/web/instrumentation.ts`
are both this task's, declared in the Wave 2 plan.

`openSession` in the composition root therefore still **refuses** a requested session id and answers
`null`, exactly as in Wave 1, because this deployment still cannot answer "does that session belong
to this agent, and what was said in it?" — and §19.5 rule 4 makes a wrong answer a silently forked
conversation.

## Alternatives considered

* **Wait for W2-CP-07 and leave runs in memory.** Rejected: it would make ADR-0024 §2 — convert the
  two subsystems that already have callers and tests — unachievable for one of the two, and the
  6 tracks of sub-wave 2b would receive a run pattern that had never been run against a database.
* **Build the full session store here.** Rejected: it is another task's whole brief, including its
  release-blocking acceptance criterion, and two tasks building one subsystem in parallel is the
  collision the Wave 2 plan exists to prevent.
* **Drop `runs.session_id` to nullable.** Rejected outright: it is a schema change in W2-DB-01's
  glob, and it would delete the constraint that makes a run's workspace and its session's workspace
  the same value (spec §25).

## Consequences

* A `sessions` row is created per run, with `claude_session_id` and `title` left NULL — which is
  what the schema file's own header says those NULLs mean: "no Claude session was ever created".
* W2-CP-07 inherits a repository primitive rather than an empty table, and a
  `EnsureSessionOutcome` that already distinguishes `created` from `existing`, which is the
  distinction a resume path needs.
* If W2-CP-07 replaces `SessionRepository` outright, nothing here objects: `instrumentation.ts` is
  the only caller, and it is one call.
