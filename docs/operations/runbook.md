# Production operations runbook

This runbook defines the controls the repository can supply. It is not evidence that a restore,
failover, key rotation, or cluster drill has been performed. Record each real exercise in the
deployment's private operations log; never commit credentials, database dumps, or customer data.

## Service health and rollout

The Helm chart configures startup, readiness, and liveness probes for web (`/`), gateway
(`/health`), and runner manager (`/healthz`); web's readiness probe alone reads `GET /api/readyz`.
It also supplies rolling-update bounds, one
PodDisruptionBudget per workload, and optional CPU autoscaling. Enable autoscaling only when the
cluster has Metrics Server and after load testing:

```sh
helm upgrade agent-workspace infra/helm/agent-workspace \
  --reuse-values --set autoscaling.enabled=true
```

Treat a readiness failure as traffic protection and a liveness failure as a process fault. Alert on
repeated restarts and rollout deadline failures; do not use liveness to test an external provider.

`GET /api/readyz` needs no credential. It answers `200 {"status":"ready"}`, or `503` in the
standard error envelope when the deployment is misconfigured in a way the operator must fix. Today
that is one case: `MASTER_ENCRYPTION_KEY` is set but malformed (it must be 64 hex characters, from
`openssl rand -hex 32`). The server still boots, the secrets, models and connectors routes answer
`503 *_runtime_not_configured`, the boot log names the variable and the format, and the probe keeps
the pod out of service so a rollout stops. Neither the log nor the probe ever contains the value.
An unset key is not a misconfiguration: those routes answer the same `503`, and readiness passes.
Other secrets-subsystem failures at boot (an unreachable database, a cloud key backend that cannot
be read, an unknown `MASTER_KEY_PROVIDER`) keep today's behaviour and do not fail readiness. Only
the Helm chart reads `/api/readyz`. Compose and the image `HEALTHCHECK` probe `/`, the Azure
Container Apps module uses a TCP probe, and Cloud Run has no readiness probe, so on those targets
read the boot log.

Suggested initial objectives are 99.9% successful control-plane requests over 30 days, p95 API
latency below 500 ms excluding streaming bodies, and 99% of accepted runs reaching a terminal state
within their configured deadline. Tune these only from measured traffic. Page on sustained error
budget burn, database unavailability, gateway 5xx spikes, stuck runs, or exhausted storage.

## Telemetry, retention, and privacy

Configure `OTEL_EXPORTER_OTLP_ENDPOINT` (and optionally `OTEL_SERVICE_NAME`) on the web, runner and
gateway processes to export their spans to an external collector; unset, none of them starts an
OpenTelemetry SDK. The runner records one span per `/run`, the gateway one per request and one per
model call (provider, model and status only), all in the trace the request's log lines carry. The in-process
Runs projection is capped and is neither durable history nor a metrics backend. Apply bounded
retention at the collector and object store. Workspace, agent, run, and session identifiers are
operational metadata; prompts, model responses, connector payloads, secrets, tokens, and file
contents must not be log attributes. Restrict dashboards and trace access to operators.
The web, runner and gateway processes write one JSON object per line to stdout/stderr, carrying a
`traceId` where a W3C `traceparent` reached them;
[ADR-0155](../adr/0155-server-processes-log-json-lines-and-join-a-w3c-trace-for-correlation.md)
records the line format, what is redacted, and why a trace id is for correlation only.

## PostgreSQL backup and restore

Use the database provider's encrypted, point-in-time backup when available. For a portable logical
backup, run `pg_dump --format=custom` with credentials supplied out of band. Encrypt the resulting
file, record its PostgreSQL major version and application revision, and test it in an isolated
database.

Restore drill:

1. Stop writers or restore to a new isolated database.
2. Run `pg_restore --clean --if-exists --no-owner` against that database.
3. Point a disposable control plane at it and run migrations once.
4. Verify workspace isolation, agent/resource counts, run ordering, and session resume.
5. Destroy the disposable environment and record elapsed time, data-loss window, and failures.

Never call a backup usable until that drill passes. Keep at least one copy outside the primary
failure domain and test the documented retention period.

## Object storage recovery

Enable versioning and server-side encryption on the production bucket. Replicate or snapshot it to
a separate failure domain. During a restore, recover the database and object-store snapshot from a
consistent window, then verify sampled file and skill object checksums through tenant-scoped APIs.
Orphan cleanup must begin with a report-only pass.

## Secret and signing-key rotation

Store database, object-store, application, gateway-token, and encryption keys in an external secret
manager. Rotate one class at a time. Where a key protects stored ciphertext, support old and new
decrypt keys during re-encryption; never replace it in place and strand existing data. For token
signing keys, deploy verification of the old key plus issuance from the new key, wait out the
maximum token lifetime or revoke active tokens, then remove the old key. Confirm secrets do not
appear in pod specs, logs, traces, crash reports, or evidence artifacts.

## TLS, ingress, and network boundaries

Terminate TLS at an approved ingress or load balancer, redirect HTTP to HTTPS, and set the forwarded
host/protocol headers expected by origin checks. Expose only web publicly. Gateway, runner manager,
PostgreSQL, object storage, and sandbox endpoints remain private. Apply the default-deny policies
and prove denial from inside a workload; a rendered manifest alone is not enforcement evidence.

## Incident response and rollback

For credential exposure, revoke the credential first, preserve audit evidence, rotate dependent
credentials, then determine affected workspaces and runs. For a bad application rollout, pause new
runs, use `helm rollback`, wait for every Deployment, and validate health and a non-provider smoke
run. Database migrations require their migration-specific rollback or forward repair; do not roll
application binaries behind an incompatible schema.

The kind/Calico chart lifecycle scaffold is:

```sh
WEB_IMAGE=registry.example/web@sha256:... \
GATEWAY_IMAGE=registry.example/gateway@sha256:... \
RUNNER_MANAGER_IMAGE=registry.example/runner@sha256:... \
RUNTIME_IMAGE=registry.example/runtime-claude-agent-sdk@sha256:... \
scripts/dev-cluster/verify-chart-lifecycle.sh
```

It records install, rolling upgrade, rollback, and cleanup only after they succeed. Its artifact
explicitly says A.12 was not run; complete runtime conformance separately before changing the
runtime matrix to live-verified.
