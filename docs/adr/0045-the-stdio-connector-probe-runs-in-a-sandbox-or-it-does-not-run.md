# ADR-0045 — The stdio connector probe runs in a sandbox or it does not run

**Status:** accepted
**Date:** 2026-09-06
**Scope:** programme
**Context:** W2-CP-05, two repair rounds, the leak reappearing through a different channel each time

## Context

`POST /api/connectors` with `dryRun` and `transport: "stdio"` spawns a **caller-supplied command
inside the control-plane process**. Round 1's verifier drove `MASTER_ENCRYPTION_KEY` out of it in an
HTTP `200` body, at `authType: "none"`, with nothing written to the database and no audit trail.

Round 2 repaired it as instructed and the repair is genuinely good: `restrictedBaseEnv()` replaces
`process.env` with a narrow allowlist, the seam **refuses** an absent `baseEnv` rather than falling
back — an explicit `else` that rejects, ADR-0015 satisfied — and the `process-died` message stops
echoing the child. The confirmer verified all three, and dumped the child's whole environment through
the route to prove the allowlist holds: `HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE,
SystemRoot, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR` and none of the four compose secrets.

**And the key came back anyway, twice, through channels the repair did not touch.**

* `classify.ts` scrubbed one of five free-text message paths. `MESSAGES['server-refused']`,
  `['unknown-failure']` and `['sse-stream-failed']` still interpolate `d.detail`, which
  `describeSignal` fills from the child's **stdout** — verbatim and unbounded:

      200 {"ok":false,"kind":"server-refused",
           "message":"The server refused the connection:
                      RAW-CHILD-TEXT:MASTER-KEY-8e11c0d4f7a94b0e-DO-NOT-LEAK."}

* The environment allowlist does not bound what the child can *read*. It inherits the control plane's
  cwd, uid and filesystem, so it read the deployment's own `.env` — `compose.yaml:72` is where
  `MASTER_ENCRYPTION_KEY` comes from — and returned it through the same 200. And on the platform this
  actually deploys to, the confirmer ran the same shape in `node:22-slim` with a child spawned using
  exactly `restrictedBaseEnv()`'s POSIX allowlist:

      CHILD_OWN_ENV_KEYS=HOME,PATH
      LEAKED_FROM_PARENT=DATABASE_URL=… | SESSION_SECRET=… | MASTER_ENCRYPTION_KEY=… |
                         BOOTSTRAP_ADMIN_PASSWORD=…

  read out of `/proc/<ppid>/environ`, same uid, no privilege needed. Windows has no `/proc`; Linux is
  the deployment target.

## The decision this forces

Scrubbing four more message paths would close the two channels the confirmer found. It would not
close the third, the fourth, or the one nobody has thought of, because **the primitive underneath is
arbitrary code execution as the control-plane user**, and message hygiene is a blocklist over
observable channels — ADR-0044's failure mode, at a different layer.

**A caller-supplied command is executed in a sandbox, or it is not executed.**

Concretely, for W2-CP-05 and every task after it:

1. **The control plane does not `spawn` a caller-supplied command.** Not with a narrowed environment,
   not with a scrubbed message, not behind a permission check.
2. The stdio probe therefore **answers a declared, named refusal** — the transport is accepted and
   stored, and `Test Connection` for it reports that it cannot be performed in this deployment,
   naming the missing resource.
3. **The missing resource is the runtime layer**, which is Wave 3. `wire/stdio.ts`'s own header
   already says the design intent — *"`baseEnv` must be the environment the RUNNER would give this
   connector"*. The runner is where this belongs and it does not exist yet.
4. This is a **declared gap under [ADR-0035](0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md)**,
   carrying the command actually attempted and its actual output, the named missing resource, and
   everything achievable without it still verified.

Nothing in the acceptance criterion is lost. The 2b-2 cell asks that *"a wrong URL and a wrong token
produce two different human-readable errors"* and that a credential be stored as a secret reference —
both already verified end to end against a live fixture MCP server over **http**, by a confirmer using
`psql` inside the container rather than the repository that wrote the row. Spec §8's `Test Connection`
is not specified as stdio-only.

## Why this is the orchestrator's call and not the task's

Both readings available to W2-CP-05 were defensible and one of them is unsafe:

* scrub the remaining message paths — satisfies the finding as literally written, ships arbitrary code
  execution on the control plane;
* refuse stdio probing — satisfies §8 with a declared gap, ships nothing that executes caller input.

That is [ADR-0042](0042-a-plan-cell-that-contradicts-its-own-accept-line-is-amended-at-the-cell.md)'s
situation exactly, and its rule is that the plan decides rather than the task. The decision is
recorded here so W2-INT-02 and Wave 3 inherit it rather than rediscovering it.

## Consequences

* `restrictedBaseEnv()` and the `baseEnv` refusal **stay**. They are correct, they are defence in
  depth, and they are the right shape for the day the runner performs this probe. What must change is
  the ADR sentence claiming they mean the probe *"cannot become a vector for reading this
  deployment's own secrets"* — two runs falsify it, and a claim a run falsifies is the ADR-0016
  defect this programme keeps paying for.
* Wave 3 inherits a named obligation: when the runtime layer lands, the stdio probe moves there and
  the declared gap closes with evidence rather than by deletion.
* The general rule, stated once so it is not re-derived: **executing caller-supplied input is a
  sandbox question, never a sanitisation question.** No allowlist over an environment, and no filter
  over an output channel, converts arbitrary execution into safe execution.
