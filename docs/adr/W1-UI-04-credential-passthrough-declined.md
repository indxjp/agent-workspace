# W1-UI-04 — ANTHROPIC_API_KEY passthrough into the runner's environment is declined, not implemented

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `compose.yaml`, `.env.example` — specifically, why neither changes

## Context

This task's brief instructed, as its third fix: add `ANTHROPIC_API_KEY` to the `runner` service's
`environment:` block in `compose.yaml`, sourced from `${ANTHROPIC_API_KEY}` in `.env`, and add the
variable to `.env.example` as optional, on the stated grounds that "this is pure passthrough
plumbing per spec A.11's environment contract" and that its absence is presently an oversight —
"not even a placeholder for `ANTHROPIC_API_KEY`."

That framing does not survive reading the files it is about. Four independent sources, already in
this repository before this task started, say the opposite:

1. **Spec §A.11**, verbatim: *"Provider master credentials never enter a sandbox. The gateway
   holds them, and the sandbox holds a token that only the gateway accepts."* The table above it
   names `ANTHROPIC_AUTH_TOKEN` — "short-lived token scoped to this run — never a provider key" —
   as the credential a runtime receives, not `ANTHROPIC_API_KEY`.

2. **`.env.example`'s own closing section**, titled "Not here, and deliberately": *"There is no
   `ANTHROPIC_API_KEY` in this file. Spec A.11 is explicit that a provider master credential never
   enters a sandbox … in this build there is no configured path from an operator's provider key to
   a run at all. That is a real gap, it is declared … and putting a key here would paper over it
   with a second, undocumented credential path."*

3. **`apps/web/server/compose/run-request.ts`**, `buildRunRequestFor`'s own doc comment: `env` is
   sent as `{}` to the runner *by name*, with the reasoning spelled out — "What this side would
   have to put here instead is a provider credential, and spec A.11 forbids one entering a
   sandbox."

4. **`apps/runner/src/index.ts`**, `runnerBaseEnvironment`'s doc comment, which states the
   mechanical consequence of putting the key in `runner`'s own environment rather than in the
   request body: *"A run started through this container can read every environment variable the
   container was started with … an operator who puts a provider credential in the runner's
   environment has given it to every run. Neither `.env.example` nor `compose.yaml` does so —
   there is still no credential shipped from an operator's key to a run — but the sentence 'there
   is no path' is now 'there is no configured path', and the difference is this function."* This
   is elaborated further in
   [W1-COMP-01-the-runner-supplies-the-base-environment.md](W1-COMP-01-the-runner-supplies-the-base-environment.md),
   which reaches the identical conclusion independently and calls it "a declared gap on this
   task's PR" — the same gap this task's brief characterised as a bug to close.

The mechanism matters, not just the citation. `runnerBaseEnvironment()` spreads the **entire**
container environment into every run's subprocess, unfiltered, because Wave 1's `local` driver has
no per-run sandbox to isolate one workspace's execution from another's (`compose.yaml`: "Wave 1 has
no `docker` driver"). So `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}` on `runner` would not be scoped
"passthrough plumbing" for one operator's own use — it would be a single master credential handed,
unscoped, to every workspace's every agent run that container ever serves. That is exactly the
failure mode §A.11 is written to prevent, stated by name in the very file (`index.ts`) that would
carry it out.

## Decision

**`compose.yaml` and `.env.example` are left unchanged with respect to `ANTHROPIC_API_KEY`.** This
task does not add the variable to either file. The sentence `.env.example` already carries —
"there is no configured path from an operator's provider key to a run" — remains true after this
task's PR, and remains correct: the path does not exist because spec §A.11 forbids the one shape
that would be quick to build (a container-wide credential) and the shape §A.11 requires (a
gateway-issued, run-scoped `ANTHROPIC_AUTH_TOKEN`) is Wave 4 work, not a `compose.yaml` edit.

Spec §46 Phase 0's "receive streamed result" step is therefore still not reachable with a real
Anthropic response in this build. That is a genuine, standing gap — not a defect this task
silently declined to fix, but a load-bearing architectural boundary this task declined to cross.
It is the same gap three prior tasks (W1-CP-04's `RunEnvironment`, W1-COMP-01, and whoever wrote
`.env.example`'s closing section) each independently found and each declined to close the same
way, for the same reason, and recorded.

## Alternatives considered

- **Do it anyway; it is what the operator asked for.** Rejected: the operator did not review
  `index.ts`'s consequence table before writing the instruction, and an instruction whose own
  stated justification ("pure passthrough … per spec A.11") is contradicted by A.11's actual text
  is a mistaken premise, not an informed request to override an architectural decision. Spec
  constraints are named in this task's own brief as grounds a PR is rejected on regardless of
  tests passing; §A.11 is one, even though it is not on that brief's enumerated list.
- **Add the variable but scope it more narrowly, e.g. only to a single test/demo agent.** Rejected:
  nothing in this wave's schema or runner distinguishes "this run may use the operator's key" from
  "this run may not" — `runnerBaseEnvironment()` has no per-run filter, and building one is the
  gateway's job (§26), not a `compose.yaml` line.
- **Add it to the `gateway` placeholder's environment instead.** Rejected on the task's own
  instruction: "Do NOT weaken the gateway placeholder's 501." The placeholder answers 501 to every
  request by construction and holds no credentials by design; giving it one would be exactly that
  weakening, and it still would not reach `runner` without a code change the gateway does not have
  in Wave 1.
- **Silently do nothing and say nothing.** Rejected — the task's own closing instruction is to
  declare a blocker rather than resolve it silently in either direction. This record is that
  declaration.

## Consequences

- Phase 0's completion criterion, run end-to-end with a real operator key, remains unmet after this
  task's PR — declared here, in the PR description, and unchanged from `.env.example`'s existing
  wording.
- W1-UI-04's other two fixes (the agent creation UI and the home route's caching bug) stand
  independently of this one; nothing about them depends on a credential reaching the runner.
- Building the real path is Wave 4's model gateway (§9–§11, §26): a service that holds the
  operator's key, mints `ANTHROPIC_AUTH_TOKEN` per run, and is the thing `runnerBaseEnvironment`'s
  own comment already points at as the intended answer.
