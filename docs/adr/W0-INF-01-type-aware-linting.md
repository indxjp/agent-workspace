# 0003 · ESLint is type-aware

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Owner
- **Context task:** W0-INF-01

## Context

W0-INF-01 configured ESLint with `tseslint.configs.recommended`, which is purely
syntactic: no `parserOptions.projectService`, so no TypeScript program stands behind the
rules. Everything in the type-checked tier of `typescript-eslint` is therefore inert —
including `no-floating-promises`, `no-misused-promises` and `await-thenable`.

This repository is a gateway and an agent runtime. Its characteristic bug is an
un-awaited promise: a stream that is not drained, a cleanup that never runs, a rejection
that surfaces as an unhandled rejection three layers away from its cause. Those three
rules are the highest-value static check available for that class of defect, and they
were switched off.

The cost of turning them on rises with the size of the codebase, because every violation
already written has to be fixed at once. Right now the workspace is six members of
placeholder code and the violation count is zero.

## Decision

Lint with `tseslint.configs.recommendedTypeChecked` and a `projectService`, and add
`--max-warnings 0` to the `lint` script so a warning-severity rule cannot pass CI.

`.js`/`.mjs`/`.cjs` files opt out via `tseslint.configs.disableTypeChecked`; they have no
TypeScript program and are type-checked by `tsc` through the `allowJs` + `checkJs` of
`tsconfig.root.json` instead.

This decision depends on ADR 0002: `projectService` resolves a file to its nearest
`tsconfig.json`, which only covers test files because 0002 stopped excluding them.

## Consequences

- The three rules named above now fire. Verified by probe, not by reading the docs: an
  un-awaited `probe()` in `packages/core/src/index.ts` produces
  `@typescript-eslint/no-floating-promises`, and `pnpm lint` returns to exit 0 when it is
  removed.
- `--max-warnings 0` means a warn-level rule added later fails CI instead of scrolling
  past. Today every active rule is error-level and the workspace lints clean.
- **The cost:** lint now builds a TypeScript program, so it is slower, and it will get
  slower as the workspace grows. It also becomes possible for `pnpm lint` to fail for a
  reason that is really a `tsconfig` problem — a file in no project reports as a lint
  error. `allowDefaultProject` currently holds one entry (`vitest.config.ts`), which is
  where to look first if that happens.
- Adding a workspace member requires nothing: its own `tsconfig.json` makes its files
  resolvable.
