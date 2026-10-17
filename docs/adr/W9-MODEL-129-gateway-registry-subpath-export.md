# W9-MODEL-129 — a one-line `packages/gateway/package.json` addition for discovery

Status: accepted
Date: 2026-09-11
Decided by: W9-MODEL-129 (implementer)
Scope: `packages/gateway/package.json`

## Context

The card's Minimum implementation says model discovery must be "driven by the adapters' existing
`listModels` through `packages/gateway/src/providers/registry.ts`" — reusing
`createProviderRegistry()` rather than a third hand-rolled per-provider HTTP client (`probe.ts` in
`apps/web/server/models/` is already a second one, built by `#126` for a plain reachability check,
not for discovery). Reusing the registry is also what gets Azure's "the deployment is the model"
behaviour for free: `azure-openai.ts`'s own `listModels()` already returns exactly
`[{ id: deployment, ... }]`, so the card's "Azure's `config.deployment` treated as the single model
of that connection" needs no special-casing in this task's own code if discovery goes through the
registry.

`packages/gateway/src/providers/registry*.ts` and `packages/gateway/src/types.ts` are on this
task's `Owns:` line — but `packages/gateway/package.json` is not. That package's `exports` map
declares `"."`, `"./start"` and `"./tokens"` only; there is no subpath that resolves to
`providers/registry.ts`, so `apps/web` (which already depends on `@agent-workspace/gateway` as a
whole package) cannot `import { createProviderRegistry } from '@agent-workspace/gateway/providers/
registry'` without one. Node's package `exports` field is enforced at both runtime and by
TypeScript's module resolution, so an un-exported subpath is not merely undocumented — it fails
to resolve at all, in `next dev`, `next build` and `tsc` alike.

Two alternatives were considered and rejected:

- **Import the package's main entry (`.`) instead.** `packages/gateway/src/index.ts` composes the
  whole authenticated gateway application — `openDatabaseRoot`, `createSecretsService`,
  `createAuthenticatedGateway`, `createRouter`, `createGatewayServer`, pricing, and a `pg.Pool` of
  its own. Importing it from `apps/web/server/models/discovery.ts` to reach one function would
  drag an entire second HTTP server and a second database pool into the web process's module graph
  for a call this task never makes (`createGatewayServer`/`startGateway` are never invoked here).
  That is a far larger and less honest coupling than a one-line export addition, and it re-creates
  exactly the "edge runtime accidentally pulls in `pg`" failure mode `apps/web/instrumentation-
  node.ts`'s own header describes at length for a different subsystem.
- **Reimplement provider-specific discovery a third time in `apps/web/server/models/discovery.ts`,
  bypassing the registry entirely.** Rejected because it contradicts the card's own instruction to
  drive discovery through the registry, and because it would have to re-derive Azure's
  single-deployment behaviour by hand — logic that already exists, correctly, in
  `azure-openai.ts`'s `listModels()`, and nowhere else.

## Decision

Add one subpath to `packages/gateway/package.json`'s `exports` map:

```json
"./providers/registry": {
  "types": "./src/providers/registry.ts",
  "default": "./dist/providers/registry.js"
}
```

`types` points at the `.ts` source (cheap; erased before any bundler sees it) and `default` at the
built `dist/` output — the same split `"./start"` already uses in this file, and deliberately
**not** the same shape as `"./tokens"`, which points both `types` and `default` at source. That
difference is measured, not stylistic: `providers/registry.ts` has several sibling relative
imports of its own (`./anthropic.js`, `./azure-openai.js`, `./openai-compatible.js`,
`./openai.js`) written in the NodeNext `.js`-suffix-means-the-sibling-`.ts`-file convention, which
only resolves correctly when the *whole* module graph is reached under one moduleResolution
strategy. `run-token.ts` (behind `"./tokens"`) has no such sibling imports, so pointing it at
source cost nothing. Pointing `providers/registry.ts` at source instead of `dist/` was tried first
and **measured to break `next dev`**:

```text
⨯ ./packages/gateway/src/providers/registry.ts:15:1
Error: Module not found: Can't resolve './openai.js'
Import trace:
  Instrumentation:
    ./packages/gateway/src/providers/registry.ts
    ./apps/web/server/models/discovery.ts
    ./apps/web/instrumentation-node.ts
    ./apps/web/instrumentation.ts
```

Turbopack, resolving `registry.ts` as the target of a package's own `exports` map rather than as an
ordinary same-project relative import, did not apply the same `.js`→sibling-`.ts` mapping
`apps/web`'s own tsconfig gives its own relative imports — every `/api/**` route answered 500 the
instant `instrumentation-node.ts` loaded this module, which is exactly why `tests/auth.test.ts`
(outside this task's `Owns:` globs, and not touched to fix this) is what caught it. Pointing
`default` at the already-compiled `dist/providers/registry.js` — genuine `.js` files whose sibling
imports are genuine `.js` files — removes the ambiguity entirely, and `next dev` starts clean
against it (verified directly: `curl http://127.0.0.1:.../api/setup/runtime-detect` returns `200`
where it previously returned `500`).

This is declared as an extra glob on this task's PR body (`Owns` line plus
`packages/gateway/package.json`, with this reason), per the execution protocol's "only if
genuinely impossible" escape hatch and [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md)'s
precedent for a small, structurally-forced addition to a file no sibling task claims:

- **No Wave 9 task's `Owns:` line names `packages/gateway/package.json`.** The Wave 9 plan's
  "Shared files, assigned per wave" table does not list it at all, in any wave; this task's own
  siblings this wave (`W9-PROV-128`: `apps/web/components/models/**`,
  `apps/web/app/(shell)/admin/models/**`; `W9-FILES-132`: the files browser) do not touch
  `packages/gateway/` in any form.
- **It is additive and closed.** No existing export is changed, no existing consumer's resolution
  changes; the new subpath is inert until something imports it.
- **It does add a build-order requirement**: `packages/gateway` must be built (`pnpm --filter
  @agent-workspace/gateway build`, or the root `pnpm build`, which runs every workspace package's
  `build` topologically) before `apps/web` is started, exactly like `apps/web`'s own existing
  `@agent-workspace/core` dependency already requires (`apps/web/package.json`'s `dev`/`build`
  scripts already chain a `@agent-workspace/core` build first, for the same reason). Declared as a
  gap below rather than solved by adding a second package's build to those scripts, which is a
  composition-root change this task's `Owns:` globs do not reach.

## Consequences

- `apps/web/server/models/discovery.ts` imports `createProviderRegistry` and the small set of
  gateway types it re-exports (`ModelInfo`, `ModelCapabilities`, `RequestContext`) from
  `@agent-workspace/gateway/providers/registry`, and nothing else from the gateway package.
- A future task that needs a different gateway internal exported this same way should follow this
  precedent (a narrow, source-pointing subpath) rather than widening `"."`'s surface.

## Related

- [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) — the declared `Owns:` line
  is the boundary; a small, undisputed addition is declared rather than worked around.
- The Wave 9 plan, "Shared files, assigned per wave" — confirms no Wave 9 task claims
  `packages/gateway/package.json`.
