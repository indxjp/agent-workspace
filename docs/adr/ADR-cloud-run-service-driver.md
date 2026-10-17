# ADR-cloud-run-service — `cloud-run-service` replaces `cloud-run-sandbox` for the GCP Cloud Run deployment

Status: accepted
Date: 2026-09-10
Decided by: ad hoc (deploy task, not wave-planned)
Scope: `packages/runtime/src/{driver,cloud-run,gcp-auth,index}.ts`, `apps/runner/src/{manager,manager-start}.ts`,
`docs/spec.md` §14.2/§14.4, `infra/terraform/gcp-cloudrun/**`

## Context

The goal was to deploy Agent Workspace to Cloud Run with real agent execution, not just the web
control plane. Spec §14.4 and Appendix A.7.3 already name a driver for this: `cloud-run-sandbox`,
built on `gcloud run deploy --sandbox-launcher` and an in-container `/usr/local/gcp/bin/sandbox`
CLI that creates ephemeral child sandboxes inside one warm Cloud Run instance.

That surface does not exist. Checked directly against the installed gcloud SDK (581.0.0) on
2026-09-10: `gcloud run deploy --help`, `gcloud run --help`, `gcloud alpha run --help`, and
`gcloud beta run --help` show no `--sandbox-launcher` flag and no `sandbox` command group. There is
no fallback API to reach for either — the Cloud Run Admin API v2 service/job/worker-pool resource
schemas have no sandbox-launcher field as of this date. `cloud-run-sandbox` is aspirational
spec text, not a driver that can be implemented today.

A second candidate was rejected before this one: Cloud Run **Jobs** (`gcloud run jobs execute`) run
a container to completion and exit with no inbound ingress at all. Spec §14.3's HTTP contract
(`GET /healthz`, `POST /run` → SSE, `POST /interrupt`, `POST /files`/`GET /files`, all on port 8080)
requires the control plane to call *into* the runtime — `apps/web/server/runs/launcher.ts` and
`apps/runner/src/manager.ts` both work this way for every existing driver (`docker`, `kubernetes`).
A Cloud Run Job cannot serve that contract; only a Cloud Run **Service** has a URL to call.

## Decision

Add `cloud-run-service` as a new `RuntimeDriverId` (spec §14.2, `driver.ts`), alongside
`cloud-run-sandbox` rather than replacing it — a future driver may still claim `cloud-run-sandbox`
once GCP ships that surface, and nothing here should make that harder to add later.

`cloud-run-service` deploys one private Cloud Run v2 service per session and destroys it when the
session ends — the same one-resource-per-session shape `docker.ts` (one container) and
`kubernetes.ts` (one pod) already use, just over the Cloud Run Admin API (`packages/runtime/src/cloud-run.ts`,
authenticated with Application Default Credentials via `google-auth-library`,
`packages/runtime/src/gcp-auth.ts`) instead of the Docker socket or the Kubernetes API.

Two consequences that do not apply to `docker`/`kubernetes`, both handled in
`apps/runner/src/manager.ts` rather than by weakening the driver:

1. **Auth.** `docker`/`kubernetes` runtimes sit on a network the manager already trusts implicitly.
   A Cloud Run service is a public HTTPS endpoint gated by IAM (`--no-allow-unauthenticated`), so
   every request the manager makes to it — `/healthz`, `/verify/echo`, and every proxied `/run`,
   `/interrupt`, `/files` call — now carries a Google-signed identity token scoped to that one
   service's URL (`RunnerManagerOptions.runtimeAuthHeaders`, new and optional; every existing driver
   defaults it to `{}` and is unaffected).
2. **The hardcoded `docker` check.** `manager.ts`'s `configFor` refused any `runSpec.driver` other
   than `'docker'` outright. It now compares against `RunnerManagerOptions.expectedDriver`
   (default `'docker'`, unchanged for every existing caller), so one manager process still serves
   exactly one driver — it does not become a multi-driver registry — but that one driver is a
   deploy-time choice instead of a compile-time constant.

`persistentFilesystem: false` in `CLOUD_RUN_RUNTIME_CAPABILITIES`: Cloud Run has no bind-mountable
volume. This does not require driver-level `putFiles`/`getFiles` (§14.2's optional pair) — the
manager already forwards `/files` generically to `runtimeOrigin(handle)` for every driver, so the
runtime image's own `/files` handler (already required for `aca-sessions`/`aws-agentcore`/`external`,
which have the same constraint) covers this driver too without new code.

## Known limitation: `/healthz` is unreachable on Cloud Run's default domain

Verified against a real deployment (`infra/terraform/gcp-cloudrun`, project `<project>`,
region `asia-northeast1`, 2026-09-10): the literal path `/healthz` is intercepted before it reaches
*any* container on that project's `*.a.run.app` default domain and answers with Google's own
generic edge 404 page instead. Confirmed on three independent services — the newly-created
`cloud-run-service` runtime, the always-on `runner-manager` service, and a completely unrelated
pre-existing app (`indx-test`) — while an arbitrary non-reserved path (`/foo123bar`) correctly
reaches each application's own code. The runtime container's own logs, captured in the same test,
show it actively serving `GET /healthz` on `0.0.0.0:8080` at the moment the probe was rejected — the
application side is not at fault.

Consequence: `manager.ts`'s `/verify` flow (the "Test Runtime" readiness gate, shared by every
driver) cannot succeed for `cloud-run-service` as written, because it polls exactly this path before
trying anything else. The *production* path is unaffected — `POST /runtimes` (no `/healthz` gate)
followed by a proxied `POST /runtimes/:id/run` reaches the runtime correctly and returns its real
Zod validation response, proving the create → auth → proxy → runtime round trip works end to end.
Reproduced directly:

```
$ curl https://<service>-<hash>-an.a.run.app/healthz    # → Google's generic 404 page
$ curl https://<service>-<hash>-an.a.run.app/foo123bar  # → the app's own Next.js 404
$ curl https://<service>-<hash>-an.a.run.app/healthz              # → Google's generic 404 page (unrelated app, same project)
```

Left as a declared gap rather than worked around here: fixing it would mean changing the hardcoded
`/healthz` path `manager.ts` polls for every driver (§14.3's contract), which is a cross-cutting
change affecting `docker` and `kubernetes` too, not something specific to this driver. A future task
should either confirm whether this is Cloud Run-default-domain-wide (try a custom domain mapping) or
give `/verify` a driver-supplied readiness path instead of the one hardcoded literal.

## Alternatives considered

- **Wait for `cloud-run-sandbox` to ship.** Rejected: no committed GCP timeline, and the task is to
  have a working deployment now.
- **GKE Agent Sandbox (§A.7.4) instead of Cloud Run.** A real, working primitive today, but a
  materially different infrastructure footprint (a cluster) than "deploy to Cloud Run" asked for.
  Left as a documented fallback, not built.
- **Cloud Run Jobs, treating each execution as a bounded batch run instead of an HTTP server.**
  Would require reworking §14.3's pull-not-push contract for this one driver (the runtime would
  have to phone results out instead of serving `/run`), which is a bigger, riskier change to a
  contract every other driver relies on, for a driver that would still cold-start a full container
  per turn rather than per session. Rejected in favor of Cloud Run Services, which need no contract
  change at all.
