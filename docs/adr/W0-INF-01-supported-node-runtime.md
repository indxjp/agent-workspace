# 0005 · One Node version, stated in three places that agree

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Owner
- **Context task:** W0-INF-01
- **Programme record:** [ADR-0006 — Node 24 is the floor, enforced by
  `engine-strict`](0006-node-24-and-engine-strict.md) — why the floor is a security decision tied to
  R-14 and spec §15.2. This record says what the three declarations do.

> Renamed from `0005-supported-node-runtime.md` by
> [ADR-0012](0012-reconciling-two-adr-series.md); the heading below keeps its original number
> because that record renames without rewriting. ADR-0005 is an unrelated programme decision.

## Context

The workspace declared `engines.node: ">=24"`, CI (`.github/workflows/ci.yml`, arriving
with W0-INF-02) pins `node-version: 24`, and the root `@types/node` was pinned to
`26.3.0`.

The typings are the odd one out, and they are the one that silently wins.
`@types/node@26` describes APIs that Node 26 has and Node 24 does not. Code using one of
them type-checks clean, lints clean, passes CI on Node 24 as long as no test exercises
the line, and then throws `TypeError: ... is not a function` on the runtime the project
claims to support. The declared floor is the thing that would be wrong, and nothing would
say so.

## Decision

The supported runtime is **Node 24**, and all three declarations say so. `@types/node` is
pinned to `24.13.3` — the latest 24.x line — to match `engines.node` and the CI
`node-version`.

Raising the floor is a deliberate act that changes all three together, and the CI pin is
the authority: whatever CI runs is what the typings must describe.

## Consequences

- Type-checking can no longer approve an API the supported runtime does not have.
- pnpm reports `(26.4.1 is available)` on install. That notice is expected and is not a
  reason to bump: the pin tracks the *runtime*, not the newest publish.
- **The cost:** genuinely new Node APIs are unavailable to the type-checker until the
  floor is raised, and a contributor developing on Node 26 gets no warning from their
  local runtime that they have used one — only from `tsc`. That is the intended
  direction of the failure.
- When the floor moves, `engines.node`, the CI `node-version` and `@types/node` move in
  the same commit, and this ADR is superseded rather than edited.
