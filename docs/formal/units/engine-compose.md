# L-engine-compose — the engine port, the registry and the sandbox environment

## Scope

`Behaviour/EnginePort.lean` models the three decisions ENG-04 (#303) adds: the runner's registry
lookup (`apps/runner/src/engines.ts`), an adapter's `compile` (`packages/engine/src/port.ts`, as
`packages/engine-claude-agent-sdk` implements it), and the compose-time protocol check
(`apps/web/server/engines/protocol.ts`). `Behaviour/SandboxEnv.lean` models spec A.11 as a
property of the compiled environment rather than as one provider's spelling of a key.
`Authz/PathGrant.lean` models path normalisation and the write decision a file grant produces,
which every adapter shares.

ENG-04b (#325) added two more, for the decisions #324 recorded as its Deviations 7 and 8:
`Behaviour/EngineToolPolicy.lean` models the Claude tool policy — **both** as
`apps/web/server/compose/run-request.ts` derived it and as
`packages/engine-claude-agent-sdk/src/tools.ts` compiles it — and
`Behaviour/EngineSkills.lean` models where an adapter may place a granted skill and what the
runner refuses.

Current and target are both modelled wherever they differ, and they differ in exactly two places:
*where* the compile step lives, and *where* the tool mapping lives. `compileCurrent` is
`packages/core/src/config.ts`'s function as it stood and `compileTarget` is the adapter's;
`composeCurrent` is compose's tool derivation and `adapterTarget` is the adapter's. Both pairs are
related by an equality, because in both cases the computation is the same function at a new
address.

## Theorems and vectors

- **T1 — protocol check soundness** (`Theorems/Normative/EnginePort.lean`). Compose accepts a
  run exactly when the gateway serves one of the engine's wire protocols for its model
  connection's provider; the resolved protocol lies in both lists; and the engine's own order
  decides. The refusal arm is `engine_model_protocol_unsupported`.
- **T2 — nothing is emitted before a refusal** (`Theorems/Invariants/EnginePort.lean`). An engine
  this image does not carry produces zero frames, *quantified over* what a started run would have
  produced — which is the "before any output" half of the acceptance criterion. `/healthz`
  reports only engines whose package actually loaded.
- **T3 — no provider credential in a sandbox** (`Theorems/Adversarial/EngineSandboxEnv.lean`).
  Every environment a compile accepts has no `ANTHROPIC_API_KEY` under any casing, and every
  `*_API_KEY` / `*_AUTH_TOKEN` in it holds this run's own gateway token.
- **T3 — path grants** (`Theorems/Adversarial/PathGrant.lean`). Every path an adapter may be
  allowed to write normalises outside every read-only grant, through `..`, through a redundant
  spelling, and through an absolute path a symlink target might carry.
- **T2 — a skill lands inside the engine's own directory, or not at all**
  (`Theorems/Invariants/EngineSkills.lean`, ENG-04b). Nothing is written unless every placement
  normalises inside the directory the adapter declared *and* every granted skill is accounted for.
  Both engines this repository ships are checked, with different directories, so the theorems are
  about the rule rather than about `.claude`. The vacuity control is explicit: an adapter that
  places nothing is a refusal, not a pass.
- **T4 — behaviour preserved** (`Theorems/Refinement/EnginePortCompile.lean`). Wherever both
  compiles produce an environment they produce the same one. The three places the target is
  stricter are separate theorems rather than exceptions folded into the equality.
- **T4 — the tool mapping moved without changing what it compiles**
  (`Theorems/Refinement/EngineToolPolicy.lean`, ENG-04b). For every input `cases` enumerates, the
  adapter's compiled tool policy **equals** the policy compose produced — the same lists, in the
  same order, because `allowedTools` and `disallowedTools` reach the SDK as arrays and a
  reordering is a different byte stream. Three statements sit beside it: the permission floor
  survives every stored policy, the compose-side legacy guard changes nothing (which is what makes
  it removable — ADR-0072 D5), and an unrestricted agent compiles the empty narrowing, which is the
  vacuity control.

Vectors: family `engine-compose` (`protocol.json`, `registry.json`, `sandbox-env.json`,
`tool-policy.json`, `skills.json`) and family `path-grant` (`normalise.json`, `write.json`). They
replay through four suites — `apps/web/formal/engine-compose.test.ts` against compose,
`apps/runner/formal/engine-registry.test.ts` against the registry and the environment gate,
`tests/formal/engine-tool-policy.test.ts` against the adapter's tool mapping and the shared skill
check, and `tests/formal/path-grant.test.ts` against the shared path helper.

`tool-policy.json` carries **both** answers per input — `expected.target` and `expected.current` —
so the vector file states the refinement rather than one side of it: the replay asserts the
adapter's compiled policy against `target` *and* asserts that `target` equals `current`.

## Findings

**The credential rule could not be stated as a name list.** A check written as "is
`ANTHROPIC_API_KEY` absent" is satisfied by an environment carrying `OPENAI_API_KEY` with a real
provider key in it, which is exactly what a second engine brings. Stating the rule as "every
credential-shaped variable holds the run token" is what makes the theorem quantify over engines
this repository has never heard of. The declared gap is the other direction: a credential in a
variable named neither `*_API_KEY` nor `*_AUTH_TOKEN` is outside the theorem, and
`RunEnvironment`'s reserved names plus the gateway's own issuance are what cover it.

**`..` had to be resolved, not matched.** A substring check for `".."` refuses `a/../b`, which is
`b` and is fine; a check for a leading `"../"` accepts `a/../..`, which is an escape. Only a fold
over the segments gets both right, and the vector file carries the spellings rather than the
canonical forms so that a future implementation cannot pass by normalising differently.

**The compile had to be separable from the start.** T2 is a statement about ordering, and it is
only provable because `compile` is a pure function the runner calls first. An adapter whose
`start` discovered the same refusals would satisfy no version of this theorem.

## Declared gaps

- **Third-party SDK behaviour is a hypothesis.** Nothing here proves what
  `@anthropic-ai/claude-agent-sdk` does with the options it is handed; the model stops at the
  compiled object. `tests/sdk-surface.test.ts` pins the option surface against the installed
  `sdk.d.ts`, and the conformance kit exercises the adapter around it.
- **`policyReadable` is a decision, not a parse.** The engine arm's contents are engine-native,
  so the model carries the adapter's verdict about it rather than quantifying over its shape.
  `packages/engine-claude-agent-sdk/src/engine.test.ts` is where the parse itself is checked.
- **The private `/run` contract's v2 is not modelled.** `Request` carries the fields the port
  sees today; splitting `agent` into a portable core plus a named engine arm is the follow-up
  ADR-0070 names, and it will change `Request` and nothing else in this family.

## Verification

Reported on the unit's pull request. This repository's implement runner has no Lean toolchain, so
`pnpm formal:build`, `pnpm formal:generate` and `pnpm formal:check` — and therefore the three
replay suites, which read `formal/generated/vectors/**` — are run by the orchestrator rather than
in the branch that wrote the model.
