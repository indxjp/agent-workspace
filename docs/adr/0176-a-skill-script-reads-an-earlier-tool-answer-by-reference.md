# ADR-0176 — A skill script reads an earlier tool answer by reference

Status: accepted
Date: 2026-11-23
Decided by: the implementing agent of G6 (the Agent Store 100-use-case plan, §9 G), on the programme orchestrator's delegation for the plan
Scope: `packages/engine/src/tool-answers.ts` (new), `packages/engine/src/adapter.ts` (the kit records every run's answers), `packages/engine/src/skill-script.ts` (`input: { fromToolUse }`), the three adapters' `run_skill_script` wiring and Node hosts, `packages/engine-claude-agent-sdk/src/engine.ts` (a continuation's resumed answers), `packages/skills-office/office-reader/scripts/lib/public-source.mjs` (new), `tests/engine/run-skill-script*.test.ts`

## Context

Two analysis entries of the plan, peers and patent-map, read a public source through the
public-source tool ([ADR-0170](0170-a-public-source-is-read-through-one-code-tool-that-serves-a-dated-snapshot-or-the-live-feed.md))
and then compute over its records in a skill script
([ADR-0137](0137-skill-scripts-run-without-a-shell-under-nodes-permission-model.md),
[ADR-0173](0173-a-use-case-script-imports-the-built-in-table-reader-by-its-package-path.md)). A
script cannot read a tool's answer, so the agent copies the records into the script's arguments as
JSON (`--records '<json>'`). The review of those entries found three faults in that:

- **The model restates the data.** It can drop, reorder or alter a record while copying, and
  nothing notices: the script computes over whatever it was given.
- **The arguments are too small.** One argument holds at most 8 KiB
  (`SKILL_SCRIPT_LIMITS.maxArgumentBytes`). The tool's own limit is 50 records, each with up to 32
  fields, which does not fit.
- **Each entry parses the records itself**, and the two copies differ.

### What exists

- **Every adapter maps its engine's events to neutral frames**, and every frame passes through one
  loop: `createEngineAdapter` in `packages/engine/src/adapter.ts`. A tool's answer is an
  `agent.tool.result` frame (`toolCallId`, `output`, `isError`), announced by an `agent.tool.call`
  frame (`toolCallId`, `name`). `output` is the text the model received.
- **`run_skill_script` runs in the adapter's own process**, the runner inside the run's sandbox, in
  every runtime: the tool body is an in-process MCP tool on Claude and a function tool on Mastra and
  OpenAI Agents. The answers and the tool are in the same process, so no new transport is needed.
- **An approval pauses a run** ([ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md)).
  The approved call runs in a continuation: a new run that resumes the same session. On Claude,
  the SDK loads the session's transcript from the run's session store before it resumes; the store
  is reached with the run's own signed token, which the control plane scopes to that session.
  Approvals exist only on Claude (ADR-0145 D5).

## Options

### Option A — The call names an earlier tool call; the engine hands its answer to the script (recommended)

`run_skill_script` takes `input: { fromToolUse: "<tool call id>" }`. The engine writes that call's
answer, exactly as the model received it, to a file the script may read and not write, and names
the file in the environment. The model chooses which answer; it cannot change a byte of it.

### Option B — The public-source tool writes its answer to a file

The tool runs in the per-session tool sandbox or the demo's records stand-in, neither of which
shares a disk with the run. Each runtime would need a channel back, and only one tool would gain
it. Rejected.

### Option C — Raise the argument limit

It answers only the size. The model still restates the records. Rejected.

### Option D — Reference by tool name ("the latest answer of `public_source`")

The model always knows a tool's name, but "latest" is not one fixed answer. An approval binds
the call's exact arguments (ADR-0145 D2.1), so the approved call could read a different answer
from the one the person saw, if the model asked the tool again in between. The same id always
names the same answer. Rejected. The model's uncertainty about an id is covered by D3: a wrong id
is refused with the ids the run holds.

## Decision

Option A, with the decisions below.

### D1 — Every run records the answers it received, from its own frames

`createToolAnswers()` (`packages/engine/src/tool-answers.ts`) is one run's record. The kit creates
one in each `start()`, feeds it the frames the adapter's mapper produces, and hands it to the
adapter's `plan` as `toolAnswers`. It keeps each `agent.tool.result`'s `output`, with the name its
`agent.tool.call` announced. An answer is an error when the frame says `isError` or
`status: 'failed'`. There is one source for all three adapters, and none parses its engine's
events a second time.

- **Only the run's own agent.** A plan may say that an event is not the run's own
  (`isOwnAnswer`), and the kit then records none of its frames. Claude says so for every message
  that carries a `parent_tool_use_id`: a subagent's tool answers reached the subagent's model, never
  the run's, so a script is never handed one, and a refusal never names one. Mastra's subagents
  produce no `agent.tool.result` frame of their own in the run's stream
  (`boundary-subagents.test.ts` drives real Mastra: only the delegation call's answer is there).
  OpenAI Agents' subagents run through `asTool`, whose nested events the adapter only meters, and
  the engine offers no `run_skill_script` today (`skills: false`).
- **Only this run.** The record lives in the run's process and ends with it. A new run starts with
  an empty record. There is no read from another run, session or workspace, with the one exception
  of D2.
- **Bounded.** It keeps at most 24 MiB of answer text (`TOOL_ANSWERS_LIMITS.maxRetainedBytes`) and
  drops the oldest answers past it.
- **Ordering.** The model can name only a call whose answer it has seen, so the engine has already
  received the answer. Its frame may still be queued behind the run's consumer when the script's
  call arrives. The Claude SDK, for example, queues the tool result message before it dispatches
  the next tool call. `find` therefore waits for an id it has not seen yet, for at most 5 s
  (`TOOL_ANSWERS_LIMITS.waitMs`), and stops waiting when the run is aborted.

### D2 — A continuation of an approval also holds the answers of the session it resumes

A gated `run_skill_script` call that names an answer pauses its run. The approved call then runs in
the continuation, a new run whose own record does not hold the answer. On Claude, when the run
continues an approval (`approvedToolCalls` is not empty) and offers scripts, the adapter records
the answers of the main transcript the SDK loads from the session store, through the same frame
mapping as a live answer. A subagent's transcript, and a subagent's message in the main
transcript, is not recorded. The store is the run's own session, under the run's signed token.

This is the one exception to "only this run": a continuation can reference **any** answer in the
session's main transcript, not only the one its approved call names. Every such answer belongs to
the same session and the same principal, and is already in the model's context, so nothing new
reaches the model or the script. Any other run, including a later prompt in the same session,
starts with only its own answers. The other engines have no approvals.

The approval binds the referenced **id**, not the content the person saw: the approved call runs on
the answer named by the approved id. Within one session, an id names one answer, and the transcript
the continuation resumes is the one the paused run wrote, so the two are the same answer. The
console's approval card shows the canonical call, the id included, but not yet the referenced
tool's name or the answer's size (a follow-up, below).

### D3 — The call: `input: { fromToolUse }`

The tool's input gains one optional field, `input`, which is exactly `{ fromToolUse: string }`
(1–256 characters, no NUL). Anything else is `unusable_arguments`. OpenAI's strict schema sends
`input: null` for no reference, as it does for `args`. The engine checks the skill and the script
first, then the reference:

- an id with no answer in the record is `unknown_tool_answer`, and the reason names the last 20
  answers the run holds as `id (tool name)`, so the model can correct the id;
- an error answer, or one larger than `SKILL_SCRIPT_LIMITS.maxInputBytes` (2 MiB), is
  `unusable_tool_answer`.

Nothing runs after a refusal.

### D4 — The answer is a file the script reads and cannot write

For a call with a reference, the engine makes a second directory for the call beside its scratch
directory and writes the answer to `tool-answer.txt` in it, as UTF-8, with `wx` (a new file,
never one that already exists). The directory is named once more in `--allow-fs-read` and never in
`--allow-fs-write`, so Node's permission model refuses a write, an append, a delete or a rename
there. The file's path is in the environment variable `SKILL_SCRIPT_INPUT`
(`SKILL_SCRIPT_INPUT_ENV`). It is not an argument: the model sets the arguments and not the
environment, so it cannot point the script at a file of its own in place of the answer. A call
without a reference has no such variable and no such directory. Both directories are removed when
the call ends, whatever the outcome, and each is removed even when removing the other fails. The
script cannot make a link to the file from its scratch directory either: the permission model
refuses the link.

**Residual: another process of the same user.** The file is written, then the script starts. The
permission model binds the script, not other processes. An agent that also has a shell (`Bash`,
which runs as the same user) could, in that window, replace or edit the file in the temporary
directory if it learned its path. The engine does not defend against the run's own user; such an
agent can already change the data a script reads in many other ways. A read-only grant withholds
the shell (ADR-0137), so an agent that relies on this ADR to keep the model from altering data
should not also be given `Bash`.

Nothing else changes. The script reads what it could read before, plus this one file. It writes
where it could write before. It has no network. A gated `run_skill_script` still waits for its
approval. The approval is bound to the call's exact arguments, `input.fromToolUse` included (D2),
and the run's frames carry the referenced call with its tool name and its answer.

### D5 — The built-in reader: `office-reader/scripts/lib/public-source.mjs`

A use case's script imports
`@indx-workspace/builtin-skills/office-reader/scripts/lib/public-source.mjs`, which
`run_skill_script` resolves to the placed office-reader as in ADR-0173. It is listed in
`BUILTIN_IMPORTS` with its sha256, and its coverage is held at 100%.

```text
readPublicSource(env?) → { asOf, truncated: false, records: [{ id, ...fields }] }
```

- `readToolAnswer(env?)` reads the file `SKILL_SCRIPT_INPUT` names. If the call named no
  answer, it refuses with `no_tool_answer`, and its message says to pass `input: { fromToolUse }`.
  A file it cannot read is `unreadable_file`.
- `publicSourceRecords(text)` holds the text to the tool's answer shape (`PublicSourceAnswerSchema`):
  JSON, the five keys and no other, `mode` `snapshot` or `live`, dated `asOf`, and items with their
  source, url, title, summary, dates and named scalar fields. Anything else is
  `not_public_source`. A cut answer (`truncated: true`) is `truncated_answer`, so no record is
  silently left out. A record without an id is `record_without_id`, a repeated id is
  `duplicate_id`, and a field named `id` is `duplicate_field`.
- Each refusal is a `TableError`, which `cli.mjs` prints as `{ error, message }` on stderr with
  exit code 1.

## Consequences

- An entry's script receives the public source's answer unchanged and in full. The real-process
  test hands a script 50 records in 31,436 bytes, where one argument holds 8 KiB
  (`tests/engine/run-skill-script.test.ts`). The model passes only an id.
- peers and patent-map move to the reference and the reader in a follow-up. Their own parsing
  code is then deleted.
- The adapters' `run_skill_script` input schemas gain `input` (`run-skill-script-parity.test.ts`).
  Each Node host gains `writeFile`.
- Every run keeps its tool answers in memory until it ends, up to 24 MiB. They are already in the
  model's context and in the run's frames.
- Not measured yet: how reliably a model passes the right id. The refusal lists the ids, so a wrong
  id costs one turn. The follow-up's R1 runs on peers and patent-map measure it.
- Not built: a reference to more than one answer per call, and a reference across runs other than
  an approval's continuation.
- Follow-up: the approval card of a gated `run_skill_script` call shows the referenced tool's name
  and the answer's size beside the id, so the person sees what the id names without opening the
  run's frames.

## Related decisions

- [ADR-0137](0137-skill-scripts-run-without-a-shell-under-nodes-permission-model.md): how a skill
  script runs, and what it may read and write.
- [ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md): approvals
  and the continuation run.
- [ADR-0170](0170-a-public-source-is-read-through-one-code-tool-that-serves-a-dated-snapshot-or-the-live-feed.md):
  the public-source tool and its answer.
- [ADR-0173](0173-a-use-case-script-imports-the-built-in-table-reader-by-its-package-path.md):
  importing a built-in module by its package path.
