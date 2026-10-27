# ADR-0145 — A run stops for approval or handoff, and continues in its session

Status: accepted
Date: 2026-10-18
Decided by: the Owner (issue #1297, approved 2026-10-18; tracker #1273)
Scope: `packages/contracts/src/runs.ts`, `packages/contracts/src/agents/tool-rules.ts`, `packages/contracts/src/run-events.ts`, `packages/contracts/src/observability.ts`, `packages/core/src/db/repositories/runs.ts`, the run routes and RBAC cells in `apps/web`, `packages/engine-claude-agent-sdk`, ADR-0065 D9, ADR-0108 D30

## Context

Three records put off the same feature, each because no run could pause:

- [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) D9 lists "Interactive
  approvals (HITL) through the API" and "Handoffs … as platform concepts" as non-goals, each needing
  "its own record if it is ever wanted". Claude runs with static allow and deny lists.
- [ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md) D30
  (an action that writes always asks the end user to confirm) is deferred because "no run can pause
  today, and openai-agents refuses approvals (ADR-0065 D9)". `aw dev` warns that MCP write tools run
  without confirmation until then.
- The refactoring plan
  ([claude-agent-workspace-refactoring-plan.md](../architecture/refactoring/claude-agent-workspace-refactoring-plan.md),
  the row on an optional `waiting/suspended` run) says not to persist such a state "until a runtime
  feature requires it".

This record is that feature. It is a decision record only: no contract, status, table, route or
engine changes with it. Those belong to the units P5-1 … P5-6 (#1298–#1303), and this record is what
they are checked against.

A run today is `queued`, `running` or one of three terminal statuses (`RUN_STATUSES` in
`packages/contracts/src/runs.ts`). The repository refuses a new run in a session with `session-busy`
while any run of that session has a status outside the terminal set
(`packages/core/src/db/repositories/runs.ts`). A run owns a sandbox runtime, a gateway token and a
usage ledger entry for as long as it is live, and ADR-0065 D8 pins a session to one engine because
engine-native session state is opaque to the platform.

## Decision

### D1 — A run stops and later continues; it never waits

When a run reaches a gated tool call it **ends**: its runtime is stopped, its gateway tokens are
revoked, the sandbox is released, and its usage is settled at the gateway (ADR-0065 D6 is
unchanged). It ends in a new status, `awaiting_approval`.

`awaiting_approval` is **finished for the runtime and for the session-busy rule**. No process waits,
no token stays valid and no lease is held while a person decides, so the session is free and the
continuation run of D2 can be inserted. P5-1 adds the status to `RUN_STATUSES` and puts it in the set
the busy check treats as finished. It is not a live state.

### D2 — The decision route answers with a continuation run

`POST /api/runs/:id/approval` takes the strict body
`{ decision: 'approve' | 'reject', comment?: string }` (unknown keys are refused) and answers
**202** with a continuation run **in the same session**, on the same engine (ADR-0065 D8). The
continuation resumes the engine-native session state with the decision, and the comment if any, as
its input. Both decisions continue the session, so the agent can answer a rejection.

Deciding needs a session, RBAC permission on the run's project, and a repository scope that selects
the run's tenant, each checked as its own step: none stands in for another. The error codes and how a
decided run is stored are left to P5-1 and the route's declaration test, within the sub-rules below.

#### D2.1 — Binding: one approval covers one canonical tool call

An approval covers **exactly one tool call**: the tool name plus a canonical serialisation of its
exact arguments (RFC 8785 JSON canonicalisation, kept with its SHA-256 digest in the request). It is
bound to its run and its session, and it is **single-use**. The engine executes only the call whose
canonical form matches the approved one. A call that differs in any way is refused with
`approval_call_mismatch`, and a second use of a consumed approval is refused with
`approval_already_used`. A refused call is not executed and reaches the model as a tool error.

#### D2.2 — Who may approve

- **Permission.** Deciding is part of running, the same verb as `POST /api/runs/:id/interrupt`: the
  RBAC cell is `{ resource: 'runs', operation: 'run', sub: 'approval' }`, and the own-or-other-run
  split of the run routes applies unchanged. No new role is added.
- **The requester may approve their own request.** The confirmation exists to protect the person
  who asked for the action (ADR-0108 D30). Separation of duties, multi-approver chains and
  `ProjectPolicy.approval` are not built (D6).
- **An anonymous surface end user may confirm, under ADR-0108 D30,** with a session-scope token
  only, and only for a run of **that token's own session**. The cell joins the session scope's grammar
  beside `feedback`; the run-scope grammar does not get it. The run-belongs-to-session check is a row
  fact, made where the run is read, as for feedback. No other scope (`a2a-agent`, `mcp-project`) may
  decide.

#### D2.3 — The decision is a compare-and-set

The first decision is recorded by a **conditional update** (`awaiting_approval` and still pending →
decided) in the same transaction that inserts the continuation run. Exactly one continuation starts.
Any other decision on the same run answers **409** with a stable code: a second decision, a late
decision after expiry (D2.4) or cancellation (D2.5), and a decision on a run that is not
`awaiting_approval`. The busy check does not serialise two concurrent decisions, since
`awaiting_approval` is not session-busy (D1); this update does.

#### D2.4 — A pending approval expires after 24 hours

A pending request expires **24 hours** after it was created. The number is fixed in v1; a per-project
setting is not built (D6). On expiry the request is **rejected**, the run ends `cancelled` with the
reason `approval_expired`, no continuation starts, and the tool call is never executed. A decision
after that answers 409 (D2.3). Expiry is recorded when first observed, by a periodic sweep or by a
late decision that finds the request expired, whichever comes first; the conditional update of D2.3
makes it happen once.

#### D2.5 — Cancelling a paused run

Interrupting an `awaiting_approval` run (`POST /api/runs/:id/interrupt`) makes it `cancelled`, which
is terminal, and **voids** the request. A decision after that answers 409 (D2.3). The interrupt route
accepts an `awaiting_approval` run, which it refuses today only because it is not live.

#### D2.6 — Audit

The audit trail (`AUDIT_ACTIONS` in `packages/contracts/src/observability.ts`) gains four actions,
with the run as the subject: `approval-requested` (the run reached the gated call), `approval-approved`
and `approval-rejected` (who decided, and when, as the row's actor and time), and `approval-expired`
(actor: the system). An audit row has no free-form metadata (a secret would end up in it), so the
decision is two actions rather than one with a field, and the tool arguments are not recorded.

### D3 — The Claude arm declares which tools need approval

`engine.requireApproval: GrantingToolRule[]` sits beside `autoApprove` on the `claude-agent-sdk` arm
and uses the same rule grammar. A tool that matches both lists is refused when the agent is saved; it
is never resolved silently in either direction. "Matches" reads rules the way Claude Code does: an
`Edit` / `Edit(path)` auto-approval matches a gate on any of `Edit`, `Write`, `MultiEdit` and
`NotebookEdit`, because Claude Code checks every file write against `Edit` rules.

A gated run must not be settled before `canUseTool` by anything the workspace carries. The
`project` setting source stays on (skills and `CLAUDE.md` load through it), so a gated run starts
with flag-tier settings that make every gate an `ask` rule, which precedes every allow rule
including the workspace's `.claude/settings.json` `permissions.allow`, and set `disableAllHooks`,
because a settings hook's `allow` is not documented to yield to an `ask` rule. The flag tier
outranks project settings, so the workspace cannot undo either. A gated run therefore runs none of
the workspace's hooks; an ungated run is unchanged.

A rule may only name a tool the Claude Agent SDK sends through `canUseTool` in `permissionMode:
'default'`: `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, or a
connector tool named exactly (`mcp__<server>__<tool>`) or as a whole server (`mcp__<server>__*`);
a partial connector glob such as `mcp__github__*_issue` or `mcp__gh__x?y` is refused at save and at
compile, because Claude Code's permission rules match a connector tool only in those two forms, so
the `ask` rule a gate compiles to would never match and a workspace allow rule would win. The SDK runs its read-only tools (`Read`, `Glob`, `Grep`, …) without
asking, so a gate on one would be accepted and never honoured; the adapter refuses any other name
with `engine_policy_invalid`. The list is an allowlist so a tool a later SDK adds fails closed.

A call that matches `requireApproval` creates the request that D2.1–D2.6 govern: its canonical form
is what the approval is bound to, and nothing else is approved by it.

`ProjectPolicy.approval` stays `notBuilt` ([ADR-0102](0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md)).
A project-wide approval ceiling is a different decision and is not made here.

### D4 — A handoff is a platform tool that ends the run

A platform tool `handoff_to_person({ reason })` emits the neutral frame `agent.handoff` and ends the
run. It is offered to the model only when the agent opts in with `engine.handoff: true`. A handoff
has no approve or reject decision, so the run ends `completed`, with `agent.handoff` as its last
frame, and the session continues with an ordinary next prompt. The decision route does not apply to
it.

Both new frames, `agent.handoff` and the request for approval, join the neutral vocabulary in
`packages/contracts/src/run-events.ts`. Their payloads are fixed by P5-1.

### D5 — Only the Claude arm honours this in v1

Every other engine keeps refusing `approvals` by name with `engine_capability_unsupported`
(ADR-0065 D3, refuse and never drop), and `handoff` is refused the same way. Nothing is silently
ignored.

### D6 — Not built

- A live in-run wait of any kind.
- A workflow engine, multi-approver chains, or separation of duties between requester and approver.
- A per-project approval expiry; the 24 hours of D2.4 is fixed.
- Approvals on non-Claude engines.
- `ProjectPolicy.approval`.

## Consequences

- ADR-0065 D9 is amended: its first two bullets are lifted in the shape above, and the other three
  (vendor-hosted tools, publishing `packages/engine`, switching an existing session's engine) stand.
- ADR-0108 D30 is decided again. Confirmation on writes is built on D1–D3 by the write-confirmation
  units, and the `aw dev` warning stays until they land.
- The refactoring-plan row on `waiting/suspended` is met: a runtime feature now requires the state.
- An unanswered request expires after 24 hours (D2.4). Because `awaiting_approval` is not
  session-busy (D1), an unanswered request never blocks the session.
- The formal model (`tests/formal/contracts-runs.test.ts`, `docs/formal/domains/d1-runs.md`) changes
  with the code that changes `RUN_STATUSES`, not before it.
- No TypeScript changes with this record.

## Amendment (issue #1569) — Evals of gated agents

An evaluation (ADR-0143's case files, `agents.evaluate`) starts a run on a fresh session from one
prompt, so a case that reaches a gated call ends at D1's pause. Without a rule, the case fails
`run_awaiting_approval` and its `expect` is never read. The rules:

- An evaluation never approves. Approving would run the write against a real system, and a case has
  no second turn to approve in.
- A case may end at the pause and be scored there. `expect.awaitsApproval: true` makes
  `awaiting_approval` pass the status check. The other checks then read what the run did up to the
  pause: `tool` and `toolInput` also match the paused call (`pendingApproval`), and `contains`,
  `notContains` and `judge` read the answer so far. `output` is refused with it at the schema: a
  paused run has no structured output yet.
- A case with the flag whose run completes without pausing fails `run_not_awaiting_approval`: the
  gate is the point of the case. Without the flag nothing changes, and a pause fails
  `run_awaiting_approval`.
- After scoring, the runner cancels the paused run as D2.5 does, so nothing is written and no request
  waits for D2.4's 24 hours.

Rejected: approving in evals automatically (it writes to real systems), and a scripted approver per
case (it needs a second turn, while a case is one prompt).

## Related decisions

- [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) — D3 (refuse, never
  drop), D6 (gateway-metered billing), D8 (a session is pinned to one engine) and D9 (amended here).
- [ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md) — D30,
  reactivated here.
- [ADR-0102](0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md) —
  `ProjectPolicy.approval` and why it is `notBuilt`.
- [ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md) — the platform
  tool catalogue that `handoff_to_person` (D4) joins.
- Tracker #1273 and issue #1297; the implementing units are #1298–#1303; the evals amendment is #1569.
