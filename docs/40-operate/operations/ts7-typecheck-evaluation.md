# TypeScript 7 (tsgo) typecheck evaluation

Date: 2026-11-19. Owner decision D5 of the CI speed programme: typecheck may run on TypeScript 7
(the native `tsgo` compiler) only if its diagnostics are identical to TypeScript 6 on every
project; lint stays on TypeScript 6 because typescript-eslint needs the compiler API that TS7
does not ship until 7.1.

## Verdict: no-go for a switch, because there is nothing to switch, and the diff is not zero

1. **Typecheck already runs on TypeScript 7.0.2.** Every workspace member and the root declare
   `"@typescript/native": "npm:typescript@7.0.2"` next to
   `"typescript": "npm:@typescript/typescript6@6.0.2"`. The TS6 package only provides the `tsc6`
   binary; the TS7 package provides `tsc`. Every `typecheck` (and `build`) script calls plain
   `tsc`, so `node_modules/.bin/tsc -v` prints `Version 7.0.2` in the root, both apps and all 21
   packages. No change to the typecheck targets is needed to "adopt" TS7.
2. **Lint already runs on TypeScript 6.** `typescript-eslint@8.72.1` is installed against the peer
   `@typescript/typescript6@6.0.2` (pnpm store path
   `typescript-eslint@8.72.1_@typescript+typescript6@6.0.2_…`). `tsc6 -v` prints `Version 6.0.3`,
   the `typescript@^6` the TS6 wrapper depends on.
3. **The TS6 vs TS7 diagnostics diff is 1, not 0.** On one of the 28 typecheck configurations
   TS6 reports an error that TS7 does not. D5 therefore does not let us claim the two compilers
   agree, and this report does not change any target.

## Diagnostics diff, every typecheck configuration

Each configuration that a `typecheck` script runs was checked with both binaries, exactly as the
script runs it (`tsc -p <config>`, every config already sets `noEmit`), with `--pretty false`;
`error TS` lines were sorted and compared. Builds came from the Nx cache; `apps/web` had
`next typegen` run first, as its script does.

| Configuration                                           | TS6 exit | TS7 exit | TS6 errors | TS7 errors | Same |
| ------------------------------------------------------- | -------- | -------- | ---------- | ---------- | ---- |
| `tsconfig.root.json` (project `agent-workspace`)        | 2        | 0        | 1          | 0          | no   |
| `apps/runner/tsconfig.json`                             | 0        | 0        | 0          | 0          | yes  |
| `apps/web/tsconfig.json`                                | 0        | 0        | 0          | 0          | yes  |
| `packages/app/tsconfig.json`                            | 0        | 0        | 0          | 0          | yes  |
| `packages/app/fixtures/desk/tsconfig.json`              | 0        | 0        | 0          | 0          | yes  |
| `packages/app/fixtures/generated-recipes/tsconfig.json` | 0        | 0        | 0          | 0          | yes  |
| `packages/aw/tsconfig.json`                             | 0        | 0        | 0          | 0          | yes  |
| `packages/cli/tsconfig.json`                            | 0        | 0        | 0          | 0          | yes  |
| `packages/contracts/tsconfig.json`                      | 0        | 0        | 0          | 0          | yes  |
| `packages/core/tsconfig.json`                           | 0        | 0        | 0          | 0          | yes  |
| `packages/create/tsconfig.json`                         | 0        | 0        | 0          | 0          | yes  |
| `packages/egress-proxy/tsconfig.json`                   | 0        | 0        | 0          | 0          | yes  |
| `packages/embedded/tsconfig.json`                       | 0        | 0        | 0          | 0          | yes  |
| `packages/engine-claude-agent-sdk/tsconfig.json`        | 0        | 0        | 0          | 0          | yes  |
| `packages/engine-mastra/tsconfig.json`                  | 0        | 0        | 0          | 0          | yes  |
| `packages/engine-openai-agents/tsconfig.json`           | 0        | 0        | 0          | 0          | yes  |
| `packages/engine-pi/tsconfig.json`                      | 0        | 0        | 0          | 0          | yes  |
| `packages/engine/tsconfig.json`                         | 0        | 0        | 0          | 0          | yes  |
| `packages/gateway/tsconfig.json`                        | 0        | 0        | 0          | 0          | yes  |
| `packages/platforms/tsconfig.json`                      | 0        | 0        | 0          | 0          | yes  |
| `packages/platforms/tsconfig.test.json`                 | 0        | 0        | 0          | 0          | yes  |
| `packages/react/tsconfig.json`                          | 0        | 0        | 0          | 0          | yes  |
| `packages/run-protocol/tsconfig.json`                   | 0        | 0        | 0          | 0          | yes  |
| `packages/runtime/tsconfig.json`                        | 0        | 0        | 0          | 0          | yes  |
| `packages/sdk/tsconfig.json`                            | 0        | 0        | 0          | 0          | yes  |
| `packages/sdk/src/project/starters/tsconfig.json`       | 0        | 0        | 0          | 0          | yes  |
| `packages/skills-office/tsconfig.json`                  | 0        | 0        | 0          | 0          | yes  |
| `packages/tool-host/tsconfig.json`                      | 0        | 0        | 0          | 0          | yes  |

The one difference:

```text
scripts/ownership/types.mjs(5,62): error TS2456: Type alias 'Literal' circularly references itself.
```

`scripts/ownership/types.mjs` line 5 is the JSDoc typedef
`/** @typedef {string | Literal[] | {[key: string]: Literal}} Literal */`. A minimal probe shows
the cause is TS6's JSDoc handling, not the type: TS6 rejects that typedef in a `.mjs` file with
TS2456, but accepts the identical TypeScript alias
`type Literal = string | Literal[] | {[key: string]: Literal}` in a `.ts` file; TS7 accepts both.
So TS7 is not missing a real error here. The repository already depends on TS7 for typecheck:
`pnpm typecheck` would fail on `main` if `tsc` were TS6.

## Wall time, measured

Measured on the shared development host (20 cores, load average 89–101 from other jobs during
every run), so the absolute numbers are noisy; the ratio is consistent across runs. Builds were
cached and are not included.

| Measurement (all 28 configurations)                   | TS6 (`tsc6`) | TS7 (`tsc`) | Ratio |
| ----------------------------------------------------- | ------------ | ----------- | ----- |
| Sum of per-configuration times, one at a time         | 324.5 s      | 60.9 s      | 5.3×  |
| Serial wall, one at a time (second run)               | 344.1 s      | 77.3 s      | 4.5×  |
| Wall at 4 in parallel (CI uses `--parallel=4`), run 1 | 112.2 s      | 25.7 s      | 4.4×  |
| Wall at 4 in parallel, run 2                          | 81.3 s       | 14.2 s      | 5.7×  |

Largest single configurations: root `tsconfig.root.json` 40.9 s → 7.0 s, `apps/web` 40.2 s →
8.1 s, `packages/embedded` 31.0 s → 6.4 s.

These numbers are what CI **already gets** from TS7; they are not a speed-up still to be won by
this unit. The CI `typecheck-lint` job's ~160 s is therefore dominated by lint (TS6
typescript-eslint) and by the builds typecheck depends on, not by `tsc`.

## What remains on TypeScript 6 outside lint

- `tests/platforms/eject-typecheck.test.ts` resolves `typescript/lib/tsc.js`, i.e. TS6, and runs
  it five times (about 11 s of the root Vitest project). Moving it to TS7 is a test-suite change
  for the tests chain, and needs the same diff check on the ejected projects first.
- `tests/app-kit/run-packages.mjs` installs `typescript@npm:@typescript/typescript6@6.0.2` into
  the generated app-kit projects.

## Recommendation

- Keep typecheck on TS7 and lint on TS6, as `main` already does. Record that split where the
  toolchain is documented, since nothing in the docs says so today.
- Decide the `scripts/ownership/types.mjs` difference either way: rewrite the typedef so TS6
  also accepts it (for example, a separate `.d.ts` alias), which makes the TS6/TS7 diff 0 again,
  or accept that typecheck is TS7-only. Until then, a fall back to TS6 for typecheck would fail.
- Revisit lint when TypeScript 7.1 ships the programmatic API typescript-eslint needs.

## How to reproduce

From the repository root after `pnpm install` and a cached build:

```sh
node_modules/.bin/tsc -v    # Version 7.0.2  (typecheck and build)
node_modules/.bin/tsc6 -v   # Version 6.0.3  (the compiler typescript-eslint loads)
(cd packages/core && ../../node_modules/.bin/tsc6 -p tsconfig.json --pretty false)
(cd packages/core && ../../node_modules/.bin/tsc -p tsconfig.json --pretty false)
```

Repeat for every configuration in the table above and compare the sorted `error TS` lines.
