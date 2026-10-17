# ADR-0021 — Phase 0's credential step cannot close in Wave 1, and the instruction to force it was wrong

Status: accepted
Date: 2026-09-04
Decided by: orchestrator, after W1-UI-04 refused an instruction and proved it wrong
Scope: Wave 1's exit criterion; what "Wave 1 complete" means

## Context

Spec §46 prints Phase 0's completion criteria verbatim:

    Create Agent -> enter instructions -> select Claude -> Run -> receive streamed result

Two operator-acceptance rounds reached the last step and stopped there. The run reaches the SDK, the
SSE stream is real and progressive, and the SDK's own error surfaces honestly — but the answer is
`Not logged in · Please run /login`, because no credential reaches the run.

The orchestrator diagnosed this as a wiring oversight and instructed W1-UI-04 to add
`ANTHROPIC_API_KEY` to the `runner` service's environment in `compose.yaml`, calling it "pure
passthrough plumbing per spec A.11's environment contract".

**That instruction was wrong, and the task refused it with evidence.** Four sources already in the
repository say the opposite:

1. **Spec A.11**, verbatim: *"Provider master credentials never enter a sandbox. The gateway holds
   them, and the sandbox holds a token that only the gateway accepts."* The credential a runtime
   receives is `ANTHROPIC_AUTH_TOKEN` — "short-lived token scoped to this run — never a provider key".
2. **`.env.example`'s own closing section**, titled "Not here, and deliberately", which already
   explains the absence and warns that adding a key there "would paper over it with a second,
   undocumented credential path".
3. **`buildRunRequestFor`'s doc comment**, which sends `env: {}` to the runner by name, for this reason.
4. **`runnerBaseEnvironment`'s doc comment**, which states the mechanical consequence.

The mechanism is the decisive part. Wave 1's `local` driver has no per-run sandbox, and
`runnerBaseEnvironment()` spreads the **entire container environment** into every run's subprocess,
unfiltered. `ANTHROPIC_API_KEY` on the `runner` service would therefore hand a provider master key to
**every run of every workspace** — a multi-tenant credential leak, introduced to make an acceptance
criterion go green.

## Decision

1. **The instruction is withdrawn.** No provider credential is added to `compose.yaml` or
   `.env.example` in Wave 1. W1-UI-04's refusal stands and its ADR is the record.
2. **Phase 0's final step belongs to Wave 4.** The credential path A.11 describes *is* the model
   gateway (§9–§11, §26), which the plan schedules for Wave 4. Wave 1 cannot satisfy §46's last step
   without either building the gateway early or introducing the leak above.
3. **Wave 1 is complete when the slice is complete**: browser → sign in → create agent → enter
   instructions → select Claude → Run → **a real, progressively-streamed SDK event sequence whose
   terminal outcome is reported truthfully**. That is everything §46 lists except the credential, and
   it is demonstrated end to end from a clean `docker compose up -d`.
4. **This is a plan defect, not a product defect.** §46 puts "one model connection: Anthropic" in
   Phase 0 while §48 puts the gateway that carries the credential in Phase 2. Both cannot be true of
   the same wave. The plan is wrong here; the spec is not.

## Alternatives considered

- **Add the key to the runner's environment anyway** (the withdrawn instruction). Rejected: it is a
  cross-tenant credential leak, and it would have been introduced *to turn an acceptance criterion
  green* — precisely the failure mode this programme's honesty gates exist to prevent.
- **Inject the credential per-run through the `RunRequest` body** rather than the container
  environment. Genuinely better, and strictly narrower than the leak. Rejected for Wave 1 only
  because it needs `model_connections` credentials and the §23 secrets layer, both Wave 2 scope —
  pulling two subsystems forward to close one acceptance line is the wrong trade.
- **Declare Phase 0 met anyway**, on the grounds that an operator "would" supply a key. Rejected
  outright: there is no configured path for that key to travel, so the claim would be false.

## Consequences

- Wave 1 lands with spec §46's final step **openly unmet**, recorded here and in the wave manifest
  rather than quietly reinterpreted. Wave 4's exit criteria must include it.
- Every real run in a Wave 1 deployment ends `Not logged in`. That is the honest behaviour of an
  unconfigured deployment and must not be swallowed, reworded, or masked by a friendlier message.
- **The orchestrator was wrong and a task was right.** The task cited four pre-existing sources, none
  of which the orchestrator had read before instructing. The instruction's framing — "not even a
  placeholder … pure plumbing" — was confident and unverified: the exact defect class this programme
  has caught seven times in code and had not yet caught in its own instructions. Task briefs are now
  subject to the same rule as artefacts: **a claim about how the system behaves is checked against
  the system before it is written into an instruction.**
