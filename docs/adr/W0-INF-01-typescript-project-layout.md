# 0002 · One TypeScript project per member, with a separate emit config

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Owner
- **Context task:** W0-INF-01

## Context

Compiled tests must not land in `dist/`. W0-INF-01 enforced that with an exclude in the
root `tsconfig.json`, inherited by every package:

```jsonc
"exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
```

and then re-included the same globs, with `noEmit`, in **two** further configs so the
tests were still type-checked: `tsconfig.root.json` for packages and `apps/runner`, and
`apps/web/tsconfig.tests.json` for the web app. The root config said so in a comment:

> Keep the three lists in sync: anything excluded here and re-included nowhere is
> silently unchecked.

The arrangement worked — it was verified with `tsc --listFiles` — but it has two
properties worth naming. The first is the one its own comment admits: correctness
depends on three separately-edited glob lists agreeing, and the failure mode when they
disagree is silence. The second surfaced when type-aware ESLint was attempted (ADR
0003). The `projectService` of `typescript-eslint` resolves each file to the **nearest
`tsconfig.json`**. It does not know about `tsconfig.root.json`. Every test file was
therefore outside its resolved project, and the only way to lint it was to enumerate the
test files in `allowDefaultProject` — a fourth list, capped by default at eight files,
already at six.

The root cause is that one config was doing two jobs. Keeping tests out of `dist/` is an
**emit** concern. Excluding them from the *type-checking* project to achieve it is what
forced every re-inclusion downstream.

## Decision

Each workspace member has two configs, split by job:

- **`tsconfig.json` — the type-checking view.** `include: ["src"]`, `noEmit: true`, no
  test exclusion. This is the project the editor, `pnpm typecheck` and type-aware ESLint
  all resolve to, and it covers the whole source of the member, tests included.
- **`tsconfig.build.json` — the emit view.** Extends the above, turns emit back on, and
  carries `rootDir` / `outDir` / `declaration` and the test exclusion. It is the only
  config in the member that writes anything.

The root `tsconfig.json` becomes options-only and carries no `exclude` at all.
`tsconfig.root.json` shrinks to the two files that genuinely have no member —
`vitest.config.ts` and `eslint.config.mjs`. `apps/web/tsconfig.tests.json` is deleted:
`apps/web` emits nothing (`next build` produces the app), so it had no `dist/` to protect
and the exclusion there was pure ceremony.

`build` becomes `tsc -p tsconfig.build.json`; `typecheck` becomes `tsc -p tsconfig.json`.

## Consequences

- **The three-way sync is gone.** There is exactly one list of test globs per member, in
  the one config that emits. Nothing can be excluded and re-included nowhere.
- **Type-aware linting resolves with no enumeration.** `allowDefaultProject` holds a
  single entry, `vitest.config.ts`, and does not grow as tests are added.
- Dist hygiene is preserved and was re-verified after the change: a full `pnpm build`
  leaves no `*test*` or `*spec*` file anywhere under any `dist/`.
- Test type-checking is preserved and was re-verified by probe rather than by reading:
  a deliberate type error in `packages/core/src/index.test.ts` fails that own
  `tsc -p tsconfig.json` of the package, and the same error in an `apps/web` test fails
  the one of `apps/web`. Coverage moved from the root pass to each member's own pass;
  none was lost.
- **The cost:** one more file per member (five `tsconfig.build.json` files today), and
  a reader must know which of the two configs answers a given question. The naming is
  the mitigation — `build` is the one that builds.
- `next build` now type-checks `apps/web` test files along with everything else. A test
  there must therefore declare its own `vitest` dependency rather than borrowing the
  root one. That is the phantom-dependency rule working, not a regression.
