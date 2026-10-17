# W2-CP-05 — The stdio Test Connection probe no longer spawns anything (round 3, B1, implementing ADR-0045)

Status: accepted
Date: 2026-09-06
Decided by: W2-CP-05 (implementer), implementing a design decision made above this task
Scope: `apps/web/server/connectors/test-connection.ts`, `apps/web/server/connectors/classify.ts`,
`apps/web/server/connectors/test-connection.test.ts`, `apps/web/server/connectors/routes.test.ts`

## This is an implementation record, not a design decision

**The design decision was made by the orchestrator, not by this task**, and is recorded in
[ADR-0045](0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md). This record
exists only to say precisely what changed in this task's own files to carry that decision out, and
to correct the sentences round 2 left standing that ADR-0045's own findings falsified. Do not read
this record as re-litigating the choice — read ADR-0045 for the "why", this one for the "what,
here".

## What round 2 got right, and where it still fell short

Round 2's `restrictedBaseEnv()` (`base-env.ts`) and the `baseEnv`-required contract on
`testConnection` are correct, are kept, and per ADR-0045 are now specifically the interface Wave
3's sandboxed runner will be called under. What round 2 could not close, because no amount of
environment narrowing closes it, is that a **spawned child inherits this process's filesystem
regardless of what its environment variables contain**. Round 3's confirmer read
`MASTER_ENCRYPTION_KEY` back out of a child spawned with exactly `restrictedBaseEnv()`'s allowlist,
twice, through two channels neither environment scrubbing nor message scrubbing touches: the
deployment's own `.env` file on disk, and (on the Linux containers this deployment actually runs
on) `/proc/<ppid>/environ`. See ADR-0045's Context section for both reproductions verbatim.

## The change

`testConnection` (`test-connection.ts`) now checks `config.transport === 'stdio'` **before** doing
anything else with the config, and if so, returns immediately:

```ts
if (config.transport === 'stdio') {
  return {
    ok: false,
    kind: 'stdio-probe-unavailable',
    message: MESSAGES['stdio-probe-unavailable']({ ... }),
  };
}
```

`./wire/stdio.ts`'s `probeStdio` is no longer imported by `test-connection.ts` at all — not called
with a narrower environment, not called behind a permission check, not called and then having its
result discarded. There is no code path from a `stdio` `TestConnectionConfig` to `child_process.spawn`
anywhere in this task's routes. `wire/stdio.ts` and `base-env.ts`'s `restrictedBaseEnv()` remain in
the tree unchanged and un-deleted, per ADR-0045 point 3: they are what Wave 3's sandboxed runner
will call when it exists.

`classify.ts` gained one new `FailureKind`, `'stdio-probe-unavailable'`, with a message that names
the missing resource ("there is no sandboxed runner here to execute it safely instead") and never
interpolates the caller-supplied command's own output, because there is none to interpolate — no
process ever ran to produce any.

**Unaffected, by design:** a `stdio` connector is still validated (`contract.ts`) and still stored
(`store.ts`) exactly as before. Only the **probe** — `dryRun: true` on `POST /api/connectors`, and
`POST /api/connectors/:id/test-connection` for an already-saved stdio connector — answers the
refusal. Nothing about create/list/get/delete changed.

## Consequence for this task's acceptance criterion

The plan's acceptance criterion — *"a wrong URL and a wrong token produce two different
human-readable errors — drive both and paste both messages"* — no longer has two distinguishable
stdio failure modes to demonstrate, because stdio has exactly one outcome now. This is not a lost
criterion: it is verified end to end on `http` (this task's PR report has the pasted transcript),
and spec §8 does not specify Test Connection as stdio-only. Per ADR-0045, this is declared under
[ADR-0035](0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md):

1. **Command actually attempted and its actual output:** see this task's PR report, "B1" — the
   round-1/round-2 exfiltration body re-run against the round-3 tree now returns
   `{"ok":false,"kind":"stdio-probe-unavailable","message":"Test Connection cannot run a stdio
   server in this deployment: ..."}`; the `/proc/<ppid>/environ` and `.env`-read attacks are re-run
   and return the same, with pasted evidence.
2. **Named missing resource:** the sandboxed runner — Wave 3's runtime layer (spec's own dispatch;
   `wire/stdio.ts`'s header already anticipated this: *"`baseEnv` must be the environment the
   RUNNER would give this connector"*).
3. **Everything achievable without the resource, verified:** `stdio` connectors still validate,
   store, list, and delete correctly (`contract.test.ts`, `store.test.ts`, `routes.test.ts`
   unaffected by this change beyond the one dryRun test rewritten below); the refusal itself is
   tested three ways in `test-connection.test.ts` — the returned `kind`/message, a real MCP fixture
   server that provably never answers because it is never started, and a sentinel-file attack
   (`node -e "writeFileSync(...)"`) that provably never runs.

## Tests changed

* `test-connection.test.ts`'s `describe('Test Connection — stdio', …)` — previously drove real
  spawns and asserted `command-not-found` / `credential-rejected` — is replaced with
  `describe('Test Connection — stdio (ADR-0045: refused, never spawned)', …)`, asserting the
  refusal is unconditional (same `kind` regardless of command/args/env/credential) and, twice over,
  that nothing is actually executed: a timing check against the real fixture server, and a sentinel
  file a spawned child would have written and does not.
* `routes.test.ts`'s dryRun-with-a-nonexistent-command test now asserts `stdio-probe-unavailable`
  (not `command-not-found`) and still asserts nothing is persisted.

## What this does not change

`apps/web/server/connectors/wire/stdio.ts`, `apps/web/server/connectors/base-env.ts`, and
`apps/web/server/connectors/base-env.test.ts` are untouched. They are correct in isolation and are
exactly what Wave 3's runner is expected to call.

## Verification, in full

`bash docs/adr/regenerate-index.sh --check` on the tree carrying this file reports the index
current (175 records) — this file is counted, and the table and count agree by construction.
