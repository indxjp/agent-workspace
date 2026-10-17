# W2-CP-07 acceptance — a real process kill, a real resume, a real model

> **ACCEPT** (the Wave 2 plan): *"Kill the runtime mid-session, start a fresh one, resume,
> and the conversation continues — demonstrated against a real process kill, not a mocked one. This
> is plan §10's release blocker."*

Everything in this directory exists to execute that sentence. It is a probe fixture, not product
code, and nothing under `apps/web` imports it.

## Run it

```sh
pnpm build
AW_SESSION_RESUME_ACCEPTANCE=1 npx vitest run --config apps/web/server/sessions/acceptance/vitest.config.mjs
```

`pnpm build` is not optional: the two child processes run `apps/runner/dist/**`, the **compiled**
runner, not a transpiled copy of its source.

**Neither half of that command is decoration.** The file is named `resume.acceptance.ts`, not
`*.test.ts`, so `pnpm test` never collects it and `--config` is the only way in; and the environment
variable is checked in `beforeAll`, which **throws** rather than skipping. That shape is forced by
CI: the workflow’s *"No test in the run was skipped"* step fails the job on any test that did not
execute, because *"a skipped test is not a passed test"*. A `describe.skipIf(…)` here was tried
first and turned CI red, which is the gate working. `vitest.config.mjs` beside this file records the
whole of it.

Verify that `pnpm test` really does not see it, rather than believing this paragraph:
`npx vitest list | grep resume.acceptance` prints nothing.

It needs a working Claude credential in the developer's own `CLAUDE_CONFIG_DIR` (default
`~/.claude`). **This repository ships no credential and must not**: spec A.11 forbids a provider
master credential entering a sandbox and [ADR-0021](../../../../../docs/adr/0021-phase-0-credential-step-belongs-to-wave-4.md)
puts the credential path in Wave 4. The harness never reads, copies or prints one; it points the run
at the config directory that already works and isolates itself inside it with a generated
`CLAUDE_CODE_PROJECT_DIR_NAME`.

## What it actually starts

```text
  vitest process                                  child process 1        child process 2
  ┌──────────────────────────────┐                (killed)               (fresh)
  │ http server on 127.0.0.1:0   │◀──HTTP───────── startLocalAgent ─────  startLocalAgent
  │  → the REAL route handlers   │   the mirror    + sessionStore         + sessionStore
  │    (server/sessions/api.ts)  │                 → claude.ts            → claude.ts
  │  → FileTranscriptStore       │                 → query()              → query({ resume })
  └──────────────────────────────┘                 → a real model         → a real model
```

* The **store and the handlers are the shipped ones**, imported directly. Vitest transpiles them;
  `apps/web` has no importable build output, which is why this is a test file rather than a `.mjs`
  script beside `../../runs/acceptance/run-acceptance.mjs`.
* The **runner is the shipped one**. The child's entry module imports `startLocalAgent` from
  `apps/runner/dist/runtime.js`, `runnerBaseEnvironment` from `dist/index.js` and the mirror from
  `dist/session.js`. The only thing it does that `startAgentInThisContainer` does not is pass
  `{ sessionStore }` — which is exactly the wiring gap declared in
  [`W2-CP-07-the-two-wiring-lines-this-task-does-not-own.md`](../../../../../docs/adr/W2-CP-07-the-two-wiring-lines-this-task-does-not-own.md),
  made visible here rather than hidden.
* The child's entry file is **written to a temporary directory at run time**, for the reason
  `../../runs/acceptance/README.md` gives about its own temporary file: a committed `.mjs` importing
  `apps/runner/dist/**` would be a tracked file with a module reference into a gitignored directory,
  which `tests/no-sdk-import.test.ts` refuses by name (ADR-0032 clause 2). Its exact bytes are the
  string literal in `driverSource()`, which is the copy that actually runs and therefore the only
  one that cannot drift.

## The three things between the two turns, and why each one is there

1. **`taskkill /PID <pid> /T /F`** (or `kill -9` on POSIX). Not `close()`, not an abort, not a
   resolved promise — the operating system destroys the process **tree**, while the child is holding
   the session open. `/T` matters: `child.kill('SIGKILL')` on Windows maps to `TerminateProcess` on
   the node process alone and would leave the SDK's own `claude` subprocess alive and writing. The
   exit is then asserted **not** to be a clean `code: 0`, so a child that exited for its own reasons
   fails the test rather than passing it.

2. **`rm -rf <CLAUDE_CONFIG_DIR>/projects/<projectKey>`.** This is the sandbox's own copy of the
   transcript. R-01 §6 verified live that a session lives there by default, and §14.9 calls a session
   that lives *only* there the release blocker. With it gone, the store is the only surviving copy,
   so a passing turn 2 cannot be explained by local disk. The harness asserts the directory's name
   begins with the prefix it generated before it removes anything.

3. **A read-back over HTTP** — `GET /api/sessions/:id/transcript` with the run's cookie (200, and the
   codename is in the body), `GET /api/sessions` (the session is listed as resumable), and the same
   transcript read **without** a cookie (401, so the 200 is an authenticated answer rather than an
   open endpoint).

Turn 2 then asks the model for a codename that was only ever said in turn 1. The codename is
generated per run, so it exists nowhere until the process starts and a pass cannot come from a model
that has read this repository.

## What a pass proves, and what it does not

Proven, by executed output:

* an Agent SDK session's state reaches durable storage outside the sandbox, through
  `apps/runner/src/session.ts` and the §20 routes;
* `claude.ts`'s `sessionDurability()` answers `durable: true` with a mirrored-batch count, because
  the appends resolved, no batch was dropped, and the stream reached a `result`;
* the process holding that session can be destroyed by the operating system, and its local transcript
  deleted, and a **different** process can resume the conversation from the store alone;
* the resumed model answers with a fact stated only in the destroyed process's conversation.

**Not** proven, and not claimed anywhere:

* **PostgreSQL.** The backend here is `FileTranscriptStore`. §20 prefers PostgreSQL and the adapter is
  a declared gap — [`W2-CP-07-session-state-has-no-table-in-section-27.md`](../../../../../docs/adr/W2-CP-07-session-state-has-no-table-in-section-27.md).
* **A deployment.** Nothing calls `installSessionApi()` in `apps/web/instrumentation.ts` and nothing
  passes `{ sessionStore }` in `apps/runner/src/index.ts`; both files belong to other tasks. In a
  real deployment today these routes answer 503 and no run mirrors anything.
* **Next.js.** The handlers are driven through a plain `node:http` server that makes the same calls
  the App Router files make. The route files themselves are covered by `../routes.test.ts` and by
  `tests/route-inventory.test.ts`, not by this run.
* **A second machine.** One host, one operating system. R-01 flags multi-host resume as *documented,
  not probed*; this run makes it *probed on one host*, which is a mechanism established and not a
  platform contract.
* **Subagent transcripts.** `listSubkeys` is implemented and unit-tested, but this run's agent has no
  subagents, so no subagent transcript was mirrored or restored.
* **Anything about cost or latency.** The run is two single-turn prompts; the numbers it prints are
  identifiers, not measurements.

## What the run printed

The harness ends with one `W2-CP-07 RESULT {…}` line carrying the codename, the Claude session id,
both process ids, the kill's exit status, the durability verdict, the number of stored entries, the
local transcript path it deleted and the model's answer. Paste that line, not a summary of it.
