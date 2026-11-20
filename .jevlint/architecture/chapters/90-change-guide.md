---
title: Change guide
evidence: [AGENTS.md, ENGINEERING_GUIDELINES.md, docs/architecture.md:398-448, apps/web/server/contexts.json, apps/runner/src/engines.ts:60-65, packages/runtime/package.json, packages/core/src/storage/index.ts:69-75, apps/web/server/builder/ports.ts, migrations]
---

Read the owning component's summary and key files first; `AGENTS.md` has the same owners in short.
Every change ends with `pnpm check:fast`, `pnpm test` and `pnpm build`.

| To add or change | Change these files | Follow this rule | Run this check |
| --- | --- | --- | --- |
| A wire field, status, role or problem code | `packages/contracts/src/<area>.ts`, then the SDK resource in `packages/sdk/src/resources/` | one vocabulary, defined once in contracts; never copy it | `pnpm api:update`, `pnpm docs:check`, `tests/duplicate-vocabulary.test.ts` |
| A `/api/**` route | `apps/web/app/api/**/route.ts` calling one function in `apps/web/server/<domain>/` | `routes-are-thin`; answer through `http/route.ts` | `pnpm architecture:check` |
| A use case in a domain | `apps/web/server/<domain>/service.ts` (or `api.ts`), its `store.ts` | import only contexts upstream in `contexts.json`, and other contexts through their `index.ts` | `pnpm architecture:check`, `jevlint architecture check --static` |
| A decision rule | the domain's `core/` folder | `domain-core-is-pure`: no clock, ids, env or I/O; take them as arguments | the domain's tests, ESLint |
| A new domain with rules of its own | `core/`, `ports.ts`, `adapters/<port>/`, `transport/composition.ts`, as `apps/web/server/builder/` | one production and one memory adapter per port, one contract test run against both | the contract tests, `tests/store-conformance.test.ts` |
| Storage shape | `packages/core/src/db/schema/`, a generated migration in `migrations/` | expand/contract; `DROP`, `RENAME`, `SET NOT NULL` need `-- safe:` | `pnpm migrations:check`, `pnpm migrations:lint`, a PostgreSQL-backed test |
| A file, skill or attachment behaviour | `apps/web/server/storage/` and the domain that calls it | only the catalog service reaches object storage; row first | `resource-catalogs.contract.ts` suites, `pnpm stories:check` |
| A storage backend | `packages/core/src/storage/<backend>-store.ts`, `open.ts` | loaded only through `openObjectStore`; the bucket SDK only in that file | `packages/core/src/storage/contract.ts` suite |
| A browser screen | `apps/web/components/<area>/` with its `*-model.ts` | call `browserClient()`; never import `apps/web/server` | `raw-fetch-budget.test.ts`, `pnpm architecture:check` |
| An engine | a new `packages/engine-<id>/`, one line in `apps/runner/src/engines.ts` | one exported factory, one SDK file, no `core` import | the engine conformance kit, `tests/no-sdk-import.test.ts` |
| A runtime driver | `packages/runtime/src/<driver>.ts`, a new exports subpath, a `manager-driver-<id>.ts` in the runner | runtime imports nothing in the workspace | the driver's tests, `pnpm package-exports:check` |
| An `aw` command | `packages/aw/src/commands/`, using an SDK method | aw reaches only sdk, contracts and platforms; the CLI only via `cli-bridge.ts` | `pnpm api:update` for aw's report |
| Process-global state in web | `defineSlot` in `apps/web/server/runtime-slot.ts` | composed domain wiring belongs in `ApplicationContext`, not a slot | review |
| A new component, port or line of communication | the code, `docs/architecture.md` "Ports and adapters", and this SSOT | update the map in the same pull request | `jevlint architecture list`, `jevlint architecture check --static` |
