# ADR-0062 — The specification is a Lean 4 model, and the TypeScript is tested against it

Status: accepted — decision 8 amended by [ADR-0063](0063-the-formal-programme-proceeds-one-domain-at-a-time-and-fixes-the-bugs-it-finds.md)
Date: 2026-09-23
Decided by: the Owner (formal specification programme, `docs/formal/00-orchestrator-prompt.md`)
Scope: `formal/`, `scripts/formal/`, `tests/formal/`, `docs/formal/`, the `formal:*` scripts, the
`formal` job in `.github/workflows/ci.yml` and the `ci-success` rule in `scripts/check-workflows.mjs`

## Context

What Agent Workspace means is spread across `docs/spec.md`, the SDK API specification
(`docs/sdk/04-api-specification.md`), the docs-site concept pages, about 280 ADRs, the Zod contracts,
the RBAC decision tables and the domain code. The documents disagree with each other and with the
code in places, and the docs site already marks the gaps as "Today / Target" callouts and "Open
questions". Tests exercise examples. Nothing states a property for all inputs, so tenant isolation,
the absence of privilege escalation and the run lifecycle are argued in prose and sampled in tests.

## Decision

1. **Lean 4 is the machine-checked source of truth for the meaning of the platform and the SDK.**
   The model lives in `formal/`, a Lake package with its own toolchain, and does not touch the
   TypeScript toolchain. Its layers mirror the TypeScript dependency direction
   (`Prelude → Contracts → Concepts/Er → Authz → Behaviour/Lifecycle/Events → Sdk/Cli → Theorems`).
   `lake exe imports` enforces that direction from the compiled module headers (ADR-0030).
2. **Toolchain and dependencies are pinned.** Lean `v4.34.0` (`formal/lean-toolchain`), Batteries
   `v4.34.0` at `f2effa3d803fda822b1f97b806c47cf2adfbcbc2` and Plausible `v4.34.0` at
   `118aa17ee84656b8bd727fef7c458ee8c833385c` (`formal/lakefile.lean`, `formal/lake-manifest.json`).
   All three, and elan, are Apache-2.0 (`docs/dependency-policy.md` §11). Mathlib is not a
   dependency. Adding it requires an ADR that shows a theorem needs it, because it multiplies the
   build time.
3. **Soundness is gated.** `lake exe axioms` fails when any model declaration depends on an axiom
   other than `propext`, `Classical.choice` and `Quot.sound`. That covers `sorry` (`sorryAx`) and
   `native_decide` (`Lean.ofReduceBool`), which stays forbidden unless a later ADR permits it with
   a trust argument. The same tool also fails when a public theorem under `Theorems/` has no
   `@[aw_spec]` entry, no docstring, or a tier that disagrees with its directory.
4. **Traceability is declared, not inferred.** `@[aw_spec (tier := T1) (doc := "path#anchor")
   (ts := "path#symbol")]` records which document sentence and which TypeScript symbol a
   declaration formalises. The attribute is `aw_spec` because Lean's core already registers `spec`.
   `pnpm formal:generate` validates every citation: the file exists, the anchor is a heading of it,
   and the symbol occurs in it.
5. **The implementation is tested against the model by differential vectors.** `lake exe vectors`
   writes `formal/generated/vectors/<family>/*.json` (exhaustive where the domain is finite, seeded
   samples plus the adversarial edge cases where it is not). `tests/formal/<family>.test.ts` replays
   them against the real contracts, decision functions, SDK and CLI inside `pnpm test`. A
   disagreement fails a test. The fix is never to edit a vector.
6. **Derived documents are generated and gated.** `formal/generated/catalogue.json`,
   `docs/formal/catalogue.md`, `docs/formal/traceability.md` and the vectors are committed.
   `pnpm formal:check` regenerates them and fails when the committed copies are stale.
7. **CI runs the model on every relevant change.** The `formal` job installs elan from a pinned
   release with a verified SHA-256, caches the toolchain and `formal/.lake`, then runs
   `formal:build`, `formal:check` and the vector replay. Its path filter lives in a step, because
   `ci-success` counts a skipped job as a failure. `ci-success` needs `formal`, and
   `validateWorkflowDocuments` now enforces that, with regression tests in
   `tests/tooling/quality-validators.test.ts`. This strengthens a gate and loosens none.
8. **Product code is not changed by the programme.** A disagreement becomes a finding
   (`docs/formal/findings.md`). The document is fixed when the code is right. An ADR draft or issue
   is raised when the code or the concept model should change. The only product-code edits allowed
   are behaviour-preserving extractions that make a decision function callable from the conformance
   suite, and each comes with a test.

## Alternatives considered

- **TLA+ or Alloy.** Both are well suited to state machines and relational models. Neither gives
  executable definitions to generate vectors from, and neither checks proofs for unbounded domains
  (TLC and Alloy are bounded model checkers). Lean gives definitions, proofs and an executable
  vector emitter in one artefact.
- **Coq/Rocq or Isabelle.** These are comparable in power. Lean 4 is also a practical programming
  language, so the tools (catalogue, axiom audit, vectors) are written in the model's own language
  with no extraction step.
- **Property-based testing only (`fast-check`).** It finds counterexamples but proves nothing, and it
  would add an npm dependency. Seeded sampling on the Lean side covers the infinite domains without
  one.
- **A Mathlib dependency.** It would bring order theory and finite sets, but it costs a much larger
  build and cache for properties Batteries and core already express.

## Consequences

- A contributor who changes a contract, a decision table, the SDK or `aw` may see the `formal` job
  fail on stale vectors or on a vector the TypeScript no longer satisfies. The fix is to update the
  model (and so the vectors) or to record a finding. Weakening the test is never the fix.
- The Lean toolchain is a development dependency outside npm. It is installed by elan
  (`docs/formal/README.md`) and is not part of the shipped product.
- The theorem catalogue becomes the reviewable statement of behaviour. A theorem that is removed or
  weakened shows up in the generated catalogue diff.
