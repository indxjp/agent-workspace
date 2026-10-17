# ADR-0129 — The Cloudflare gateway, manager and frontend are Workers, and `deploy` pushes their images by digest

Status: accepted
Date: 2026-10-08
Decided by: the issue #831 plan (E6, slice 3), reviewed in the pull request
Scope: `packages/cli/src/render/cloudflare.ts`, `packages/cli/src/deploy/cloudflare.ts`, `packages/cli/src/deploy/targets.ts`, the exports of `packages/cli/src/deploy/vercel.ts` the Cloudflare target reuses (the control plane reuses ADR-0128's `withDeploymentOrigin`)

## Context

[ADR-0127](0127-the-cloudflare-control-plane-is-the-web-container-behind-a-routing-worker.md)
deployed the control plane as a Container behind a routing Worker and left three things out: the
model gateway and the runner manager, the frontend, and the image push (an apply refused an image
on a registry Cloudflare does not pull from and told the operator to run `wrangler containers push`).
[ADR-0126](0126-vercel-gateway-and-manager-are-functions-and-the-manager-seals-its-handles.md) did
the first two for Vercel. This ADR closes the three for Cloudflare. It supersedes ADR-0127's
"registry gate" and "not deployed here" bullets; the rest of ADR-0127 stands.

## Decision

- **One template, three Container Workers.** The gateway (`<name>-gateway`, class `Gateway`, image
  `GATEWAY_IMAGE`, entrypoint `node packages/gateway/dist/index.js`, port 4000) and the runner
  manager (`<name>-manager`, class `Manager`, image `RUNNER_IMAGE`, entrypoint
  `node dist/manager-start.js`, port 8090) are rendered from the module that renders the control
  plane (`<name>-control-plane`, class `Web`, port 3000), so they share ADR-0127's behaviour: raw
  `ctx.container`, `max_instances: 1`, `instance_type: standard-1`, a 900 s inactivity stop, `503`
  with `Retry-After` and no Container while a required secret is unbound, and a SHA-256 of the
  start environment in Durable Object storage whose change restarts the Container. The control plane's
  rendered output is byte-for-byte what ADR-0127 pinned. `render` writes
  `deploy/cloudflare/{gateway,manager}.wrangler.jsonc` and `{gateway,manager}-worker.mjs`.
- **Required secrets per Worker.** Gateway: `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`,
  `GATEWAY_TOKEN_SECRET`. Manager: `RUNNER_MANAGER_TOKEN`, `RUNTIME_DRIVER`, `GATEWAY_PUBLIC_URL`.
- **Secrets are per Worker, one bulk upload each.** `wrangler secret bulk --name <worker>` reads a
  JSON object from stdin (ADR-0127). The gateway gets the variables it reads; the manager gets its
  own plus `CLOUDFLARE_SANDBOX_BRIDGE_URL` and `GATEWAY_PUBLIC_URL`; the control plane keeps
  ADR-0127's set plus `MODEL_GATEWAY_URL`, `RUNNER_MANAGER_URL` and `AW_FRONTEND_ORIGIN`. The master
  key and the database URL reach the control plane and the gateway only (ADR-0120 clause 8), never the
  manager, the frontend or the retention Worker.
- **Addresses are workers.dev, or a custom domain from `.env`.** A Worker is served at
  `https://<worker>.<account subdomain>.workers.dev`. The account subdomain cannot be derived from
  the token without another API call, so `deploy` reads `CLOUDFLARE_WORKERS_SUBDOMAIN`, refused by
  name when unset or not a DNS label. `MODEL_GATEWAY_URL` and `RUNNER_MANAGER_URL` in `.env` win, as
  on Vercel. The manager is told the gateway's public address as `GATEWAY_PUBLIC_URL`. Each Worker is
  `workers_dev: true`; custom domains stay the operator's.
- **The manager drives `cloudflare-sandbox` (default) or `external` (E2B).** Any other
  `RUNTIME_DRIVER` is refused by name before a tool runs; `cloudflare-sandbox` also needs
  `CLOUDFLARE_SANDBOX_BRIDGE_URL` (an https URL of the bridge Worker, which this slice does not
  deploy). Cloudflare sandbox egress declares no network policy and refuses every one (ADR-0131).
- **The frontend is a static-assets Worker.** With `AGENT_WORKSPACE_FRONTEND` set to the project's
  `web/`, `deploy` deploys `<name>-web` from a temporary configuration
  (`assets.directory: <web>/dist`, `not_found_handling: single-page-application`,
  `build: npm run build` in `web/`, `workers_dev: true`). Wrangler runs the build, with
  `VITE_AW_BASE_URL` set to `CONTROL_PLANE_URL` in the child's environment, which is how the browser
  learns the control plane's address. It holds no secret. It is deployed after the control plane.
- **The control plane allows exactly the frontend's origin.** `deploy` sets `AW_FRONTEND_ORIGIN` to
  the frontend Worker's `https://<worker>.<subdomain>.workers.dev` on the control plane only when
  there is a frontend, and never otherwise. The control plane merges it by ADR-0128's mechanism
  (`withDeploymentOrigin`, production surfaces only, never a draft), which this ADR reuses rather
  than defining its own: there is no wildcard and no second origin. No API route changes, so the authorization model is untouched. Browser
  tokens follow from `baseUrl` being the control plane and the origin being allowed.
- **Images are pushed by digest, once.** An apply requires `WEB_IMAGE`, `GATEWAY_IMAGE` and
  `RUNNER_IMAGE` pinned by digest (`name@sha256:<64 hex>`). Each is the local tag
  `agent-workspace-<web|gateway|runner>:sha256-<hex>` and, pushed, the registry reference
  `registry.cloudflare.com/<account id>/agent-workspace-<service>:sha256-<hex>`. `deploy` lists the
  registry once (`wrangler containers images list`); an image whose tag is there is not pushed
  again. Otherwise it runs `docker pull --platform linux/amd64`, `docker tag` and
  `wrangler containers push`, with the token in the child's environment only. Each Worker's
  configuration is deployed from a copy outside the project that names the registry reference
  (`main` made absolute), removed afterwards; the rendered files in the project are not rewritten.
- **Apply order.** Check the retention Worker (`secret list`), push images, migrate once
  (ADR-0127), then gateway, manager, control plane (each: `wrangler deploy`, then its bulk
  secret upload), the frontend, and last the retention Worker (ADR-0125). The gateway and manager
  are up before the control plane that calls them. A failed push or migration stops before any Worker
  is deployed. Plan mode makes no registry call and lists names, URLs and secret names, never values.

Vendor facts, checked 2026-10-08: `wrangler containers push <TAG>` and `wrangler containers images
list` (https://developers.cloudflare.com/workers/wrangler/commands/containers/), Containers run
`linux/amd64` images and are pushed to `registry.cloudflare.com/<account id>/<tag>`
(https://developers.cloudflare.com/containers/platform-details/image-management/), static assets
with `not_found_handling: single-page-application`
(https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), the
configuration `build` command (https://developers.cloudflare.com/workers/wrangler/configuration/),
workers.dev addresses (https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
`wrangler secret bulk` reading JSON from stdin
(https://developers.cloudflare.com/workers/wrangler/commands/workers/). None of it has run against
a real account; the output format of `containers images list` is matched by a tolerant substring
test on the tag, and the secrets-gated live smoke (#832) is the first run.

## Alternatives

- **One Worker with three Containers.** A single class per Worker keeps each service's secrets,
  restart and routing separate, and the master key out of the manager.
- **Derive the workers.dev subdomain from the API.** One more authenticated call and a new failure
  mode; an environment variable is explicit.
- **A wildcard or a list of origins.** The frontend is one origin; anything wider is for the
  operator to put in the profile, not for a deploy to invent.
- **Frontend on Pages, or built by `deploy`.** Workers static assets are the current product and
  Wrangler already runs the build; `deploy` does not own a package manager.
- **Push by mutable tag, or always push.** The digest tag makes "already pushed" a string test and
  an unchanged deploy a no-op.
- **Rewrite the rendered configuration with the registry reference.** A deploy would change
  files the operator may have edited; a temporary copy does not.

## Consequences

An apply now deploys up to five Workers and pushes up to three images. The runner manager is
stateful in memory, so the 900 s idle stop loses its allocation table (a run longer than that on
`cloudflare-sandbox` needs the bridge to outlive it); a Container instance type is `standard-1` for
all three. The bridge Worker, `cloudflare` as an `environments.*.target`, a custom domain for the
frontend origin, diffing an existing Worker's configuration, a Dockerfile entry that skips migrate
and the 885 s limit remain follow-ups, as do the live smoke (#832) and the guide. `npm run build`
assumes npm and an installed `web/`.
