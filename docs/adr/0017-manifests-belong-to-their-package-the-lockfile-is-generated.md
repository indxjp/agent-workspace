# ADR-0017 — A manifest belongs to its package; the lockfile is generated, not owned

Status: accepted — amends [ADR-0009](0009-pnpm-lock-ownership-exception.md)
Date: 2026-09-03
Decided by: orchestrator, from two independent escalations in Wave 1a
Scope: whole programme

## Context

[ADR-0009](0009-pnpm-lock-ownership-exception.md) ruled that a wave's **first** task batches every
dependency the wave needs, and that a later task "escalates; it does not edit the lockfile in
parallel". Wave 1a proved that rule cannot be satisfied, from two directions at once:

- **W1-DB-01** was instructed to add `@anthropic-ai/claude-agent-sdk`. It could not, and was right
  not to. The SDK's home is `apps/runner/package.json` (spec §42; R-01 §11 prints that exact
  manifest fragment), which is outside W1-DB-01's `Owns:`. Under pnpm's isolated `node_modules`,
  declaring it in `packages/core` would not make it resolvable from `apps/runner` **anyway**, so the
  instruction was not merely blocked — it was incoherent. A `devDependencies` placement additionally
  fails the licence gate, because the SDK reports `Unknown` and its recorded exception is scoped
  `prod`.
- **W1-CP-05** needs `"@agent-workspace/core": "workspace:*"` in `apps/web/package.json` before any
  route can persist anything. It escalated rather than adding it, exactly as ADR-0009 requires. The
  cost of obeying the rule: every agent route on that branch answers `503
  agents_runtime_not_configured`. The task is complete as scoped and functionally inert.

Both agents obeyed the rule and both were correct to escalate. The rule was wrong.

The error in ADR-0009 was conflating two different files. `pnpm-lock.yaml` is a **generated artefact**
— a function of every manifest in the workspace. `package.json` is **source**, and each one belongs
to the package it describes. ADR-0009 gave one task ownership of both, which means giving one task
authority over every other package's source.

## Decision

1. **A package's `package.json` is owned by whichever task owns that package.** `apps/runner/package.json`
   is the runner task's; `apps/web/package.json` is a web task's. No task adds a dependency to a
   manifest it does not own, and no task is asked to.
2. **`pnpm-lock.yaml` is generated, not owned.** Any task that legitimately changes a manifest it owns
   regenerates the lockfile as a consequence, and **declares it** in the PR body's Ownership section.
   An undeclared lockfile change remains a violation; a declared one is expected.
3. **Lockfile conflicts are resolved by regenerating, never by merging.** On a conflict the resolution
   is `pnpm install`, not a hand-merge of resolution entries. This is why it does not need an owner:
   a generated file has no authoritative hand-written version to protect.
4. **The root `package.json` keeps ADR-0009's treatment** — it is genuinely shared (scripts, the
   Prettier globs, `engines`), so it belongs to the wave's first task, and a later task escalates.
5. **Where a wave needs wiring that spans packages** — as Wave 1a did, with the runner needing the SDK
   and the web app needing `@agent-workspace/core` — that is **a task**, placed in the stack where the
   dependency graph puts it, not an obligation smuggled into an unrelated one. Wave 1a's repair adds
   `W1-DEP-01` for exactly this, directly above `W1-CORE-01`.

## Alternatives considered

- **Keep ADR-0009 and have the first task own every manifest in the wave.** Rejected: it makes the
  first task the author of every other task's public dependency surface, which is a much worse
  coupling than the lockfile churn it was written to prevent — and, per the pnpm resolution point
  above, it does not even work.
- **Let any task edit any manifest freely.** Rejected: manifests are source, and two tasks editing
  `apps/web/package.json` in parallel is the ordinary ownership collision §2.3 exists to stop.
- **Gitignore the lockfile.** Rejected again, for ADR-0009's original reason: it defeats
  `--frozen-lockfile`, the only thing making CI installs reproducible.

## Consequences

- Several tasks in a wave may now touch `pnpm-lock.yaml`, and the integration branch will see
  conflicts in it. Rule 3 makes that cheap, but it is real churn that ADR-0009 was trying to avoid.
- The ownership checker will flag every such change. That friction is intended and is how a reviewer
  learns the dependency surface moved — but a wave with five manifest-touching tasks will produce
  five flags, and reviewers must not learn to wave them through.
- ADR-0009 is not superseded. Its lockfile-declaration requirement and its rejected alternatives
  still stand; only its "first task owns all dependencies" clause is replaced.
- **The general lesson is about rules written by someone not doing the work.** ADR-0009 was written
  by the orchestrator, from a Wave 0 observation, and encoded a physical impossibility that only
  surfaced when two agents tried to obey it. Both escalated instead of quietly breaking the rule,
  which is the only reason it was caught in one wave rather than five.
