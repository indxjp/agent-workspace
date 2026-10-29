# Repository Instructions for Coding Agents

Before changing code, read [ENGINEERING_GUIDELINES.md](ENGINEERING_GUIDELINES.md) and
[docs/architecture.md](docs/architecture.md). Those documents are the source of truth; this file is
the short operational checklist. [llms.txt](llms.txt) indexes them together with the product and
design documents and every page of the developer docs site, in reading order — start there when
you need to find the document that covers a question. It is generated (`pnpm docs:generate`) and
gated (`pnpm docs:check`); regenerate it when you add or rename a document it lists.

## Working agreement

- Inspect the affected domain, its contracts, adapters, tests, and callers before editing. For a
  broad change, write down the risks and split the work into reviewable phases.
- Preserve unrelated working-tree changes. Never use destructive Git commands to clean a checkout,
  and never stage files outside the requested change.
- Prefer direct, behavior-preserving changes. Add an abstraction only for a stable shared concept,
  not merely because two blocks look similar.
- Keep browser code dependent on `apps/web/contracts`, never server or persistence modules. Import
  workspace packages only through their declared `package.json` exports.
- Validate untrusted HTTP, environment, persisted JSON, and provider data at the boundary. Keep
  runtime schemas and TypeScript types derived from one source where practical.
- Expected domain failures have typed, stable public codes. Infrastructure and programming failures
  remain 5xx, retain their cause for observability, and never expose raw SQL, filesystem, provider,
  URL, or credential-bearing messages.
- Do not add `any`, TypeScript or lint suppressions, non-null assertions, unbounded type assertions,
  swallowed failures, or production `console.log` calls.
- Every bug fix needs a regression test that fails for the old behavior. Test state transitions and
  public contracts rather than private call order.
- Comments explain invariants, security constraints, and non-obvious tradeoffs. Remove stale task
  history and comments that translate the code into English.

## Find the owner before editing

| You are changing…                  | Owning module                                         | Read first                                        |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| A wire field, status, role or code | `packages/contracts`                                  | [SDK structure map](docs/sdk/07-structure-map.md) |
| A use case                         | `apps/web/server/<domain>/service.ts`                 | that domain's `store.ts`                          |
| Storage shape                      | `packages/core/src/db` and `migrations/`              | the migration rules under Required verification   |
| Run execution                      | `apps/runner`, `packages/runtime`, `packages/engine*` | `packages/contracts/src/run-events.ts`            |
| UI                                 | `apps/web/components` (through the SDK)               | `apps/web/contracts`                              |

## Hexagonal rules

The components, their ports and how they talk are in
[docs/architecture.md, "Ports and adapters"](docs/architecture.md#ports-and-adapters).

1. **Lay out a new domain the way the Builder does.** A new domain with decision rules of its own,
   or an existing domain that a refactoring change restructures, gets `core/` (the rules),
   `ports.ts`, `adapters/<port>/` (a production adapter, a memory adapter and one contract test run
   against both) and `transport/composition.ts`, as in `apps/web/server/builder/`. Do not convert
   an existing domain to this layout as a side effect of another change.
2. **A core does no I/O.** Code under a domain's `core/` folder imports only that `core/`,
   `packages/contracts` and `zod`. It reads no clock, random value, environment variable, file,
   network or database; those come in as arguments. `builder-core-is-pure` checks this for
   `apps/web/server/builder/core/`. `apps/web/server/shares/core/` does not follow this rule yet;
   do not copy it.
3. **Only a store names persistence.** Only a domain's `store.ts` (and the test-only
   `resources/catalog-store.memory.ts`) imports `packages/core/src/db`
   (`domain-does-not-import-persistence`). The imports that already exist elsewhere, the composition
   root's included, are a baseline that may only shrink; a new one fails the check.
4. **The environment is read once,** in the composition root or a process's entry point, and passed
   in as typed values (ESLint `no-restricted-properties` on `process.env`).
5. **A limit is a named constant, defined once,** with a test that pins its value, like
   `BUILDER_DEFAULT_LIMITS` in `packages/contracts/src/builder.ts`.
6. **Memory adapters back tests only.** Production wires the real adapters
   (`builder-memory-adapters-are-for-tests`, `memory-catalog-store-is-for-tests`).
7. **Reach another domain through what it offers to others,** never through its `core/` or
   `adapters/` folders.
8. **Keep the map current.** A change that adds a component, a port, an adapter or a line of
   communication updates "Ports and adapters" in `docs/architecture.md` in the same pull request.

## Protocol

1. Restate the requested behaviour and the acceptance criteria you will prove.
2. Locate the owning module (table above) and its boundary rules in
   [docs/architecture.md](docs/architecture.md).
3. Confirm or define the contract (schema in `packages/contracts`, store or service interface in the
   domain) before writing code.
4. List the risks (tenant isolation, authorisation, secrets, data loss, migration) and the
   regression test that covers each.
5. Write the failing test first for bug fixes and for new behaviour at a seam. The layers and when
   each is required are in [docs/testing-strategy.md](docs/testing-strategy.md).
6. Implement the smallest correct change; no new abstraction without a second real caller.
7. Refactor only inside the files the change already touches.
8. Run the narrow checks: the named test files, the owning package's `typecheck`, and
   `pnpm architecture:check`.
9. Review your diff for unrelated changes, a new copy of a `packages/contracts` vocabulary, new
   `core/db` imports outside a `store.ts`, new `fetch('/api` in components, and
   swallowed errors.
10. Report what changed, which checks ran with counts, and which did not run and why.

Never weaken a gate, add a suppression, grow a known-violations baseline, hand-edit a generated
file, or describe a skipped check as passing.

## Required verification

Run the narrowest relevant tests while iterating. Before requesting review, run:

```sh
pnpm check:fast
pnpm test
pnpm build
```

When the environment cannot run a required service-backed check, report the missing prerequisite
and run the strongest honest subset; never describe a skipped check as passing. Database schema
changes include a generated migration and a PostgreSQL-backed regression test. When main gains a
migration while your branch has one, run `pnpm migrations:renumber` during `git merge origin/main`
instead of renumbering by hand; `pnpm migrations:check` verifies the journal.
Migrations are forward-only, so ship them expand/contract: add first, migrate readers and data, drop in a later
release. `pnpm migrations:lint` (and the PR gate) rejects `DROP`, `RENAME`, `SET NOT NULL` and
`ALTER COLUMN ... TYPE` in migrations added since the merge base unless the statement carries a
`-- safe: <reason>` comment (one per statement; `--> statement-breakpoint` separates statements).

Workflow changes must pass `pnpm workflows:check`; external GitHub Actions stay pinned to reviewed
commit SHAs. Pull requests must use `.github/pull_request_template.md`.
A diff above 3000 changed lines (generated files, marked `linguist-generated` in `.gitattributes`, excluded)
needs a `Large PR justification: <why it cannot be split>` line in the PR body.
Do not edit a `CHANGELOG.md`: add a `changes/<slug>.md` fragment ([changes/README.md](changes/README.md));
only a `release/*` branch collects them, and CI fails any other pull request that edits a changelog.

Do cheap deterministic gates before builds, service startup, browser tests, or deployment checks.
