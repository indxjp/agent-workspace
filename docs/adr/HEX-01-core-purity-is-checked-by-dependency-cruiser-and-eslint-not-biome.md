# HEX-01 — A domain core's purity is checked by dependency-cruiser and ESLint, not Biome

Status: proposed
Date: 2026-11-04
Decided by: hexagonal refactoring plan, part 01 (foundations); needs Owner ratification
Scope: `dependency-cruiser.config.mjs` (`domain-core-is-pure`), `eslint.config.mjs` (the domain core globals block), `tests/architecture-rules.test.ts`, `tests/lint-baseline.test.ts`

## Context

The INDX engineering standards (hexagonal) ask that a core never touches files, network,
database, subprocesses, environment, clock or randomness, and name Biome as the lint tool that
checks it.

This repository already checks the same thing with two tools it uses for every other boundary:

- **dependency-cruiser** checks imports. It holds 47 rules (`pnpm architecture:check`), a
  known-violations baseline with per-rule ceilings, and a planted-fixture test that runs the real
  CLI (`tests/architecture-rules.test.ts`). `platforms-are-pure` (ADR-0133 D6) and the Builder's
  core rule (ADR-0108 B-D5) were the first purity checks.
- **ESLint** checks the globals an import rule cannot see (`Date.now()`, `Math.random()`,
  `process`, `fetch`, and the same names reached through `globalThis`). It is type-aware ([W0-INF-01](W0-INF-01-type-aware-linting.md)), and it
  carries the other baselines (`eslint-suppressions.json`, the complexity ceiling).

Biome is a linter and formatter, not a module-graph checker: it has no equivalent of
dependency-cruiser's path-to-path rules with capture groups and type-only edges. Replacing ESLint
would also mean matching its type-aware rules ([W0-INF-01](W0-INF-01-type-aware-linting.md)) and its
suppressions baseline rule by rule. A switch would mean running Biome beside both tools, or porting
47 dependency rules, two baselines and their tests.

## Decision

1. A domain core's purity is checked by `domain-core-is-pure` (imports: only its own `core/`,
   `packages/contracts` and zod) and by the ESLint domain core block (globals: `Date.now()`,
   `new Date()`, `Date()`, `Math.random()`, `process`, `fetch`, `crypto`, `performance`,
   `setTimeout`, `setInterval`, `setImmediate`, `WebSocket`, `EventSource`, `XMLHttpRequest`,
   `navigator`, `AbortSignal`, the global object under any name (`globalThis`, `global`, `window`,
   `self`), and any use of `Date` outside an allow-list of its pure uses, so an alias, spread,
   `Reflect.construct`, `(0, Date)` or `Date` passed as an argument is refused too). The
   baseline file `shares/core/service.ts` keeps every ban but reading the clock. Not covered: a
   formatter that reads the clock when given no date (`new Intl.DateTimeFormat().format()`);
   review catches it.
2. The ESLint block bans reading the clock, not the `Date` type: a pure computation such as
   `new Date(ms)` or `Date.UTC(…)` is allowed, because a core receives the time as a `Date` and
   computes with it (the Builder's `core/facts.ts` does).
3. Biome is not added. This is the one place where the repository differs from the standard's tool
   list; what the standard asks the tool to check is checked.
4. A rule that lands where existing code does not follow it leaves that code out by name rather
   than growing a known-violations baseline, which AGENTS.md forbids: `domain-core-is-pure`'s
   `pathNot` leaves out `shares/core/`, and the ESLint block exempts `shares/core/service.ts` from
   the clock ban only, by a list in `eslint.config.mjs` pinned by a test (CI's
   `check-lint-baseline.mjs` refuses any new entry in `eslint-suppressions.json`). Each exclusion is
   removed by the part that makes the code pure.

## Consequences

- One more dependency rule and one ESLint block; no new tool, CI job or configuration format.
- Each check has a planted-fixture test, so an edit that loosens a pattern fails a test instead of
  passing silently.
- `.dependency-cruiser-known-violations.json` does not change. `domain-core-is-pure` leaves out
  `apps/web/server/shares/core/` (its 25 imports are not checked until then), and
  `eslint.config.mjs` exempts `apps/web/server/shares/core/service.ts` from the clock ban by name.
  Part 05 of the refactoring plan removes both.
- If the standard's owners require Biome itself, the decision to revisit is whether to run it
  beside ESLint for its formatter and lint rules; the purity checks above stay where they are.

## Amendment (2026-11-05): no core is left out

Refactoring plan part 05 made `apps/web/server/shares/core/` pure, and both exclusions in decision 4
are gone: `domain-core-is-pure` has no `pathNot` for it, and `eslint.config.mjs` has no list of
files that may read the clock.

- The rules stay in `shares/core/`: `rules.ts` (what a publish may ask for, the expiry lifetimes,
  when a public link opens; the time comes in as an argument), `input.ts` (the request schema) and
  `resource.ts` (the wire allowlist and the list filter).
- What does I/O moved next to it: `shares/service.ts` (the use cases, which read the time through
  the `Clock` port and mint the token and passphrase hash with `node:crypto`), `shares/http.ts`,
  `shares/runtime.ts` (the port) and `shares/publish-request.ts` (the `invalid_share` error and the
  snapshot built from other domains).
- A new rule that meets existing code still lands as decision 4 says; there is simply nothing left
  out today.

