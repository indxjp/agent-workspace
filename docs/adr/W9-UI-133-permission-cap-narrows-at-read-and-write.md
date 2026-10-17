# W9-UI-133 — An agent's own `writeFiles` permission narrows a `'read-write'` grant on every read, not only when the assignment was saved

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-133 (implementing agent), repair round 2
Supersedes: [W9-UI-133-permission-cap-narrows-at-save-not-at-compose](W9-UI-133-permission-cap-narrows-at-save-not-at-compose.md)
Scope: `packages/core/src/db/repositories/agent-resources.ts`'s `get` (`read`) and `replace`, both
inside this task's Owns globs

## Context

The superseded ADR decided to narrow a `'read-write'` grant to `'read'` only inside `replace` — at
write time — on the theory that "narrowing is a property of the request that persisted it", and
recorded as a Consequence that a stale `'read-write'` row surviving a later, independent
`writeFiles: false` change "would only be reachable ... through some other path this task did not
touch (there is none known today)".

That ADR's own "Verification round 1" section already retracted the claim: the stale-row path is
reachable through this task's own shipped `AgentDetailScreen.save()` — grant read-write while
`writeFiles` is on, then a later `PATCH /api/agents/:id` turns `writeFiles` off with no matching
resources `PUT` — and the fix that round shipped moved the ceiling into `read`/`get` as well, so
every reader (`GET /api/agents/:id/resources` and `createAgentRunResourceLoader`, both callers of
this same method) sees the narrowed value regardless of when the row was written.

What round 1 did not do is update the ADR's own title, Decision paragraph and Consequences bullets,
which still describe the pre-fix rule: the title says the cap narrows "when the assignment is
*saved*, not when a run is *composed*"; the Decision says the grant's "intent survives in the UI's
own draft"; Consequences says narrowing "is not a live constraint re-evaluated on every read". None
of those three statements are true of the shipped code — `read`'s own comment
(`packages/core/src/db/repositories/agent-resources.ts:76-89`) and its test
(`agent-resources.test.ts`, "reads a 'read-write' row back as 'read' once the agent's writeFiles
permission is turned off after the row was written, with no further `replace()`") say the opposite.
Verification round 2 named this as a defect: a reader who stops at the top of the superseded ADR
gets the wrong rule.

This ADR is the corrected record. The superseded ADR is left as originally written below its own
"Verification round 1" section — a record of what was decided and why, at the time — rather than
rewritten in place; its `Status:` line now points here.

## Decision

**The write-permission ceiling on an agent's own file grants is enforced at both ends of the same
repository: `replace` (write) narrows what a request persists, and `get` (read) re-derives the same
ceiling from the agent's *current* `permissions` every time a row is read, regardless of what
`writeFiles` was when the row was written.** `GET /api/agents/:id/resources` and
`createAgentRunResourceLoader` (`apps/web/server/compose/resource-loader.ts`, outside this task's
Owns and unedited) both call `AgentResourceRepository.get`, so both see the narrowed value with no
separate ceiling of their own — a composed run and a `GET` response can never disagree, and neither
can ever show a `'read-write'` grant the agent cannot currently exercise.

Concretely, `read` selects `agents.permissions` in the same query that already proves the agent
exists (the same shape `replace` uses), and maps every `'read-write'` `agentFiles` row to `'read'`
when `parseAgentPermissions(...).writeFiles` is `false` — never persisting the narrowed value back,
only ever narrowing what this call returns.

The three passages this ADR corrects, restated:

- **Not** "narrows when the assignment is saved" — it narrows on every read, using whatever
  `permissions` the agent has *right now*, independent of when the `agent_files` row was written.
- **Not** "the grant's intent survives in the UI's own draft" — a stale `'read-write'` row does
  survive in the *database*, but no reader, including the UI's own `GET` on load, is ever shown
  it as `'read-write'` while `writeFiles` is off; the draft the editor resyncs to is already
  narrowed.
- **Not** "not a live constraint re-evaluated on every read" — it is now exactly that: a live
  constraint, re-evaluated on every `get`.

Narrowing on read does not replace narrowing on write: `replace` still must narrow, because it is
also where the unknown-file/unknown-skill/unknown-connector validation and the transactional write
happen, and a `PUT`/`POST` that persisted an unnarrowed value would be lying about what it just
wrote even before the next `get`. The two checks are the same rule (`parseAgentPermissions(...)
.writeFiles ? asIs : narrowed`) applied at the two places `agent_files` rows are produced and
consumed.

## Alternatives considered

- **Narrow only at write, leave stale rows for `get` to return verbatim** — the superseded ADR's
  original decision. Rejected for the reason recorded there once corrected: `get` is the only reader
  the run composer uses, so any caller relying on "narrowed at write" alone is one independent
  permission change away from serving a stale, wider grant to a real run.
- **Narrow only at `read`, drop the check from `replace`** — would still validate correctly against
  malicious ids, but every persisted row would say `'read-write'` even when it can never take effect
  while `writeFiles` stays off, which is the same "dishonest record" problem the superseded ADR's own
  "do nothing" alternative was rejected for.
- **Move the ceiling into `apps/web/server/compose/resource-loader.ts`, leaving the repository as a
  bare passthrough** — rejected for the same reason the superseded ADR rejected it: that file is
  outside this task's Owns globs. Narrowing inside the repository's own `get` reaches every caller of
  it, `resource-loader.ts` included, with no edit outside Owns required.

## Consequences

- `AgentResourceRepository.get` performs the same lookup `replace` already does (agent exists,
  `permissions` selected) before returning file rows — one additional `select` per `get`, on a table
  already read for the same call; no additional round trip beyond what the query already needed for
  `parseAgentPermissions`.
- A `'read-write'` row is never observably wider than the agent's *current* `writeFiles` permission,
  from any caller of `get` — `GET /api/agents/:id/resources`, `createAgentRunResourceLoader`, and any
  future reader that calls through this repository all agree, always, with each other and with what
  a run can actually do.
- The database can still *store* a `'read-write'` value for a folder whose agent currently has
  `writeFiles: false` — narrowing on read does not rewrite the row — but nothing reachable through
  this repository will ever show or act on that wider value while the permission is off; it becomes
  effective again automatically (with no further `PUT`) the moment `writeFiles` is turned back on,
  which is the "narrowed, not refused" property the superseded ADR wanted and did not, before round
  1, actually deliver.
- No declared gap remains from this line of investigation: both the write path and the read path
  (and therefore compose, which only ever reads) apply the identical ceiling.

## Related

- [W9-UI-133-permission-cap-narrows-at-save-not-at-compose](W9-UI-133-permission-cap-narrows-at-save-not-at-compose.md)
  — the superseded record, including its own "Verification round 1" section, which first found the
  gap this ADR's Decision closes.
- [W9-PROJ-125-project-resources-narrow-never-widen](W9-PROJ-125-project-resources-narrow-never-widen.md)
- ADR-0048 (fix a root cause at every site it reaches — the reason both `read` and `replace` apply
  the same check rather than one alone)
