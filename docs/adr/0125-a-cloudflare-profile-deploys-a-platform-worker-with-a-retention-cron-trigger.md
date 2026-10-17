# ADR-0125 — A `cloud: cloudflare` profile deploys a platform Worker with a retention Cron Trigger

Status: accepted
Date: 2026-10-08
Decided by: the issue #831 plan (E6, slice 1), reviewed in the pull request
Scope: `DEPLOYMENT_CLOUDS` and the runtime-driver rules in `packages/cli/src/profile-schema.ts`, `packages/cli/src/profile-defaults.ts`, `packages/cli/src/render/cloudflare.ts`, `packages/cli/src/render/env.ts`, `packages/cli/src/deploy/cloudflare.ts`, `packages/cli/src/deploy/targets.ts`, `packages/cli/src/doctor/prerequisites.ts`

## Context

[ADR-0120](0120-vercel-and-cloudflare-are-deployment-clouds-with-native-sandboxes-and-e2b-is-a-sandbox-only-provider.md)
makes Cloudflare a deployment cloud: clause 7 puts the platform on Workers and Containers with
Cron Triggers for retention, clause 8 keeps the master key as a Worker secret (`local-key`), and the
sandbox is the `cloudflare-sandbox` driver (#856). The Vercel slice (#859) showed the shape: a
profile, a rendered project, and a deploy target that drives the vendor CLI through the deploy-runner
seam. What Cloudflare has that Vercel does not is no decided home for the control plane: whether web,
the gateway and the runner manager run as Containers or as Workers is open (follow-up, below).

## Decision

- `cloudflare` is a fifth `DEPLOYMENT_CLOUDS` value with the same profile shape. Relational store
  `neon` or `supabase` (direct TCP now, Hyperdrive when it is wired), objects `s3://` (R2's S3
  adapter, region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com`), secrets
  `local-key`. The runtime driver is `cloudflare-sandbox` (default) or `external` (E2B).
  `cloudflare-sandbox` leaves the unimplemented list for this cloud only and is refused by name on
  every other cloud, as `vercel-sandbox` is. Sandbox egress stays `none`; `open` and `restricted`
  are not offered here (decision on #829).
- `render` writes `deploy/cloudflare/wrangler.jsonc` and `deploy/cloudflare/retention-worker.mjs`:
  a platform Worker whose `scheduled` handler calls `GET /api/cron/retention` on the control plane
  with `Authorization: Bearer $CRON_SECRET`. That is the route and secret #859 added for Vercel Cron,
  so web does not change. The Wrangler configuration carries no name, account id or secret.
- `.env` gains `CRON_SECRET` on this cloud, `AWS_REGION=auto`, and a blank
  `OBJECT_STORAGE_ENDPOINT` that the control plane deploy (a later slice) fills from the account id.
- `deploy` is a `cloudflare` target (`--target cloudflare`, or the default for the cloud). It reads
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment only, and
  `CONTROL_PLANE_URL` (https) from the environment or `.env`; a missing one is refused by name before
  any tool runs. The token reaches Wrangler through the child's environment, never an argument, a
  log line or a rendered file, and is redacted from output. The target lists the Worker's secrets
  (`wrangler secret list`), deploys the Worker when it is absent (`wrangler deploy --config --name`),
  then puts exactly the two secrets the retention Worker reads, `CONTROL_PLANE_URL` and
  `CRON_SECRET`, with `wrangler secret put` and the value on stdin. Every apply puts the current
  values again (`put` overwrites), so a rotated `CRON_SECRET` reaches the Worker. The master key,
  the database URL and every other `.env` value never reach this Worker (least privilege, decision
  on #831); the master key goes to the control plane's Workers secrets in the control-plane slice
  (ADR-0120 clause 8). A `secret list` failure that does not say the Worker is missing stops the run.
- `doctor` probes `wrangler --version`; `create` points at the rendered configuration.

Vendor facts, checked 2026-10-08: Cron Triggers
(https://developers.cloudflare.com/workers/configuration/cron-triggers/), Wrangler commands and
configuration (https://developers.cloudflare.com/workers/wrangler/commands/workers/,
https://developers.cloudflare.com/workers/wrangler/configuration/), Wrangler environment variables
(https://developers.cloudflare.com/workers/wrangler/system-environment-variables/), R2's S3 API
(https://developers.cloudflare.com/r2/api/s3/api/).

## Alternatives

- **Pass the account id and the control plane URL as `--var`.** They are not secrets, but putting
  them in argv shows them in the process list and in `runStep`'s echo; secrets keep one path.
- **Name the Worker in `wrangler.jsonc`.** The name comes from the project directory like the
  Compose project name; `deploy` passes `--name`, so one rendered file serves every deployment.
- **Diff an existing Worker's configuration.** Wrangler has no cheap read-back of the deployed
  configuration. An existing Worker's configuration is left as it is; its two secrets are put again.
- **Upload every `.env` value to the Worker.** It would hand a retention-only Worker the master key
  and the database URL it never reads.
- **Add only the secrets the Worker lacks.** Secret values cannot be read back, so a rotated
  `CRON_SECRET` would never be applied.

## Consequences

This release does not run an agent on Cloudflare. The control plane, the gateway and the runner
manager are not deployed: the target says so on every run, and no guide claims the path works until
a live lane passes. Follow-ups under #831: the control plane runtime (Containers or Workers),
Hyperdrive wiring, migrations as a deploy step ([ADR-0122](0122-migrations-run-once-before-web-starts.md)),
a frontend Worker, run-stream and longest-run tests for this target, a secrets-gated live smoke, and
`guides/deploy-cloudflare.mdx`.
