# Changelog — `@indx-workspace/cli`

One heading per release, newest first. Released in lock-step with `@indx-workspace/contracts`,
`sdk`, `aw` and `create`, with the same version (ADR-0082).

## 0.6.12 — unreleased

### Added

- `create` asks which features the deployment should include and accepts `--features chat,files`. Accepting the default writes no `features:` line, so the generated project is unchanged.

### Changed

- `agent-workspace doctor` says why it prints no `AW_STORAGE_URL` line for old file roots that do
  not share one folder, or for an old Azure setting that names no storage account, and shows the
  URL shape to write instead. When an S3-compatible endpoint answers but its bucket is not there,
  it advises creating the bucket or setting `AW_STORAGE_CREATE_BUCKET=true`.
- New Compose deployments run PostgreSQL 18 (`postgres:18-alpine`), and the generated `compose.yaml`
  sets `PGDATA` to the mounted volume so a deployment on its 17 pin and one on 18 keep their data in
  the same directory. `render --upgrade` still never moves `POSTGRES_IMAGE`; the deploy guide
  describes the 17 to 18 move. A PostgreSQL 17 answer to the database question is refused by name.

### Fixed

- `agent-workspace doctor` fails a local Compose project whose `.env` has no
  `SEAWEEDFS_ALLOWED_ORIGINS`, which an older CLI did not write, and prints the line to add with
  the web service's port. Before, `docker compose up` refused the project with an interpolation
  error and doctor reported nothing.

### Security

- A generated Compose project's bundled SeaweedFS now allows a browser's signed upload only from the web service's own origins, set by the new `SEAWEEDFS_ALLOWED_ORIGINS` in `.env` (`http://localhost:<port>,http://127.0.0.1:<port>`). Before, it echoed any origin back on a CORS preflight. Change the value with `PORT`, or when the web service is served on a public hostname.

## 0.6.11 — unreleased

No changes to this package. Released in lock-step with the 0.6.11 storage and Builder release.

## 0.6.10 — unreleased

### Added

- Under WSL, `create` notes on stderr when the project lands on a Windows drive (`/mnt/<drive>/…`),
  where the install and the local runtime are much slower, and suggests the Linux home instead
  (BH061-034).
- `agent-workspace doctor` gets a `storage-layout` check: how many objects each area still holds in the old per-area layout (counted up to a cap, counts only), with the advice to run the server with `AW_STORAGE_MIGRATE=adopt`.

### Changed

- `AW_STORAGE_URL` replaces `OBJECT_STORAGE_BACKEND/ENDPOINT/BUCKET/FORCE_PATH_STYLE` and `AW_*_ROOT` for new projects; old names work for one release with a warning. `create` renders it for the local-filesystem, AWS and GCP profiles and leaves it blank for Azure, where Terraform sets it; the bundled SeaweedFS, Vercel and Cloudflare profiles keep the old names until their deploy commands read the URL. `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES` is rendered blank, which keeps the 5 GiB server default.
- `agent-workspace doctor` reports the storage setting: the URL in use, the old variables with the URL that replaces them, and a failure when they disagree.
- `agent-workspace validate` probes the bucket `AW_STORAGE_URL` names and refuses the storage settings the server refuses (the URL and an old variable disagree, or the endpoint is on `AW_PUBLIC_URL`'s origin), naming variables, never values.
- Deploy targets set `AW_STORAGE_URL`: the Terraform modules for Cloud Run, Azure Container Apps and the single-VM Compose, and `agent-workspace deploy` for Vercel and Cloudflare, which now push the URL instead of `OBJECT_STORAGE_BUCKET` and `OBJECT_STORAGE_ENDPOINT`. A `.env` with the URL next to an old location variable is refused before anything runs. The Cloud Run and Azure modules take an optional `storage_signed_upload_max_bytes`. Old platform variables already set on a Vercel or Cloudflare project are not deleted; remove them once the URL is pushed.

### Fixed

- `create`, `render` and `deploy` say `docker is not installed or not on PATH` when resolving an
  image digest without docker, instead of failing with a `TypeError`; output that is not a
  manifest is reported as a missing digest.

## 0.6.9 — 2026-10-14

No changes to this package. Released alongside the install-live harness fix (#1128) so the gallery use cases are verified live against the published packages.

## 0.6.8 — 2026-10-14

### Changed

- `npm create` pins the chosen engine's packages in the generated `package.json`, and no other
  engine's (#691).
- `@aws-sdk/client-s3` and `@google-cloud/storage` are optional peers: `validate` names the one to
  install when it probes a bucket without it (#691).

## 0.6.7 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.6 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.5 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.4 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.3 — 2026-10-12

### Added

- `runtime.provider` for `driver: external` (issue #827, part of): `e2b` validates and an unknown
  provider is refused by name in the profile schema and the generated JSON Schema. Absent means
  `e2b`, which is what `external` always rendered.
- `@indx-workspace/cli/publish` publishes to Microsoft Foundry (issue #976): `az account
  get-access-token` gives the token (never printed), each agent in `project.plan.json` is read with
  `GET …/agents/<name>`, a missing or different agent gets a `POST …/versions` and an A2A endpoint
  file a `PATCH`, and nothing is sent without `--yes`. Project connections are listed as next steps,
  not created, and a `$ref` OpenAPI spec is refused. `PUBLISH_EXECUTORS` is now typed over every
  hosted platform id, so a platform without an executor fails type-checking. The Copilot Studio zip
  is written next to the export folder (`platforms/<solution>.zip`), not inside it; a zip an earlier
  run left in the folder is not removed.

## 0.6.2 — 2026-10-12

### Added

- `npm create` takes `--platform <a>[,<b>…]` and asks which agent platforms to publish to (issue
  #977, part of). An unknown platform id is a usage error (exit 2).
- `agent-workspace render` writes `AW_PUBLIC_URL` as its origin (`new URL(v).origin`) into the
  Terraform tfvars and the Helm overlay, so a trailing slash or path in `.env` no longer fails
  `terraform plan` (#1050, part of).
- `@indx-workspace/cli/publish` (issue #975, part of; ADR-0133 D11): plan-first publish executors
  for `aw platforms publish`. They spawn the vendor's CLI (`ant`, `atk`) through the same runner as
  `agent-workspace deploy`, redact every printed line, and apply nothing without `--yes`.
- `aw platforms publish` executors for Copilot Studio (`pac solution pack`; the import runs only
  with `--experimental --yes` until the agent folder schema is verified) and AWS AgentCore
  (`agentcore validate`, `deploy --dry-run`, `deploy -y`) (issue #976, part of). Microsoft Foundry
  follows.
- `aw platforms publish` executor for Gemini Enterprise: it registers the exported A2A agent card
  over REST with a `gcloud auth print-access-token` token, refuses a card that is unreachable or
  declares another A2A version, plans a `POST` or `PATCH` and sends it only with `--yes`. The token
  is concealed and never printed or put in an error. `publish/rest.ts` is the shared REST helper
  Foundry will reuse (issue #976, part of).
- `agent-workspace render` also writes `public_url` into the azure-container-apps tfvars and
  `publicUrl` into the v1 Helm overlay when `.env` carries `AW_PUBLIC_URL`; output is unchanged when
  it does not, and `aw create` never carries it (ADR-0135; #955).
- `aw deploy` and `aw render` write `public_url` into the gcp-cloudrun tfvars and `publicUrl` into
  the Helm overlay from `AW_PUBLIC_URL` / `environments.production.url`; nothing is added when it is
  unset (ADR-0135; #955, part of).
- `aw deploy` writes `AW_PUBLIC_URL` (the project's `environments.production.url`) into the
  deployment `.env`, and the Compose template forwards it to `web`, so a deployed control plane can
  serve A2A agent cards (ADR-0135; #955, part of). `aw create` output is byte-identical except
  `compose.yaml`.

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Added

- `aw deploy` to Cloudflare and Vercel with `RUNTIME_DRIVER=external` (E2B) renders
  `AGENT_WORKSPACE_TOOL_HOST_IMAGE` for the runner manager and the control plane when
  `E2B_TOOL_HOST_TEMPLATE=<template>:<build_id>` is in `.env` (#827, part of; #830, part of; #831,
  part of; #832, part of). `aw push` then stops answering `422 code_tool_needs_host` for a code tool
  there, and a run calls it in an E2B sandbox. The template must be pinned, as the runtime
  template is: an unpinned one is refused by name before anything is applied. `vercel-sandbox` and
  `cloudflare-sandbox` render nothing, so they keep the refusal (ADR-0131). Not yet run live.
  With the tool host the gateway is also given `RUNNER_MANAGER_TOKEN`: the manager's tool sandbox
  route requires it (ADR-0132).

### Fixed

- The Cloudflare entries below are for `agent-workspace deploy` on a deployment project made with
  `create-agent-workspace <dir> --cloud cloudflare`. `aw deploy` does not take `target: cloudflare`
  in `agent-workspace.yaml` yet (#831); the docs no longer say it does (BH061-013).
- `--cloud cloudflare` now writes `runtime.default: external` (E2B, `RUNTIME_DRIVER=external` and
  `EXTERNAL_PROVIDER=e2b` in `.env`) instead of `cloudflare-sandbox`, which refuses every network
  policy and so ran no session (ADR-0131 amendment; BH061-029). Set `E2B_RUNTIME_TEMPLATE` before
  `--yes`; `cloudflare-sandbox` stays available by setting it in the profile.
- A `--cloud` deployment project other than `local` now has a `package.json` that pins this CLI
  with a `deploy` script (`agent-workspace deploy .`), so `npm install && npm run deploy` works in
  it without a global install; the Vercel and Cloudflare next steps say so (BH061-058). The docs'
  upgrade example now says `aw deploy --plan` exits 3, not 2, for pending changes.
- A Vercel or Cloudflare plan without `VERCEL_TOKEN`/`VERCEL_TEAM_ID` or
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` no longer stops at "is not set": it runs no tool,
  says it read nothing from the account, and lists the projects or Workers, variables and images
  an apply would create. A plan's first line now says "Planning", not "Deploying" (BH061-027).
- `aw deploy` records the project directory that first deployed a project name beside its state
  (`~/.config/agent-workspace/deployments/<name>/project-directory`) and refuses another directory
  with the same name, which used to be told "Nothing to change" from the first project's state
  (BH061-028).
- The kubernetes target of `aw deploy` no longer requires `--infra` with a checkout of the platform
  repository: `@indx-workspace/cli` ships the Helm chart under `modules/helm/agent-workspace`,
  byte-identical to `infra/helm/agent-workspace`, and installs it in place. `--infra` still selects
  a checkout's chart instead (BH061-031).
- `aw deploy --target vercel` now refuses, before anything is applied, a `.env` with no
  `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY_ID` or `OBJECT_STORAGE_SECRET_ACCESS_KEY`
  (#830, part of; #827, part of; #832, part of). A Vercel function has no disk to keep skills on, so
  without an S3-compatible bucket every `/api/skills*` route answered 503
  `skills_runtime_not_configured` and `aw push` failed. The endpoint (R2's S3 URL) and the bucket
  stay the operator's: the deploy does not derive or create them. Not yet run live.
- `aw deploy` to Cloudflare and Vercel now refuses, before anything is applied, a deployment that
  would start a runner manager which exits 1 or a control plane without skills (#831, part of; #827,
  part of; #832, part of). With `RUNTIME_DRIVER=external` (E2B) the manager needs the template as
  `<template>:<build_id>`, which render's digest gate cannot carry in the runtime image key, so it
  is read from `E2B_RUNTIME_TEMPLATE` in `.env` and given to the manager as its runtime image. On
  Cloudflare, empty `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY` are
  refused (every `/api/skills*` route answered 503 `skills_runtime_not_configured`), the R2 bucket
  is created when `wrangler r2 bucket info` says it is missing, and a readiness timeout after
  `container exited` points at the container's log. Not yet run live.
- `aw deploy` to Cloudflare now also waits for the runner manager before it reports Applied (#831,
  part of; #827, part of; #832, part of). Setup's runtime test failed with `runner manager answered
  HTTP 503 manager_not_ready` because the deploy waited only for the control plane's `/setup`, while
  the manager Worker's container was still starting. After the control plane answers, the deploy
  polls the manager's unauthenticated `/healthz` (the `RUNNER_MANAGER_URL` custom domain when `.env`
  names one) over the same time window, and a manager that never answers 200 is an error naming the
  Worker, the URL and the last status. The control plane's runtime test also retries a
  `manager_not_ready` answer for up to 30 s with backoff before it fails with that same typed
  error. Not yet run live.
- The Cloudflare control plane now receives the R2 token's key pair as `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` too, as Compose and Helm map it (#827, part of; #831, part of; #832, part
  of). The web server's S3 adapter reads those names, so `OBJECT_STORAGE_*` alone left file storage
  without credentials. An explicit `AWS_*` in `.env` wins, and nothing is uploaded when `.env` holds
  no R2 key pair. Not yet run live.
- The Vercel gateway and manager projects no longer expect static output (#830, part of; #832, part
  of). Their build succeeded and the deploy then failed with `No Output Directory named "public"
  found after the Build completed`, because a `buildCommand` with `framework: null` makes Vercel
  look for one, and then `The Output Directory "public" is empty`. Their rendered settings now
  declare `outputDirectory: "public"` and the build command ends by writing `public/robots.txt`
  (disallow all), so the directory is not empty; the catch-all rewrite still sends every other
  path to the function. They also render an `installCommand`, `pnpm install --frozen-lockfile --filter
  "{<package>}..."`, so a part installs its own workspace closure and not nx, knip, jscpd or
  playwright. Not yet run live.
- The Cloudflare container Workers (control plane, gateway, manager) no longer answer Cloudflare's
  own HTML 500 (error 1101) (#831, part of; #832, part of). They forwarded the visitor's `https:`
  request to the container port, which speaks plain HTTP only and rejects any other scheme, and the
  rejection escaped the Worker. The forward now uses `http:`, and every other throw (environment,
  container binding, forward, Durable Object) answers a typed JSON 5xx
  (`{"error":{"code":"worker_exception","step":…}}`) that names the failing step and carries no
  environment value. The deploy's readiness report shows an HTML answer as its title, `Error NNNN`
  code and `cf-ray` rather than the first 300 characters of boilerplate. The wait polls over a time
  window (10 minutes, a request every 5 s, each cut off after 90 s) instead of a fixed number of
  attempts, so a slow first container start reaches the caller as the Worker's 503 and its reason.
- `aw deploy` to Vercel gives each platform build its function and its Root Directory (#830, part
  of; #832, part of; ADR-0126 amendment). The gateway build failed with `The pattern "api/index.ts"
  defined in `functions` doesn't match any Serverless Functions`, because the staged upload has the
  entry under `packages/gateway/` or `apps/runner/`. `deploy` now writes `api/index.js` at the upload
  root for those two parts, an ESM re-export of the package's compiled `dist/api/index.js`, and
  sets each project's Root Directory with `vercel api` (the upload root for the gateway and
  manager, `apps/web` for the control plane) instead of asking the operator to.
  It runs `vercel deploy --cwd <staged>`, which also ends the "Did you mean to deploy the subdirectory
  "deploy"?" warning. Not yet run live.
- The Vercel gateway and manager builds no longer fail with only `api/index.ts: Emit skipped` (#830,
  part of; #832, part of). `deploy` now writes a JavaScript `api/index.js` that re-exports the
  package's compiled `dist/api/index.js`, so Vercel no longer compiles TypeScript, and the scoped
  install and build select `{<package>}...`, since pnpm reads `<package>...` as the package alone and
  left the workspace packages whose `dist` the function imports unbuilt. Not yet run live.
- `aw deploy` to Vercel uploads one `--archive=tgz` of a pruned copy, not the checkout file by file
  (#830, part of; #832, part of). The checkout with its `node_modules`, `.nx` and build output is far
  past the 5000 files a free team may upload (`api-upload-free`). Each part is staged in a temporary
  directory with only what it builds: the platform package its `buildCommand` filters on, the
  workspace packages it depends on, the root workspace files, and the other packages'
  `package.json` so `pnpm install --frozen-lockfile` still matches. The frontend's `web/` is staged
  the same way. `node_modules`, `.git`, caches, build output, tests and `.env*` are never uploaded.

### Added

- `aw deploy` to Vercel writes the frontend's origin to the control plane (#830, part of; ADR-0128):
  the frontend is deployed before the control plane, and once `vercel inspect` of that deployment lists
  `https://<name>-web.vercel.app`, `AW_FRONTEND_ORIGIN` is set to it in the control-plane project, which
  adds it to the `allowedOrigins` of the surfaces it serves from production (never a draft). An
  existing value is left as it is, so a re-deploy writes nothing; anything else is not written and the output says how to list it by hand.
  Not yet run live.
- `aw deploy` to Vercel deploys the whole platform (#830, part of; ADR-0126): the model gateway and
  the runner manager as Vercel Functions in projects of their own (`<name>-gateway`,
  `<name>-manager`), the control plane pointed at their production URLs, and the project's `web/`
  Vite app as `<name>-web` with `VITE_AW_BASE_URL` set to the control plane. Each part gets only the
  variables it reads; `render` writes `deploy/vercel/{gateway,manager,frontend}.json`. The projects
  are named after the project, not the state directory. `.env` records `AGENT_WORKSPACE_VERSION`
  and `deploy` refuses a platform checkout at another release, by name. Not yet run live.
- `cloudflare` is a fifth deployment cloud (#831, part of): same profile shape, `aw validate`,
  `aw doctor` (probes `wrangler --version`) and `aw create` support, Neon or Supabase as the
  managed store, R2 through the S3 adapter, and `cloudflare-sandbox` (default, egress `none`) or
  `external` (E2B) as the runtime driver. `render` writes a Wrangler configuration and a platform
  Worker whose Cron Trigger calls `GET /api/cron/retention` with `CRON_SECRET`.
  `aw deploy` drives Wrangler through the deploy-runner seam: `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and `CONTROL_PLANE_URL` come from the environment, the token is never
  printed or passed as an argument, a missing one is refused by name, and only the two secrets the
  Worker reads (`CONTROL_PLANE_URL`, `CRON_SECRET`) go to `wrangler secret put` on stdin, put again
  on every apply so the retention Worker's next invocation reads a rotated value. Not yet run live; the control plane is not
  deployed to Cloudflare by this slice (ADR-0125).
  The next slice (#831, part of; ADR-0127) deploys the control plane: `render` also writes
  `control-plane.wrangler.jsonc` and `control-plane-worker.mjs` (the `web` image as a Container
  behind a routing Worker), and an apply runs the database migrations once with the web image
  (`docker`, so `aw doctor` now requires it), deploys the control plane, then uploads every `.env`
  value except Compose's and the image pins as its Workers secrets in one `wrangler secret bulk`
  call, JSON on stdin (a blank `OBJECT_STORAGE_ENDPOINT` becomes the R2 URL of the account). The
  control plane Worker answers 503 and starts no Container until `DATABASE_URL`,
  `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`, `BOOTSTRAP_ADMIN` and `BOOTSTRAP_ADMIN_PASSWORD` are
  all set, and restarts a running Container when the SHA-256 of its environment, kept in Durable
  Object storage, no longer matches the current secrets: that restart is how a rotation reaches it. A failed migration stops before any
  Wrangler call, and a web image on a registry Cloudflare Containers cannot pull from is refused
  by name. Not yet verified live.
  The third slice (#831, part of; ADR-0129) deploys the rest: `render` also writes
  `gateway.wrangler.jsonc`/`gateway-worker.mjs` and `manager.wrangler.jsonc`/`manager-worker.mjs`
  (the gateway and runner images as Containers behind routing Workers, the same 503-until-secrets
  and env-hash restart as the control plane), and `aw deploy --yes` pushes the web, gateway and
  runner images to Cloudflare's registry with `wrangler containers push`, tagged by digest so an
  unchanged image is not pushed again (images must be pinned by digest; a registry gate no longer
  applies). Each Worker gets only its own secrets in one bulk upload, in the order gateway,
  manager, control plane. Set `AGENT_WORKSPACE_FRONTEND` to the project's `web/` and the frontend is
  deployed as a static-assets Worker `<name>-web` built with `VITE_AW_BASE_URL`; the control plane's
  allowed origin is then exactly its `https://` workers.dev origin (`AW_FRONTEND_ORIGIN`, never a
  wildcard). Deploy now also needs `CLOUDFLARE_WORKERS_SUBDOMAIN`, `RUNTIME_DRIVER` of
  `cloudflare-sandbox` or `external`, and `CLOUDFLARE_SANDBOX_BRIDGE_URL` for the former. Not yet
  verified live.
- `vercel` is a fourth deployment cloud (#830, part of): same profile shape, `aw validate`,
  `aw doctor` (probes `vercel --version`) and `aw create` support, Neon as the managed store, and
  `vercel-sandbox` (default) or `external` (E2B) as the runtime driver. `aw deploy` drives the
  Vercel CLI through the deploy-runner seam: the token comes from `VERCEL_TOKEN` (and
  `VERCEL_TEAM_ID`), is never printed, and a missing token is refused by name. The master key
  goes into encrypted project env vars. Web gains `GET /api/cron/retention`, authenticated by
  `CRON_SECRET` and active on this target only. Not yet run live.
- `aw deploy --yes` to Vercel runs the database migrations once, then `vercel deploy --prod`
  (#830, part of): after the project and its env vars exist it runs the web image's
  `migrate.js` and `seed.js` in one `docker run` (the same path as Compose and Helm, never on a
  function cold start), and stops before deploying if that fails. The platform checkout to
  deploy is named by `AGENT_WORKSPACE_SOURCE`, and the control plane project's Root Directory is
  `apps/web`, which `deploy` sets. An env var the project already has is left as it is and its name is printed with
  the `vercel env rm` command to change it; values are never compared or printed. A plan
  (without `--yes`) always exits 2, since every apply creates a deployment. `aw doctor` now
  requires `docker` for this cloud. Not yet run live.
- `aw deploy` takes a third target, `kubernetes` (#796): `environments.production.target:
  kubernetes` installs `infra/helm/agent-workspace` with Helm (`--infra` names the checkout).
  The overlay under the deployment's state pins the four images, enables an Ingress for the
  `url` host (`AW_INGRESS_CLASS_NAME`, `AW_TLS_CLUSTER_ISSUER` choose its class and cert-manager
  issuer, and are kept between runs) and carries the project's `policy`. `AW_DATABASE_CIDR`, kept
  the same way, sets `database.cidr`; while it is unset every run warns that database egress is
  open to any address. The three Secrets stay the operator's. The chart's NetworkPolicy now lets web, the migrate Job and the runner manager reach
  DNS and PostgreSQL (`database.port`, `database.cidr`, `database.podSelector`) (#849).
- `aw deploy` to Cloud Run no longer needs `--infra`: the `gcp-cloudrun` Terraform module ships in
  the package (`modules/gcp-cloudrun`, kept byte-identical to `infra/terraform/gcp-cloudrun`
  by a test) and is written beside the deployment's state on every run. `--infra` still names a
  module checkout instead (#794).
- With `--yes`, `aw deploy` copies the release images into the module's Artifact Registry by digest
  (`docker buildx imagetools create`, then `inspect` to confirm the digest), then stops before
  Terraform and asks for `--plan`; once every copy is present, `--plan` shows the full plan and
  `--yes` deploys the copies. Without `--yes` the copies are only listed. A failed copy prints the
  exact commands and applies nothing. The module gains an `image_registry` output (#794).

- `aw deploy` to the kubernetes target passes the Helm values file `AW_HELM_VALUES` names (#854): it
  sits above the chart's own values and beneath the overlay `aw deploy` writes, so an operator sets
  `database.podSelector`, `objectStore`, `kubernetesApi.cidr` and the like without editing the chart.
  A path that is not a file is refused before anything is written.

### Changed

- `aw deploy` to a single-VM deployment writes the project's `policy` to the web service
  (`AW_DEPLOYMENT_POLICY`), so `policy.promotion.minEvalScore` gates `aw promote` on the deployment
  and the rest of the ceiling applies as in `aw dev`. A changed policy recreates web on `--yes`, a
  project with no `policy` removes the line, and the Compose template forwards the variable. A
  Cloud Run deployment receives it as the `gcp-cloudrun` module's new `deployment_policy` variable
  (default empty, no ceiling), rendered into the module's variables file (#797).
- The `gcp-cloudrun` module's Cloud SQL instance has `deletion_protection = true` and automated
  backups with point-in-time recovery on (#794).
- Host detection no longer defaults to `sandbox-runtime` (#818): that driver has no implementation,
  so a Linux host with `bwrap`, `socat` and `rg` used to be told it was sandboxed while every run
  used the unsandboxed `local` runner. The default is now Docker when the daemon answers, otherwise
  `local` with the no-isolation warning. `aw doctor` no longer asks for `bwrap`, `create` and
  `init` stop offering `sandbox-runtime`, and a v1 deployment profile that names it is refused as
  listed but not implemented.
- `create` finishes the job on a terminal (UX-D, #760): without a directory it asks `Project name`
  (default `my-agent`, replacing `my-agent-platform`; an existing directory is refused and asked
  again, and without a terminal it uses `my-agent` and says so on stderr); after writing it asks
  `Install dependencies now?` and `Start it now?` (Yes default), running the package manager from
  `npm_config_user_agent` (npm, pnpm, yarn or bun) in the project, then `<manager> run dev`.
  `--install` / `--no-install` and `--start` / `--no-start` answer them; `--yes` installs and does
  not start. Without a terminal nothing is installed or started unless a flag says so.
- `create` prints the next steps only for what was not done, in order: `cd`, install, the model
  key (PowerShell and cmd lines on Windows, `export` elsewhere), run. The `aw login` hand-off line
  is gone from its output (it stays in `aw login --help` and the docs).
- `create` asks every choice and multi setup question as an arrow-key menu on a terminal, and
  confirms the file list with a Yes/No menu defaulting to Yes; no terminal, no change (UX-A, #760).
- `create` passes a non-zero exit from the started `run dev` on as its own exit code, and the
  Windows `cd` hint single-quotes a directory containing `$` or a backtick so PowerShell keeps it
  literal (UX-D2, #760).

### Fixed

- `aw deploy` to Cloudflare no longer returns "Applied" over a control plane that cannot serve
  (#831 and #832, part of): `wrangler deploy` returns before Cloudflare starts the container, so the
  last step now polls `CONTROL_PLANE_URL/setup` until it answers 200 (up to 10 minutes) and otherwise
  fails naming the Worker, the last status and the Worker's own answer. The container Workers pass
  `enableInternet: true` to `container.start` so the server can reach its database and providers at
  boot, bound each readiness probe and the whole wait, and answer 503 with the state
  (`did not answer on port N within S s`, or `container exited (<reason>)`) instead of a hang. The
  lightweight journey reports the last status, body excerpt and network cause when `/setup` never
  answers. Not yet run live.

## 0.5.0 — 2026-10-06

Pins platform images 0.5.0 (`images-v0.5.0`, published before `packages-v0.5.0`).

### Changed

- The setup questions count in `create` and `aw init` follows the applicable questions, and the
  generated project keeps a `README.md` (FH-09, tracker #687).

## 0.4.0 — 2026-10-05

Pins platform images 0.4.0 (`images-v0.4.0`, published before `packages-v0.4.0`).

### Changed

- `create` (`src/create.ts`) takes the recommended answers when there is no terminal and no
  `--yes`, and prints one stderr line saying so; the refusal for piped stdin without `--cloud` is
  gone for the v2 project (#708). Each setup question has a flag (`--theme`, `--agent`,
  `--provider`, …) parsed and validated by the question's own answer schema, and a flagged
  question is not asked again. `create --help` is generated from the question set, and the next
  steps are three lines plus an `export` line when the model key is not in the environment.
  `aw init` takes the same flags (#722); a new project's `package.json` carries npm's
  `allowScripts`, and new projects include `evals/<agent>.yaml` (#711).
- `start` says that the embedded workspace is `aw dev`, run from a project `npm create
@indx-workspace@latest` writes, instead of pointing at a clone of the repository.

## 0.3.0 — 2026-10-04

Pins platform images 0.3.0 (`images-v0.3.0`, published before `packages-v0.3.0`).

### Added

- `@indx-workspace/cli/deploy`: `deployProjectEnvironment` takes a v2 project's `production`
  environment (`target: single-vm`) to a Compose deployment through `agent-workspace deploy`,
  keeping the bridged profile and its generated secrets at
  `~/.config/agent-workspace/deployments/<project>/<env>/` (#621). `aw deploy` loads it.
  Node.js 24, Docker with the Compose plugin and, for `--yes`, a resolvable `url` host are refused
  by name before anything is created. Web is published on `127.0.0.1:3000` behind one TLS proxy.
- `deployProjectEnvironment` also takes `target: gcp-cloudrun` with `infraDirectory` (#621). The
  module checkout, its `project_id`, Terraform, and images in Artifact Registry (an
  `AW_<NAME>_IMAGE` override or the state's pin) are refused by name before anything is created.
  A changed Owner email re-syncs the state `.env`'s `BOOTSTRAP_ADMIN` line and no other line.

- `create-agent-workspace <directory>` (`npm create @indx-workspace <directory>`) writes the v2
  project `aw dev` runs: `package.json` pinning `@indx-workspace/aw`, `embedded` and `sdk` at this
  version, `pnpm-workspace.yaml`, `.gitignore`, and the `agent-workspace.yaml`, agent and surface
  `aw init` writes (S1-16, #454). On a terminal it asks the five setup questions and confirms the
  file list; `--yes` (`npm create @indx-workspace <directory> -- --yes`) takes the recommended
  answers. It never writes a `.env` or a secret, and never writes into an existing directory.
- Generated profiles start with `# yaml-language-server: $schema=<url>`, so the VS Code YAML
  extension validates and completes `agent-workspace.yaml`. The JSON Schema is generated from the
  Zod definition `agent-workspace validate` checks with; the package ships it as
  `schema/agent-workspace.schema.json`, and the URL names that file on unpkg for this CLI's version
  (ADR-0091, #424).
- `agent-workspace render [dir] [--check]` re-renders `deploy/`, `compose.yaml` (`local`) and the
  image lines of `.env` from an edited `agent-workspace.yaml`, with the renderers `create` uses
  (ADR-0090, #422). Every other `.env` line keeps its value and place; each file is listed as
  created, updated or unchanged, and no `.env` value is printed. Images come from an
  `AW_<NAME>_IMAGE` override, else the digest `.env` already pins, else the release default, so
  re-rendering is offline. `--check` exits non-zero on drift and writes nothing.
- `agent-workspace deploy [dir] [--yes] [--target helm|terraform] [--infra <dir>]` renders, then
  prints the plan of the real tool for the profile's target — `docker compose` (`local`),
  `terraform plan` (`gcp`, `azure`) or `helm diff upgrade` / `helm template` (the chart) — and
  applies it only with `--yes`; Terraform applies the plan file it printed (ADR-0094, #430).
  Without `--yes` it exits 0 when nothing would change and 2 when something would. Tools run
  without a shell in the project directory, and every line printed is redacted of `.env` secrets
  and URL passwords.
- `agent-workspace doctor [dir] [--json]` checks the profile, the stores (the `validate` probes),
  the tools the profile's target needs on `PATH` with their versions, and the server's contracts
  version, each as pass, warn or fail with one line of advice. It exits 1 when any check fails and
  0 with only warnings, and never prints a password, token or connection-string credential (#423).
- `create` ends with the `aw login` hand-off line,
  `to share a workspace later: aw login --url <url> (reads workspaces; pushing with it is not supported yet)`,
  after `Next:`, and prints the variables `aw dev` reads before it (S2-06b, #544).

### Changed

- `create-agent-workspace` without `--cloud` now writes the v2 project instead of the Compose
  project (S1-16, #454). The Compose project is `--cloud local`, unchanged. A script that pipes
  answers into `npm create @indx-workspace <directory>` is now refused, with a message naming
  `--yes` and `--cloud local`; add `-- --cloud local` to keep the Compose project. `--yes` is
  refused with `--cloud`, and `--validate` without it.
- `create-agent-workspace` quotes a directory name in its printed hints with single quotes, so a
  copied `cd` line never runs a `$( )` or backtick command embedded in the name, and refuses a
  name holding a control character. The v2 path turns a missing parent directory or a name the
  file system rejects into a plain refusal instead of a raw `ENOENT`/`EINVAL` message.
- `agent-workspace render`, `validate`, `deploy` and `doctor` refuse a v2 `kind: Project`
  `agent-workspace.yaml` with `kind: Project is read by aw dev; render and deploy arrive with P-2`
  and the line and column of its `kind`, before any schema check or the missing-`apiVersion`
  warning; `doctor` reports it as a failed profile check (S1-16, #454).
- The profile is validated by one Zod schema instead of hand-written readers; refusals keep their
  messages and paths. Two values the readers accepted are now refused: a quoted `cloud` with
  padding (`" aws "`), and an OIDC issuer written `https:` without `//` (ADR-0091).
- `agent-workspace render` lists what it leaves in place — a `compose.yaml` or `deploy/` file the
  profile no longer renders, and `.env` image keys it no longer writes (`POSTGRES_IMAGE`,
  `SEAWEEDFS_IMAGE` off `local`, `RUNTIME_IMAGE`, `MINIO_IMAGE`) — by name only, and still deletes
  nothing (#431).
- Every `.env` reader (`render`, `start`, `stop`, `validate`, `deploy`) accepts `export NAME=value`
  and strips an inline `# comment` after whitespace from an unquoted value, as Compose does (#431).
- `agent-workspace.yaml` is read by a real YAML parser (`yaml`, core schema) instead of the
  hand-written subset reader (ADR-0089, #420). Valid YAML the subset refused, such as double
  quotes or flow mappings, is now accepted. Anchors, aliases, non-core tags, directives, duplicate
  keys and a second document are refused, and every refusal names the line and the column.
- The profile carries `apiVersion: agentworkspace.dev/v1` and `kind: Deployment`, and generated
  profiles write both. A profile without `apiVersion` is still read as v1, with a warning on stderr
  from `agent-workspace validate` (see Deprecated below); an unknown `apiVersion` or `kind` is
  refused.
- A refusal of a profile file now reads `agent-workspace.yaml line N, column M: …` instead of
  `agent-workspace.yaml: …`.
- The generated `.env` header now says `agent-workspace render` owns its image lines, and the
  skipped-overlay notice names `render` instead of "no shipped command".

### Fixed

- `agent-workspace render` replaces each file atomically (temporary file, fsync, rename), so a
  crash cannot truncate `.env`, and refuses an owned path or a directory on the way to it that is a
  symbolic link instead of writing through it (#431).
- `agent-workspace render` no longer inserts a duplicate image line next to `export WEB_IMAGE=…`,
  and no longer refuses an image pin followed by an inline comment (#431).
- `agent-workspace deploy`: `helm upgrade --install` creates the `agent-workspace` namespace on a
  first install; the Terraform plan directory is removed on `SIGINT`/`SIGTERM` too; `render`'s own
  output is redacted; and `docker compose` runs for `.env`'s `COMPOSE_PROJECT_NAME` even when the
  shell sets another one (#431).
- `agent-workspace doctor` advises running `aw dev` for a `kind: Project` file instead of
  correcting it at the line named. The `start` and `stop` refusals for a directory without a
  `.env`, doctor's advice for a missing profile and `--help` name `aw dev` for a `kind: Project`
  directory and `npm create @indx-workspace <directory> -- --cloud local` for the Compose project
  these commands operate (#496).

### Deprecated

- A profile without `apiVersion`, including one with only `kind`, is read as v1 with a warning
  through 0.2.x; 0.3.0 refuses it (ADR-0089, #425). A `kind` other than `Deployment` is already
  refused. Add `apiVersion: agentworkspace.dev/v1` and `kind: Deployment` as the first two lines.

## 0.2.1 — 2026-10-01

### Fixed

- Setup no longer keeps a rejected provider key; re-running setup repairs a connection left by
  0.2.0 (#415).
- The setup wizard's credential fields no longer invite browser autofill (#416).
- API-key callers get 404 for an `/api` path no route serves and 405 with `Allow` for a served path
  under the wrong method (previously 401) (platform images 0.2.1).
- `agent-workspace --version` prints the CLI version.
- Pins platform images 0.2.1.

### Upgrade note

Existing 0.2.0 projects: replace the image digests in `.env` (`WEB_IMAGE`, `GATEWAY_IMAGE`,
`RUNNER_IMAGE` and `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`) with the 0.2.1 ones, or
generate a new project with `@indx-workspace/create@0.2.1` and move your data across. See "Picking
up patched images in an existing project" in the CLI README. Re-running the setup wizard with a
valid key then repairs a connection that a refused attempt left behind.

## 0.2.0 — 2026-10-01

### Changed

- Lock-step minor release with `@indx-workspace/contracts` 0.2.0 (issue #393). No change to the
  CLI.

## 0.1.3 — unreleased

### Security

- Pins platform images 0.1.2, which patch the next/og remote code execution (GHSA-vcvr-r3jv-pc5j,
  next 16.3.6) and @grpc/grpc-js CVE-2026-101916. Projects generated with 0.1.0–0.1.2 should update
  their image pins (generate a new project with `@indx-workspace/create@0.1.3` and move your data,
  or replace the image digests in `.env` — see the CLI README).

### Added

- `agent-workspace stop [--volumes]`, also the generated project's `pnpm stop`: runs
  `docker compose down`, then removes the runtime sandboxes the runner started and the project's
  networks, and fails unless nothing of the project is left. Named volumes are kept unless
  `--volumes` is given (issue #394).

### Fixed

- Runtime sandboxes and the `<project>-runtime-control` network no longer outlive
  `docker compose down`. Sandboxes are labelled `agent-workspace.compose-project=<project>`, the
  runner (now given `COMPOSE_PROJECT_NAME` and a 30-second stop grace period) removes them when it
  is stopped, and `agent-workspace stop` removes any that remain, including unlabelled ones from
  earlier releases found on the project's runtime-control network (issue #394).
- Two generated projects open in one browser no longer sign each other out. Cookies ignore the
  port, and every project used the cookie `__Host-aw_session`; the template now passes
  `COMPOSE_PROJECT_NAME` to web as `AW_INSTANCE_ID`, and the cookie is
  `__Host-aw_session_<project>`. **A project that adopts the new `compose.yaml` signs everyone out
  once**: sign in again after the upgrade. A deployment that does not set `AW_INSTANCE_ID` keeps
  the old name and its sessions.
- The workspace-selection, invitation-identity and OIDC-transaction cookies are scoped the same
  way (`<name>_<project>`), so two projects cannot overwrite each other's sign-in in progress
  either. An `AW_INSTANCE_ID` too long or malformed for a cookie name is turned into a safe name
  with a short hash suffix instead of failing requests.
- `start`, `validate` and `stop` refuse a hand-edited `COMPOSE_PROJECT_NAME` that is not a Compose
  project name, is longer than 63 characters, or is `agent-workspace`, the repository's own
  development stack.

## 0.1.2 — 2026-09-30

### Changed

- Pins platform images 0.1.1 (setup wizard detects the configured runtime driver, API keys reach the agent and run routes, handlers enforce roles)

### Fixed

- `agent-workspace start` asks the Docker daemon it talks to which group owns
  `/var/run/docker.sock`, with a short-lived container of the project's pinned PostgreSQL image, and
  runs the runner in that group for the start, printing the value to record as `DOCKER_GID` in
  `.env` when it differs. The generator only reads this machine's socket, which is wrong for a
  `DOCKER_HOST`, a docker context or a VM naming another daemon, so the Docker runtime failed there
  with `permission denied` (issue #389). Native Linux and Docker Desktop get the same value as
  before. If the daemon cannot answer and the runner is then denied the socket, `start` fails,
  naming `DOCKER_GID`.
- When `docker compose up` cannot bind the web port on the Docker host (`address already in use`,
  `port is already allocated`, or Docker Desktop's `ports are not available`), `start` stops the
  services Compose had already started with `docker compose down`, keeping the data volumes, and
  fails with a non-zero exit that says to free the port or set `PORT` in `.env`.
- When the web URL is plain http at an address other than localhost, as with a remote Docker
  daemon, `start` says that browsers drop the `Secure` sign-in cookie there, and names an SSH port
  forward to localhost or HTTPS instead. The cookie stays `Secure`.

## 0.1.1 — 2026-09-30

### Fixed

- A generated `local` project is reachable: `web` also joins `web-ingress`, a non-internal network
  only it is on, so Docker publishes its port. Before, `web` sat only on the internal `control`
  network and Docker published nothing (issue #377). Like any non-internal bridge, `web-ingress`
  also gives `web` outbound (masqueraded) access, which it needs for OIDC discovery and similar
  calls; no other service gains it.
- `agent-workspace start` fails with a non-zero exit, naming the URL, `docker compose logs web` and
  `PORT`, when the web URL does not answer within two minutes of `docker compose up --wait`; it used
  to warn and exit 0. It also fails, naming the port conflict, when something that is not this
  project's web service answers there. The URL follows a `tcp://` or `ssh://` Docker endpoint:
  `DOCKER_HOST` from the shell or `.env`, else the current `docker context`.
- The Docker runtime starts in a generated project: the runtime-control network carries the
  `agent-workspace.runtime=docker-network` label the runtime driver requires, and `web` is given the
  pinned Claude runtime image as `RUNTIME_IMAGE` instead of falling back to a development tag.
- Generated projects no longer collide on one Docker host: `.env` sets `COMPOSE_PROJECT_NAME` from
  the directory name, sanitised to what Compose accepts, and the project and its runtime-control and
  provider-egress networks (and the runner's `RUNTIME_NETWORK`) are named after it, so `start`'s
  `--remove-orphans` never touches another project. Two directories with the same name share a
  project name; set `COMPOSE_PROJECT_NAME` in one `.env` to run both. `.env` documents `PORT` as the host-port
  override.
- The generated `package.json` is named after the project directory, and `create` lists
  `compose.yaml`, `package.json` and `pnpm-workspace.yaml` among the files it wrote.

## 0.1.0 — 2026-09-30

### Added

- Published to npm as `@indx-workspace/cli` with the bins `create-agent-workspace` and
  `agent-workspace` (issue #364). A generated `local` project depends on `@indx-workspace/cli` at
  the generator's own version.
- `agent-workspace --help` prints the usage.
- `start` and `validate` refuse a server whose contracts version this CLI cannot operate, naming
  the fix: upgrade the CLI, or, when the server is older, upgrade the server or downgrade the CLI
  (issue #361, ADR-0078).

### Removed

- `agent-workspace start --embedded`. The embedded, development-only workspace imports the server,
  which is not published; it runs from a clone of the repository as `pnpm start:embedded`.
