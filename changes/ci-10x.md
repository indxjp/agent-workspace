---
changelog: platform
section: Changed
---

- Next.js is 16.4.6 in the web app, the app kit, embedded and the examples, and the app kit
  template pins it, so a generated app no longer ships Next.js 16.4.3 (GHSA-mfr8-8qww-v76h,
  GHSA-vc7v-qv4w-wrv8).
- CI runs only what a change reaches. A `plan` job asks `nx affected` (task-based, with
  `production` and `code` inputs) which of build, typecheck and lint, and which test shards, a
  pull request or merge-queue group needs, and `CI success` accepts a skipped job only where the
  plan said so. The root `tests/` tree is split into Nx projects with declared inputs
  (`pnpm test-inputs:check`), its files run in parallel except the two `next dev` suites, and
  the assertions about the committed tree moved into `pnpm docs:check` and the new
  `pnpm policy:check`. ADR-0053 Amendments 2026-11-19 to 2026-11-19f record each step and where
  every moved or removed test's guarantee remains.
- Main's push, the nightly, merge-queue groups and same-repository pull requests may write the Nx
  remote cache; fork pull requests stay read-only (ADR-0110 Amendment 2026-11-19). The cache
  server must be redeployed after this change merges (docs/40-operate/operations/ci.md, "Remote
  cache rollout"). The server's own defaults stay main-only; `infra/nx-cache/deploy-gcp.sh` sets
  the wider policy and refuses to unless the repository's fork pull request settings are off.
- The Isolation kind lanes and dependency audit leave the pull request, journey-live, Helm and
  internal checks run only under their paths, and Dependabot opens grouped updates weekly. A
  weekly `ci-budget.yml` holds CI minutes and wall clock to the budget in
  `docs/40-operate/operations/ci-budget.md`, measured by the new
  `node scripts/ci/metrics/report.mjs`.
