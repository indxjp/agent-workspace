# W2-CP-05 — The stdio probe's `baseEnv` must never default to `process.env` (round 2, B1)

Status: accepted
Date: 2026-09-06
Decided by: W2-CP-05 (implementer), repairing a round-1 finding
Scope: `apps/web/server/connectors/test-connection.ts`, `apps/web/server/connectors/classify.ts`,
`apps/web/server/connectors/handlers.ts`, `apps/web/server/connectors/base-env.ts` (new)

## The defect

`apps/web/server/connectors/wire/stdio.ts`'s own header states the rule its only call site broke:
*"`baseEnv` must be the environment the RUNNER would give this connector, not this transport's own
default."* `test-connection.ts`'s `testConnection` defaulted `baseEnv` to `options.baseEnv ??
process.env`, and both route call sites in `handlers.ts` (`createConnector`'s `dryRun` branch and
`testConnectionSaved`) called `testConnection(config)` with no `options` at all — so every real
invocation of the stdio probe spawned the caller's `command`/`args` with **this container's own
full environment** copied in. `compose.yaml` puts `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`,
`SESSION_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD` into that same `web` service, and
`classify.ts`'s `process-died` message echoed the child's captured stderr verbatim into the HTTP
response — so a caller who could reach `POST /api/connectors` with `{"dryRun": true, "transport":
"stdio", "authType": "none", ...}` could run an arbitrary command on the control plane and read
those secrets back in a **200** body, with nothing written to persistence (no row, no audit
trail). See this task's PR report for the exfiltration reproduction, run before and after this
fix.

## The repair — two changes, both inside this task's `Owns:` globs

1. **`baseEnv` is now a required parameter with no default**, enforced by the type system
   (`testConnection`'s `options.baseEnv` is no longer optional) and, belt-and-braces, by a runtime
   throw if a caller somehow gets past that (an `as any` cast, a `.js` consumer). Absence is now
   an error, never a silent fallback to `process.env` — this is ADR-0015 applied to a hazard
   rather than a gate: the fallback WAS the decision made by the absence of a value.
2. **Every route call site builds an explicit, minimal environment** with the new
   `apps/web/server/connectors/base-env.ts`'s `restrictedBaseEnv()`: `PATH` and `HOME`/
   `USERPROFILE` always, plus `SystemRoot` and `TEMP` on win32 only — never any other key of this
   process's own environment. `handlers.ts`'s two call sites now pass
   `{ baseEnv: restrictedBaseEnv() }` explicitly.
3. **`classify.ts`'s `process-died` message no longer includes the child's stderr.** The tag
   (`FailureKind`) already distinguishes "the process could not be spawned at all"
   (`command-not-found`, from a `spawn-error` signal) from "the process started and then died"
   (`process-died`) without quoting anything the child wrote to its own stderr. Nothing in this
   task's acceptance criterion (two different tags, two different sentences, for a wrong URL vs a
   wrong token) depends on `process-died`'s message carrying stderr text — that classification is
   reached through `json-rpc-app-error` instead (a structured reply from the server, not the
   child's raw output).

## What this is not — corrected (round 3, B1/ADR-0045)

**This section originally claimed `restrictedBaseEnv()` "exists only so this control plane's own
Test Connection probe cannot become a vector for reading this deployment's own secrets." Two
rounds' worth of runs falsified that claim, so it is corrected here rather than left standing
(ADR-0016 — a sentence a run falsifies must change, not survive as decoration).**

`restrictedBaseEnv()` narrows what a spawned child's **environment variables contain**. It does
nothing to bound what a spawned child can otherwise **read**: a child inherits this process's own
filesystem and, on the Linux containers this deployment actually runs on, its own
`/proc/<ppid>/environ` — readable by the same uid, no privilege needed, and containing every
secret `restrictedBaseEnv()` was built to keep out of `env`. Round 3's confirmer read
`MASTER_ENCRYPTION_KEY` back out of a child spawned with **exactly** this function's allowlisted
environment, twice, through two different channels neither round 1 nor round 2 touched (this
task's PR report and `docs/adr/0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md`
have both reproductions). An environment allowlist cannot make `spawn`ing a caller-supplied command
safe, because the primitive underneath is arbitrary code execution as the control-plane user —
that is a sandboxing question, never an environment-hygiene question.

**`restrictedBaseEnv()` and the `baseEnv`-required contract on `testConnection` both stay** — they
are correct, they remain defence in depth, and per ADR-0045 they are now specifically the contract
Wave 3's sandboxed runner will be called under when it lands. What changed in round 3 is that
`test-connection.ts` no longer calls `./wire/stdio.ts`'s `probeStdio` at all for a `stdio` config —
see `docs/adr/0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md` for the full
decision and this task's PR report for the round-3 evidence.

## Verification

Re-ran the exact exfiltration body the round-1 verifier used, against the real route module,
before and after this change — see this task's PR report for both pasted responses (ADR-0029: a
fix must be watched refusing the attack that motivated it).
