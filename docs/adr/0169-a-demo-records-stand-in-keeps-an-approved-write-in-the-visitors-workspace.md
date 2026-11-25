# ADR-0169 — A demo's records stand-in keeps an approved write in the visitor's workspace

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of G3 (use-cases-100 plan, tracker #2383), on the Owner's delegation for the programme
Scope: `packages/core/src/db/schema/workspaces.ts` and migration 0110 (`workspaces.demo_verification_at`, G3b), `packages/core/src/db/repositories/demo-caps.ts`, `packages/contracts/src/demo-operator.ts` (the record kinds, their schemas and samples, `DemoSeedConnector.recorded`, the stand-in's write answer), `apps/web/server/demo/provision/` (the records stand-in and the copy of a declared connector), `apps/web/server/demo/records/` (new: the recorder), `apps/web/server/runs/` (the `DemoApprovedWrites` port and its one call), `apps/web/server/composition/wiring/run-api-demo-caps.ts`

## Context

The Agent Store's 100-use-case plan (§9, unit G3) has
an Action archetype (AC): a request in chat becomes a change in a system through a connector,
behind approval. Its entries (facility, scheduling, access, onboarding, offboarding) and the
routing write of the triage archetype (TR) need a demo in which the change is visible: the
visitor approves the write, then asks again and sees the new event, task, access change or
booking.

### What exists

- **The records stand-in** (`apps/web/server/demo/provision/records-server.ts`, spec phase P6). A
  connector the seed declares (`DemoSeedConnector`: a name, read tools and write tools) becomes,
  in a visitor's copy, a stdio MCP server that is one plain source string with no network, file
  or process code. Its read tools answer from the entry's sample records (`demo.records`), which
  ride in the connector's arguments. Its write tools answer `DEMO_SEND_RESULT` and change nothing.
- **The approval pause** (ADR-0145, ADR-0157). A gated call ends the run `awaiting_approval`. An
  approve decision starts a continuation run in the same session, with the approved call
  (`ApprovalCall`: the tool name and the RFC 8785 canonical text of name and arguments) on the
  new row. The run row's insert completes the paused run in the same transaction, so exactly one
  decision wins. The engine runs only a call whose canonical text matches (D2.1).
- **A run's process lives for one run.** The continuation is a new sandbox and a new stand-in
  process, so a stand-in that kept a write in memory would lose it before anyone could read it.
- **The visitor's connector rows are the visitor's.** A stand-in is a row of the visitor's demo
  workspace (`mcp_servers`, `workspace_id … on delete cascade`), made by the copy and removed with
  the workspace by the sweep.

## Decision

### D1 — Four record kinds, typed once in the contracts

`DEMO_RECORD_KINDS` is `calendar`, `task`, `access` and `booking`. Each has a strict zod schema in
`@indx-workspace/contracts/demo-operator` (`DEMO_RECORD_SCHEMAS`): a calendar event (title, start,
end, attendees, location), a task (title, assignee, due date, notes), an access change (person,
system, level, grant or revoke, until) and a booking (resource, start, end, booked for, purpose).
Times are ISO 8601 with an offset, an end is after its start, and unknown keys are refused.
`DEMO_RECORD_SAMPLES` holds one fictional sample of each kind in Japanese and in English, which the
contract test parses, so an entry author copies a shape that is known to pass.

### D2 — The seed names which write tool records what, and where it is read

`DemoSeedConnector` gains an optional `recorded`: a list of `{ write, kind, read }`. `write` must be
one of the connector's write tools and `read` one of its read tools, each write is named once, and
a seed without the field is unchanged. The template row keeps it as one more argument per entry
(`record:<write>:<kind>:<read>`, beside `read:` and `write:`), and the copy carries it to the
stand-in. A read tool that some recorded write names is offered even when it has no sample
records, so a calendar can start empty.

### D3 — The platform records the write when the approval is consumed, never the stand-in

The stand-in stays a process that cannot write anything. The write is recorded by the platform:
the runs domain declares a port, `DemoApprovedWrites`, and `startRunOnSession` calls it once for a
continuation whose row was just inserted with approved calls, **after** the insert that consumed the
decision and **before** the run is handed to the launcher. The demo domain fills it
(`apps/web/server/demo/records`). It acts only in a workspace that keeps demo writes
(`DemoCapsRepository.keepsDemoWrites`): a visitor's demo workspace (one with a demo end,
`workspaces.demo_expires_at`) or the verification workspace (`workspaces.demo_verification_at`,
G3b). `PUT /api/demo/verification` sets that column when it fills a workspace, the first time only,
so R1 and the daily production test, which run there, see an approved write as a visitor does. The
column is never set any other way, and marking does not make a workspace a demo: nothing sweeps it.
Any other workspace's continuation pays one read of those two columns and nothing else: no
connector list, no row. For each approved call it finds the records stand-in of the
run's workspace that the tool name names (`mcp__<name>__<tool>` or `mcp__connector-<id>__<tool>`),
and, when that tool is a recorded write, validates the call's arguments with the kind's schema and
writes the outcome into that stand-in's arguments (`connectors.update`). The continuation's
stand-in starts from the updated row, so the approved call and every later read see it.

This placement is what makes "the stand-in must never write without approval" structural:

- the only code that changes a stand-in's records runs on the approved calls of a row whose insert
  won the decision (ADR-0145 D2.3); a rejected decision carries none, a new run carries none, and
  a run's own request body cannot set them (`decides` is built only by the decision route);
- a write tool the agent calls with no approval (a template that does not gate it) reaches the
  stand-in only, which answers `demo_write_not_recorded` and changes nothing;
- the recorder touches only the run's own workspace's rows, so another visitor's demo never sees
  the change, and the workspace's deletion removes it.

### D4 — What the stand-in answers

A recorded write's tool lists its kind's JSON Schema as its `inputSchema`, so the model sees the
shape. When it is called, the stand-in looks for an outcome recorded for the same arguments
(their key: a 53-bit hash of their canonical JSON, members sorted, computed the same way by the
platform and by the stand-in) and answers with `DemoRecordWriteAnswer` in
`structuredContent`:

- `{ demoOnly: true, recorded: true, tool, record }` for an approved, valid write; the record has an
  `id` (`<kind>-<n>`, numbered per kind) and its `kind`;
- `{ demoOnly: true, recorded: false, tool, code: 'demo_record_invalid', issues }`, as a tool error,
  when the approved arguments failed the schema; `issues` are the field paths and, at most 20,
  messages that never echo the input: zod's message only for the codes built from the schema
  alone (a type, a bound, a format, the allowed options, our own refinement), and a fixed message
  for any other code, such as an unrecognized key, whose message would name what the visitor sent;
- `{ demoOnly: true, recorded: false, tool, code: 'demo_write_not_recorded' }`, as a tool error,
  when nothing was recorded for the call (it was not approved, or the stand-in is full).

A read tool answers its recorded records first (newest first), then the sample records, under the
existing cut of 100 records per answer. A recorded record carries no `lang`.

### D5 — Bounds

At most 50 outcomes per stand-in (`DEMO_RECORD_WRITES_MAX`), and the stand-in's whole state stays
under the existing `RECORDS_JSON_MAX_BYTES`. A kept call stores its arguments' key, never the
arguments, so a refused call costs a few bytes however large its input was. A stand-in with no
recorded write carries exactly the JSON it carried before this record (`reads` and `writes`). Past either, the write is not recorded and the
stand-in answers `demo_write_not_recorded`. A failure to record (an unreadable row, a store error)
is logged with the run and workspace and does not undo the decision; the stand-in then answers
`demo_write_not_recorded`, which is true.

## Consequences

- An AC entry declares its connector's `recorded` writes and gates them with `requireApproval`;
  its demo then shows the change after approval with no code of its own. The store's catalog
  (`examples/store/catalog/define.ts`, owned by L1) does not yet pass `recorded` into the seed: a
  follow-up adds it to the catalog's `demo` connector declaration.
- The runs domain gains one optional port, like `DemoRunGate`; a continuation in a workspace that
  keeps no demo writes pays one read of `demo_expires_at` and `demo_verification_at` and nothing
  else.
- `workspaces.demo_verification_at` (migration 0110) is nullable and expand-only; every existing
  row is an ordinary workspace until the verification fill marks one.
- A visitor cannot change the kept records by hand: the demo guest role holds no `connectors`
  permission at all (`apps/web/server/rbac/core/permissions.ts`, the `guest` row; pinned by
  `permissions.grants.test.ts`, "the guest holds only the demo"), so `PATCH /api/connectors/:id` is
  refused. Only the platform's keeper writes a stand-in's row, and only in the run's own workspace.
- Two continuations of the same visitor in two sessions that record into the same stand-in at the
  same moment can lose one outcome (last write of the row wins). A visitor works one chat at a
  time; the stand-in then answers `demo_write_not_recorded` for the lost one, so nothing is shown
  that was not kept.
- Sample data stays fictional and in both languages (D1); nothing reaches a real system and the
  demo sandbox keeps its `none` network.
- A repeat copy into a visitor's demo carries the kept writes into the stand-in's new state while
  the stand-in still records their write, whatever release's stand-in source the row ran. A refill
  of the verification workspace clears them, so each real-model run starts from the template's
  records and is repeatable (ADR-0171 D2). The `demo_verification_at` mark is set by the first fill
  only, as before, and a write approved during a run there is kept until the next refill.

## Alternatives considered

- **The stand-in writes a file** (into a granted folder or the memory folder, ADR-0163). It would
  give the stand-in file code, which is what made it safe to run, and the write-back happens only
  after a completed run, so a later read in the same run would disagree with the next run.
- **Record at the decision route.** The route starts the continuation through the same
  `startRunOnSession`; recording before it would record for a decision that then loses the race
  (D2.3), and recording after it races the launcher, which may load the connector first.
- **Record from the run's events after the run.** It needs the engine's tool results read back and
  trusted, and a read in the continuation itself would not see the change.
- **A demo records table.** A new table, migration and adapter pair for state that already has a
  home that is scoped to the visitor and removed with the workspace: the stand-in's own row.
