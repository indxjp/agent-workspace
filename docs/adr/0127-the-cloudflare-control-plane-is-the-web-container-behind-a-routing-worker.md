# ADR-0127 — The Cloudflare control plane is the `web` image as a Container behind a routing Worker

Status: accepted
Date: 2026-10-08
Decided by: the issue #831 plan (E6, slice 2), reviewed in the pull request
Scope: `packages/cli/src/render/cloudflare.ts`, `packages/cli/src/deploy/cloudflare.ts`, `packages/cli/src/deploy/targets.ts`, `packages/cli/src/doctor/prerequisites.ts`, `hostRunLimitMs` in `apps/web/server/composition/config.ts` and the launcher wiring in `apps/web/server/composition/register.ts`

## Context

[ADR-0120](0120-vercel-and-cloudflare-are-deployment-clouds-with-native-sandboxes-and-e2b-is-a-sandbox-only-provider.md)
clause 7 puts the Cloudflare platform on Containers behind Workers, and
[ADR-0125](0125-a-cloudflare-profile-deploys-a-platform-worker-with-a-retention-cron-trigger.md)
left the control plane's home open and deployed only the retention Worker. The `web` image is a
Next.js server that holds the run's stream consumer in its own process, serves long streams and needs
Node APIs (`pg`, `node:crypto`, the S3 client). It is not a Worker bundle.

## Decision

- **Containers, not Workers.** The control plane is the existing `web` image, run as a Cloudflare
  Container and fronted by a rendered routing Worker. No OpenNext build and no second artefact: the
  image the other clouds run is the image this one runs. `render` writes
  `deploy/cloudflare/control-plane.wrangler.jsonc` and `deploy/cloudflare/control-plane-worker.mjs`
  next to ADR-0125's retention files. The configuration names one Container class (`Web`,
  `max_instances: 1`, `instance_type: standard-1`) backed by a Durable Object of the same name, with
  the image reference from `.env` (`WEB_IMAGE`). One instance is deliberate: the run consumer, the
  in-process launch map and the SSE streams live in one process, as in a single Compose `web`.
- **Raw `ctx.container`, no npm package.** The Worker module uses the Durable Object container API
  directly (`start`, `getTcpPort`, `monitor`, `setInactivityTimeout`). A generated project has no
  `node_modules`, so `@cloudflare/containers` could not be resolved; the module is a single file
  Wrangler bundles as it is.
- **A cold start never migrates.** The Worker starts the Container with an entrypoint override,
  `node /srv/apps/web/node_modules/next/dist/bin/next start`, which skips the image's `CMD` and with
  it the migrate step (ADR-0120 clause 7, ADR-0122). A request that arrives while the Container
  boots is answered `503` with `Retry-After: 5` once it has waited 60 s for port 3000.
- **Migrations are a deploy step.** `deploy` runs `docker run --rm -e <NAME>... <WEB_IMAGE> sh -c
  'node .../migrate.js && node .../seed.js'` before any Wrangler call, the same entry and the same
  Postgres advisory lock as Compose's `migrate` service and the Vercel target (#863, C2's migrate-once
  path, #848). `DATABASE_URL` and the seed values reach the `docker` child through its environment;
  `-e NAME` puts only names in argv. A failing migration stops the deploy before the control plane is
  touched, so the live deployment keeps the schema it has. The migration therefore needs `docker`
  (`doctor` requires it for this cloud) and the operator's Docker login to the image's registry.
- **Idle stop 900 s, run limit 885 s.** The Worker calls `setInactivityTimeout(900 s)` on every
  request and exports `AW_CONTAINER_IDLE_STOP_SECONDS=900` into the Container. `hostRunLimitMs`
  reads it: the host run limit is that value less the 15 s margin the Vercel limit also keeps for the
  best-effort `/interrupt`, so 885 s. The launcher refuses a profile deadline beyond it with
  `run_deadline_exceeds_host` before it contacts the runtime, and cuts a run with no deadline off at
  it. A malformed or missing value is no limit. An inactivity timeout, not an alarm: it is one call
  and the platform stops the Container for us.
- **Runs outlive the starting request in the Container's process.** The launcher's detached
  consumer keeps running after the request that started it returns, because the process stays up.
  `keepAlive` (`after()`) stays Vercel-only; a Container needs the limit and nothing else.
- **Postgres by direct TCP, no Hyperdrive.** The Container reaches the managed Neon or Supabase
  store with `DATABASE_URL` over TCP (ADR-0120 LC7). Hyperdrive is a Workers binding the Next server
  in a Container cannot use.
- **R2 through the S3 adapter.** The control plane's `OBJECT_STORAGE_*` settings are the ones
  ADR-0125 renders. A blank `OBJECT_STORAGE_ENDPOINT` becomes
  `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com` at deploy (region `auto`); an endpoint
  already in `.env` wins.
- **Secrets live on the control plane Worker only.** Every non-empty `.env` value except
  Compose's own keys (`COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES`, `DOCKER_GID`, `PORT`) and the
  image pins is uploaded in one `wrangler secret bulk --name <worker>-control-plane` call, a JSON
  object `{"NAME": "value", ...}` on stdin, again on every apply; no value is in argv or the log.
  The Worker forwards its string bindings into the Container's environment. The master key and the
  database URL go to this Worker and never to the retention Worker, which still gets
  `CONTROL_PLANE_URL` and `CRON_SECRET` and nothing else (decision on #831). The token and account
  id reach Wrangler through the child's environment only.
- **No Container without its secrets.** Before `container.start` the Worker checks that
  `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`, `BOOTSTRAP_ADMIN` and
  `BOOTSTRAP_ADMIN_PASSWORD` are non-empty bindings. While one is missing it answers `503` with a
  fixed message (`The control plane is not configured yet`, `Retry-After: 30`) and starts nothing,
  so the window between the first `wrangler deploy` and the secret upload never boots a
  misconfigured server, whatever the order.
- **A rotation restarts the Container.** A Container reads its environment only when it starts, so
  uploading a secret alone does not reach a running one. The Worker computes a SHA-256 over the
  environment it passes to `container.start`, keeps it in Durable Object storage, and on every
  request compares it with the hash of the current bindings; when they differ it `destroy()`s the
  running Container and starts it with the new environment. The check runs inside
  `blockConcurrencyWhile`, so concurrent requests restart it once. Neither the values nor the hash
  input are logged.
- **Deploy order** (apply): `secret list` of the retention Worker, the migration, `wrangler deploy`
  of the control plane, its one bulk secret upload, then ADR-0125's retention flow. Plan mode lists secret names,
  never values, and needs neither `DATABASE_URL` nor an image on a supported registry. An apply
  refuses by name, before any tool runs, an empty `DATABASE_URL` or `BOOTSTRAP_ADMIN`.
- **A registry gate.** Cloudflare Containers pull from `registry.cloudflare.com`, Docker Hub, AWS
  ECR and Google Artifact Registry, not GHCR. An apply refuses a `WEB_IMAGE` on another registry,
  naming `wrangler containers push` and `AW_WEB_IMAGE`. `deploy` does not push images itself.
- **The gateway and the runner manager are not deployed here.** Their Containers and addressing are
  a follow-up; `.env` keeps `MODEL_GATEWAY_URL`, `RUNNER_MANAGER_URL` and `RUNNER_URL` blank for the
  operator (ADR-0125), and the deploy says so on every run.

Vendor facts, checked 2026-10-08: Containers overview and the Durable Object container class
(https://developers.cloudflare.com/containers/, https://developers.cloudflare.com/containers/container-class/),
image management and supported registries
(https://developers.cloudflare.com/containers/platform-details/image-management/), Wrangler
`containers` configuration (https://developers.cloudflare.com/workers/wrangler/configuration/),
`wrangler secret put` reading stdin and `wrangler secret bulk` reading a JSON object from stdin
when no file is given (https://developers.cloudflare.com/workers/wrangler/commands/workers/),
`ctx.container`'s `start`, `running` and `destroy()`, which resolves once the Container has stopped
(https://developers.cloudflare.com/durable-objects/api/container/),
R2's S3 API (https://developers.cloudflare.com/r2/api/s3/api/). None of it has run against a real
account; the secrets-gated live smoke (#832) is the first run.

Superseded in part by [ADR-0129](0129-cloudflare-gateway-manager-and-frontend-workers-with-digest-addressed-image-push.md):
the registry gate and "not deployed here" bullets above no longer hold. `deploy` pushes the images
itself and deploys the gateway, the manager and the frontend.

## Alternatives

- **Workers with OpenNext.** A second build target, Node-compat limits on the streams and the
  Postgres driver, and a run consumer that cannot outlive a request without Durable Objects. ADR-0120
  already chose Containers.
- **`@cloudflare/containers`.** It wraps the same API, but a generated project cannot install it.
- **Migrate on cold start.** The Container restarts after every idle stop; ADR-0120 clause 7 and
  ADR-0122 rule it out, and two instances would race the lock.
- **A Durable Object alarm for the idle stop.** More code than `setInactivityTimeout` for the same
  effect.
- **Hyperdrive.** A Workers binding; the Container connects by TCP (LC7).
- **Push the image from `deploy`.** It needs a Docker build context and a Cloudflare registry login
  the CLI does not own; the gate names the command instead.

## Consequences

An apply now does what the output says: migrate, deploy the control plane, upload its secrets; the
first request after a rotation pays a Container restart. It is
not a working agent platform on Cloudflare yet: the gateway, the runner manager and the frontend
Worker are missing, and nothing has run on a real account, so no guide describes the path
(issue #831, AC3 and AC4). The 900 s idle stop caps a run at 885 s; a longer one needs a different
design. An existing Worker's configuration is deployed again on every apply and is not diffed.
