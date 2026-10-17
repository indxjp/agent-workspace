# W9-PROJ-125 — A project association narrows an agent's own tool permissions; it never widens them

Status: accepted
Date: 2026-09-11
Decided by: W9-PROJ-125 (implementing agent)
Scope: `apps/web/server/compose/resource-loader.ts`'s merge of `project_files`/`project_mcp_servers`
into a composed run; `POST /api/projects/:id/sessions`

## Context

Issue #125's acceptance criteria and its own card leave two things underspecified enough that an
implementation has to choose a reading:

> Project association cannot broaden agent-level tool permissions or cross workspace boundaries.
> ... Conflicting folder/file access has a documented deterministic result.

and, on the connector half specifically:

> Ensure project connectors cannot expose credentials to an agent/user that lacks authorization.

Neither the issue nor the Wave 9 plan's card names the exact test "the agent's own
permission set" — a per-file capability list does not exist anywhere in this codebase; the only
thing an agent carries that bounds what it may reach is `agents.permissions`
(`AgentPermissions`: `readFiles`, `writeFiles`, `runCommands`, `unrestrictedNetwork` — the same
four booleans `apps/web/server/compose/run-request.ts`'s `toolPolicyFor` already maps onto the
SDK's `disallowedTools`). There is likewise no per-agent, per-connector authorisation narrower
than "the connector has a resolvable credential in this workspace" (`loadConnectors`'s existing
check).

Separately, `apps/web/server/compose/resource-loader.ts`'s `loadFiles` already merges an agent's
own overlapping file/folder grants by depth — the shallowest grant paints its subtree first, and a
deeper, more specific grant repaints its own subtree afterward (see its own tests: "applies
explicit child-folder permissions recursively with the most specific grant winning"). The card
independently asks for two merge rules between a project's grants and an agent's own:

> agent assignment wins over project association for the same file id, the more restrictive access
> mode wins for the same path, and a duplicate folder grant resolves to one grant.

## Decision

**The ceiling for a project's contribution to a run is `agents.permissions`, not a project-specific
authorisation table this task does not build. A project's `readFiles`-gated file/folder
associations are merged into the existing depth-based algorithm ahead of the agent's own grants,
rather than through a second merge algorithm; its `unrestrictedNetwork`-gated connector
associations are unioned with the agent's own and validated by the identical, unchanged,
credential-readiness check `loadConnectors` already applies.**

1. **Files.** `project_files`' ids become `access: 'read'` grants (the only mode a project can ever
   contribute — see
   [W9-PLAN-project-file-grants-are-read-only-in-wave-9](W9-PLAN-project-file-grants-are-read-only-in-wave-9.md)),
   placed **before** the agent's own grants in the array `loadFiles` merges. That function's
   existing shallow-then-deep, stable-order algorithm then does all the work: for the identical id
   in both lists, the agent's own (listed later) wins outright — "agent assignment wins ... for the
   same file id". For a path reached through two different, overlapping grants (a project folder
   and a deeper or shallower agent grant, or vice versa), the deeper/more specific explicit grant
   wins its own subtree — which is "the more restrictive access mode wins for the same path"
   whenever the project's is the deeper grant, and is "the agent's own explicit assignment is not
   silently narrowed by an unrelated project" whenever the agent's is. A duplicate project folder
   grant (two ids that both reach the same path) resolves to one grant because `loadFiles` already
   keys its intermediate maps by path, not by grant. No second merge algorithm was written; the one
   the agent's own assignments already used is reused unchanged.
2. **The ceiling.** If the project has any file association at all and `agentPermissions.readFiles`
   is not `true`, the whole load throws — refusing to compose a run that would hand a project's
   files to an agent whose own tool permissions do not include reading a file at all. Symmetrically,
   a project connector association is refused unless `agentPermissions.unrestrictedNetwork` is
   `true` — an MCP connector is a network egress, and "the agent is not authorised for \[the
   connector's\] credential" is read here as exactly that tool-permission ceiling, because this
   codebase defines no narrower per-agent, per-connector authorisation to check instead. Both
   refusals are thrown `Error`s, in the same style `loadFiles`/`loadConnectors` already use for a
   disappeared or unconfigured resource — a pre-launch failure that blocks composition, not a
   silent drop with a warning attached elsewhere. (Read-write is never at issue for a project file
   grant: it structurally cannot exceed `'read'`, so `writeFiles` gates nothing here.)
3. **Missing/deleted resources.** A `project_files`/`project_mcp_servers` id that no longer resolves
   in the catalog/connector store throws — again, the existing `loadFiles`/`loadConnectors` checks,
   applied to a merged id list without regard to which side an id came from.
4. **Session start.** `POST /api/projects/:id/sessions` with no `sessionId` in the body resolves
   `defaultAgentId` and persists it via `sessions.ensure({ agentId, ... })` in the same statement
   that creates the row. `sessions.agent_id` has no update path
   (`packages/core/src/db/repositories/runs.ts`'s `UpdateSessionInput`, outside this task's Owns
   globs), so "a later edit to the project cannot rewrite history" holds by construction rather
   than by an added guard. An unresolvable `defaultAgentId` (null, or naming an agent no longer in
   this workspace) is refused with `422 project_default_agent_unresolvable` before any session row
   is written.
5. **Moving a session between projects** now authorises against **both** the destination (already
   checked before this task) and the session's current project, if it has one — closing the half
   the card names ("Moving a session between projects requires authorisation on both projects").
   `moveSession` itself only ever writes `sessions.project_id`; it has no path to `agent_id`, so an
   existing run's agent attribution (reached through `runs.session_id` → `sessions.agent_id`, never
   duplicated onto `runs` — see that schema file's own header) cannot be changed by a later move,
   regardless of which project the session belongs to when the move happens.

   **Project attribution is a different story, and verification round 1 (Finding 1) is why this
   paragraph now says so explicitly.** Unlike `agent_id`, `sessions.project_id` is exactly the
   column a move writes — there is no absence to lean on. A run's project is reached only through
   `runs.session_id → sessions.project_id`, so a move that rewrote it out from under a session that
   already has runs would silently change those runs' historical attribution, which is precisely
   what issue #125's acceptance criteria forbid ("Edits after a run do not rewrite the run's
   historical model/project/agent attribution") and what the card's own Verifier attack #3 checks
   for ("move the session to a second project and assert the earlier run's attribution still points
   at the first [project]"). The fix is not a snapshot column — Wave 9.4's migration ownership
   (`W9-RUNS-134` owns `migrations/**` and has already landed a migration on `main`; `pnpm
db:generate` rewrites `migrations/meta/_journal.json` wholesale, so a second task cannot add a
   column without colliding) rules that out here. Instead, `moveSession` queries `runs` for any row
   naming the session **before** it writes `sessions.project_id`, and refuses the move outright —
   `MoveSessionOutcome`'s `'has-runs'` kind, surfaced by the route as `409
project_session_has_runs` — once any run exists. The session simply never moves, so there is
   nothing for a later read to get wrong. A `runs.project_id` snapshot (mirroring the existing
   `runs.model_connection_id` snapshot) remains the more capable fix — it would let a session with
   history still move to a new project for _future_ runs, which this refusal does not allow — and
   is deferred to a later wave's migration owner rather than built here.

## Alternatives considered

**Gate project files/connectors on the agent's own pre-existing `agent_files`/`agent_mcp_servers`
assignment** (i.e. a project can only ever surface something the agent was already assigned
directly). Rejected: it makes a project association contribute nothing a Builder could not already
see by opening the agent directly, which contradicts the issue's own acceptance criterion that
project files/folders and connectors must be "reflected in the composed run" as new, shared
resources — the entire product point of a project.

**A second, path-based merge algorithm for project vs. agent grants**, computed independently and
then combined. Rejected on the simplicity mandate: `loadFiles`'s existing shallow-to-deep merge
already produces the two stated precedence rules for free once project grants are ordered ahead of
the agent's own; a second algorithm would have to reproduce that behaviour to agree with it, for no
capability gained.

**Drop the offending resource and continue composing the rest of the run, reporting the drop as a
warning attached to the run record.** Rejected: the card's own words are "actionable pre-launch
error" for missing/deleted resources and an unresolvable default agent — "pre-launch" reads as
before the run is composed at all, and it is the reading that fails closed rather than launching a
run with a silently smaller resource set than the project's configuration implies.

## Consequences

- No migration, no new table, no new column: the existing `AgentPermissions` on `agents` and the
  existing merge algorithm on `resource-loader.ts` do all of the new narrowing work.
- A workspace that wants an agent to reach project files but not run project connectors (or vice
  versa) needs two agents, one per capability profile — there is no finer-grained "may use project
  files but not project connectors" toggle. That is the same shape of limitation
  `W9-PLAN-project-file-grants-are-read-only-in-wave-9` already accepts for read/write, extended to
  read/none.
- If a future wave adds a genuinely per-connector authorisation narrower than
  `unrestrictedNetwork`, this decision is superseded at exactly the one call site
  (`loadProjectConnectorIds`) and nowhere else — the merge/refusal shape does not change.
- (Verification round 1) A session that has run even once is now permanently parked in its
  project: `POST /api/projects/:id/sessions` with a `sessionId` for such a session always answers
  `409 project_session_has_runs`, forever, not only for the run's own history. A workspace that
  genuinely needs to re-file an already-used session has no route to do it in this wave; the
  `runs.project_id` snapshot column named above is what would let a used session still move for
  its _next_ run while keeping past runs honest, and is the declared gap this refusal stands in
  for until a migration owner builds it.

## Related

- [W9-PLAN-project-file-grants-are-read-only-in-wave-9](W9-PLAN-project-file-grants-are-read-only-in-wave-9.md)
- Issue #117 (W9-AUTH-117) — `agents.permissions` and the ownership model this task authorises
  against.
