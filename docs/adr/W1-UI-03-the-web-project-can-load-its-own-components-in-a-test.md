# W1-UI-03 — `apps/web` gets a Vitest config, because otherwise no test can import a component

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-03 (UI)
Scope: `apps/web/vitest.config.mjs`

## Context

This task's acceptance criterion is "a test asserts the home route renders it after the first
message". Written and run, that test fails before its first assertion:

```text
Error: Failed to parse source for import analysis because the content contains invalid JS syntax.
If you use tsconfig.json, make sure to not set jsx to preserve.
  Plugin: vite:import-analysis
  File: apps/web/components/composer/home-chat.tsx:179:13
```

`apps/web/tsconfig.json` sets `"jsx": "preserve"`, which is correct and required — Next.js compiles
the JSX itself. Vite reads that setting and honours it, so it hands a `.tsx` file to the JavaScript
parser with its JSX intact. Every `.tsx` file under `apps/web` is therefore unimportable from a
Vitest test, and has been since W1-UI-01 wrote the first component. The existing tests in
`components/shell` and `components/composer` do not hit this because they test `.ts` modules only:
`navigation.ts`, `identity.ts`, `model.ts`. Three UI tasks have now shipped components that no test
has ever loaded.

Vitest 4 runs on Vite 8, whose transform is Oxc rather than esbuild, so the option is `oxc.jsx`
and not the `esbuild.jsx` an older answer would reach for — that was tried first and silently did
nothing.

## Decision

Add `apps/web/vitest.config.mjs`, setting one option and nothing else:

```js
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } } });
```

Three details are deliberate.

**It sets one option.** The root `vitest.config.ts` supplies `projects` and `passWithNoTests`; a
project config that restated them would be a second place for them to disagree. That the collected
test list is unchanged is checked rather than assumed — `pnpm vitest list` produces byte-identical
output with and without this file (600 tests, `diff` clean).

**It is `.mjs`, not `.ts` or `.mts`.** `apps/web/package.json` has no `"type": "module"`, because
Next.js reads that manifest; a `.ts` config is therefore loaded as CommonJS and Vite warns about ESM
syntax in it on every run. `.mts` avoids the warning but fails `pnpm lint`, because
`eslint.config.mjs` lists `allowDefaultProject: ["vitest.config.ts"]` and the type-aware service
refuses a file no tsconfig includes. `.mjs` is the one extension that is silent in both gates.

**It changes tests only.** `next build` and `next dev` read `tsconfig.json`, which is untouched.

## Alternatives considered

- **Add jsdom and a React testing library.** Rejected under §40, and it is the larger change: two
  devDependencies plus a setup file, to reach assertions that are all about *markup* — which screen
  was produced, and whether a `<details>` carries `open`. `react-dom/server` is already a dependency
  of `apps/web` and renders the real component tree. The cost of not adding them is that the test
  cannot press a button; see the Consequences.
- **Edit `apps/web/tsconfig.json` to `"jsx": "react-jsx"`.** Rejected: it is a second out-of-glob
  file, it is W1-UI-01's, and it changes what `next build` compiles in order to fix a test.
- **Add the option to the root `vitest.config.ts`.** Rejected: it would apply Oxc's JSX transform to
  every workspace member including `packages/*` and `apps/runner`, to solve a problem only
  `apps/web` has, and the root config belongs to W0-INF-01.
- **Assert rule 5 purely by reading source text and skip rendering.** Rejected as the primary
  mechanism: a regex over a file is not evidence that a component renders anything. Source-derived
  assertions are kept, but for the property that genuinely is about the repository — that no second
  chat implementation exists — rather than as a substitute for rendering.

## Consequences

- Every `.tsx` under `apps/web` becomes testable. That is the point, and it is also a standing
  invitation: nothing yet requires a component to have a test, and this file removes the excuse that
  was previously true.
- `renderToStaticMarkup` runs no effects and cannot dispatch a click. The transition is therefore
  asserted in two halves — the reducer is driven directly, and the component is rendered with
  exactly the value it produces — with the remaining link (that **Send** calls that reducer) covered
  by a source-derived assertion. This is stated in the PR's Declared gaps rather than presented as a
  full interaction test.
- One more config file exists in the repository. It carries its whole reason in its header, because
  the failure it prevents reads as a syntax error in an unrelated file and would otherwise cost the
  next person the same hour.
