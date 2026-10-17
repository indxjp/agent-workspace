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

## Required verification

Run the narrowest relevant tests while iterating. Before requesting review, run:

```sh
pnpm check:fast
pnpm test
pnpm build
```

When the environment cannot run a required service-backed check, report the missing prerequisite
and run the strongest honest subset; never describe a skipped check as passing. Database schema
changes include a generated migration and a PostgreSQL-backed regression test.

Workflow changes must pass `pnpm workflows:check`; external GitHub Actions stay pinned to reviewed
commit SHAs. Pull requests must use `.github/pull_request_template.md`, contain exactly one
`## Ownership` section, and keep `Owns globs:` on one physical line covering the complete diff.

Do cheap deterministic gates before builds, service startup, browser tests, or deployment checks.
