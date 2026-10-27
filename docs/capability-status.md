# Capability status

This is generated from `docs/capabilities/status.json`; edit the JSON and run `pnpm status:render`. “Fixture-verified” is not live-provider, deployed-runtime, or human acceptance evidence.

Release verdict: **blocked**.

| Capability | Status | Release impact | Evidence |
| --- | --- | --- | --- |
| Control-plane relational state | implemented | required | `migrations`<br>`packages/core/src/db/repositories` |
| Files, Skills, and Connectors product workflow | partial | blocker | `apps/web/server/files`<br>`apps/web/server/skills`<br>`apps/web/server/connectors` |
| Durable run-event persistence and replay | implemented | required | `packages/core/src/db/schema/run-events.ts`<br>`apps/web/server/runs/store.ts` |
| Session resume lifecycle | partial | blocker | `apps/web/server/sessions`<br>`apps/web/server/runs/acceptance` |
| Provider adapters | fixture-verified | required | `docs/compatibility/providers.md`<br>`tests/providers` |
| Live provider billing, streaming, and errors | deferred | blocker | `docs/compatibility/unverified.json`<br>`tests/e2e/run.mjs` |
| Local and Docker runtime drivers | fixture-verified | required | `docs/runtime-driver-matrix.md`<br>`tests/conformance` |
| Kubernetes runtime lifecycle and isolation | partial | blocker | `packages/runtime/src/kubernetes.ts`<br>`scripts/dev-cluster/verify-chart-lifecycle.sh` |
| Managed-cloud runtime drivers | unsupported | none | `docs/runtime-driver-matrix.md` |
| Production operations controls | partial | required | `infra/helm/agent-workspace`<br>`docs/operations/runbook.md` |
| Browser and accessibility automation | partial | required | `tests/browser`<br>`.github/workflows/ci.yml` |
| Published CLI and signed release images | deferred | blocker | `infra/release` |
| Independent usability approval | deferred | blocker | `docs/walkthrough` |
| Residual-risk owner acceptance | deferred | blocker | `docs/release/security-review-0.1.0.md` |
