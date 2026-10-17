# ADR-0120 — Vercel and Cloudflare are deployment clouds with native sandboxes, and E2B is a sandbox-only provider

Status: accepted
Date: 2026-10-07
Decided by: the product owner (Track E shape, tracker #780; issue #826 E1)
Implementer defaults (open for the Owner, 2026-10-07): the three drivers call their providers over REST with `fetch`, not through vendor SDKs; `cloudflare-sandbox` is the runtime image on Cloudflare Containers behind a bridge Worker; `restricted` stays refused on `cloudflare-sandbox` until E4 proves enforcement and on `external` with `provider: 'e2b'` until E7's live lane proves the always-denied list holds; the longest run on Vercel is the function's maximum duration; the provider key always comes from a runtime connection, also locally.
Scope: `packages/runtime` (`external` with `provider: 'e2b'`, `vercel-sandbox`, `cloudflare-sandbox`), `apps/runner`, `apps/web`, `packages/gateway`, `packages/cli` (`DEPLOYMENT_CLOUDS`, driver list), `aw deploy`; amends spec §14.4

## Context

Today a deployment needs a Docker host, a Kubernetes cluster or a cloud project with Terraform
(Cloud Run, ACA). The Owner decided on 2026-10-07 that **Vercel** and **Cloudflare** become
deployment clouds next to GCP, AWS and Azure (`DEPLOYMENT_CLOUDS` in
`packages/cli/src/profile-schema.ts:21` is `aws`, `gcp`, `azure`, `local` today). Each brings its own
native sandbox, as Azure brings ACA Sessions and GCP brings Cloud Run: **Vercel Sandbox**
(`vercel-sandbox`) and **Cloudflare Sandbox** (`cloudflare-sandbox`). **E2B** is the one
sandbox-only provider: the `external` driver with `provider: 'e2b'`, usable from every cloud. The
goal is the whole agent app on these hosts, not only sandboxes.

Nothing exists yet. `RuntimeDriverId` has `external` and neither new id
(`packages/runtime/src/driver.ts:59-70`); the web UI says "None registered"
(`apps/web/components/runtimes/model.ts:90-95`). Spec §14.4 (`docs/spec.md:798-812`) lists
`external` as the one row for "E2B, Daytona, Modal, Vercel, Cloudflare" and §14.4 (`docs/spec.md:864-868`)
says one driver is selected by a `provider` field, with no package per vendor and no vendor SDK type
past the driver boundary. The Owner's shape makes two of those vendors native drivers, so **this ADR
amends spec §14.4**; E3 and E4 own the `docs/spec.md` edit.

Several decisions cut across the runtime, the gateway, ADR-0117's egress model and ADR-0118's tool
sandbox, so they are settled once, here. This ADR decides what and where, not API shapes; the unit
named in each clause owns those.

**Vendor facts change often.** Each is written as `(source, checked 2026-10-07)`. Where a page
disagreed with the issue's plan the page won; the differences are stated in the clause that uses
them. A later unit that relies on a fact re-opens its source and dates the new check.

The clauses are named `LC1`–`LC10` (Track E cloud) so they cannot be confused with the `SD` clauses
of ADR-0113 or the `TS` clauses of ADR-0118. A later unit cites one of them.

## Decision

**Vercel and Cloudflare are deployment clouds. Each has one native sandbox driver. E2B is reached
through `external`. All three call their provider over REST, reach the sandbox over HTTPS with a
per-sandbox credential, and enforce network policy only where the provider can also deny CIDRs.**

### LC1 — Driver shape (E2, E3, E4)

- Two native drivers, `vercel-sandbox` and `cloudflare-sandbox`, join `RuntimeDriverId` next to
  `aca-sessions` and `cloud-run-service`. The `external` driver takes a `provider` field; `e2b` is
  the first value, and Daytona and Modal use the same seam later. `DEPLOYMENT_CLOUDS` gains
  `vercel` and `cloudflare`.
- The three share one internal HTTPS forwarder with per-sandbox credentials: the `runtimeOrigin` and
  `runtimeAuthHeaders` seam that `cloud-run-service` already uses
  (`apps/runner/src/manager-start.ts:211-242`; `runtimeOrigin` is `handle.externalId`, readiness is
  `/ping`). E2 builds it; E3 and E4 reuse it. Each driver is added to `SERVED_RUNTIME_DRIVERS`
  (`apps/runner/src/manager-start.ts:244`) when it is implemented.
- Each provider is called through its **REST API with `fetch`, not a vendor SDK**. The six vendor
  packages stay on `denyByName` (`docs/dependency-policy.md` §6, `scripts/check-licenses.mjs`), so
  dependency-policy §6.3 and §6.4 need no change, and no vendor type is near the driver boundary.
  The REST surfaces used are `POST https://api.e2b.app/v2/sandboxes` with an `X-API-Key` header
  ([E2B create-sandbox](https://docs.e2b.dev/api-reference/sandboxes/create-sandbox-v2), checked
  2026-10-07) and Vercel's `/v2/sandboxes/{name}` family
  ([Vercel Sandbox REST](https://vercel.com/docs/rest-api/sandboxes/), checked 2026-10-07). The
  Vercel REST reference lists more than one create-endpoint version (`/v2`, `/v3`, `/v4`); E3 pins
  the one it implements and dates the check.
- This ADR records the D-09 decision (the development plan, default "external not
  offered") as **flipped to "offered"** for these providers. It does not remove a `denyByName`
  entry. Removing one would be a separate D-09 decision (dependency-policy §6).
- A driver's `RuntimeCapabilities` are the tables below. A capability a provider cannot enforce is
  declared unsupported and refused by name, never passed by weakening a test (spec §14.5).

**Rejected:**

- **Vendor SDKs** (`e2b`, `@vercel/sandbox`, `@cloudflare/sandbox`). Each needs a `denyByName`
  removal and a D-09 record, and puts vendor types next to the boundary that spec §14.4 keeps
  clear. REST costs hand-written clients with fake-server tests, which is more code and no policy
  change.
- **A package per vendor.** Spec §14.4 forbids it.
- **Everything under `external`.** It contradicts the Owner's cloud-native shape and would give
  Vercel and Cloudflare no deployment cloud.

### LC2 — Image (E2, E3, E4)

The §14.3 runner server image (`runtime.Dockerfile`, one engine per image,
`packages/runtime/src/engine-images.ts`) reaches each provider unchanged. Today production requires
a digest (`requireDigest: NODE_ENV === 'production'`, `apps/runner/src/manager-start.ts:224`). What
replaces the digest differs:

- **E2B.** A template built from the runtime image with `fromImage()` or `fromDockerfile()`
  (no multi-stage builds) is pinned as `<template>:<build_id>`; E2B documents no OCI digest
  ([E2B base image](https://docs.e2b.dev/template/base-image), [E2B template tags](https://docs.e2b.dev/template/tags),
  checked 2026-10-07). The build id replaces the digest pin, and `requireDigest` becomes "require
  a build id" for this provider.
- **Vercel.** A custom OCI image (`linux/amd64`) is pushed to Vercel Container Registry and pinned by
  `@sha256`, so the digest pin is kept. The image's `ENTRYPOINT` and `CMD` are **not run**, so the
  driver starts the runner server with an explicit command
  ([Vercel Sandbox images](https://vercel.com/docs/sandbox/concepts/images), checked 2026-10-07).
- **Cloudflare.** The same image is pushed to a registry Cloudflare Containers accepts
  (`registry.cloudflare.com`, Docker Hub, ECR or Artifact Registry;
  [Cloudflare image management](https://developers.cloudflare.com/containers/platform-details/image-management/),
  checked 2026-10-07) and run as a **Cloudflare Container** behind a bridge Worker (E4,
  `infra/cloudflare/sandbox-bridge/**`). The bridge uses the Containers `Container` class, **not**
  `@cloudflare/sandbox`: the runner server already provides exec and files, so the Sandbox SDK's
  base image (`FROM cloudflare/sandbox`, whose version is tied to the npm SDK, 0.x;
  [Cloudflare Sandbox Dockerfile](https://developers.cloudflare.com/sandbox/configuration/dockerfile/),
  [architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/), checked
  2026-10-07) is not needed. The driver id stays `cloudflare-sandbox`, the Owner's name. Instance
  sizes run from `lite` to `standard-4` (4 vCPU, 12 GiB, 20 GB;
  [Cloudflare Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/),
  checked 2026-10-07), which bounds `cpu`, `memoryMb` and `diskMb` in the run spec.

**Rejected:**

- **A Vercel "bootstrap" on a managed Node image.** No pin, and a slow start while the runner is
  installed.
- **Vercel snapshots as the pin.** Snapshots expire 30 days after last use
  ([Vercel Sandbox persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes),
  checked 2026-10-07), so a pin that outlives that would break.
- **The Cloudflare Sandbox SDK base image.** It brings the denied package and version coupling.
- **Dropping the pin on a provider that has none.** The build id is the pin there.

### LC3 — Reachability (E2, E3, E4, E5, E6)

- **Manager → sandbox** goes over HTTPS to the provider URL with a **per-sandbox bearer**, the
  `cloud-run-service` pattern. The bearer is minted by the manager, injected when the sandbox is
  created, and required by the runner server on every call. It is mandatory on all three providers,
  and the provider's own port access control is used in addition where one is documented.
  - E2B: `getHost(port)` returns `https://PORT-ID.e2b.app`; `allowPublicTraffic: false` restricts the
    port to callers that send the `e2b-traffic-access-token` header, and the create response
    returns `trafficAccessToken` ([E2B public URL](https://docs.e2b.dev/network/public-url),
    [E2B restrict public access](https://docs.e2b.dev/network/restrict-public-access), checked
    2026-10-07).
  - Vercel: `sandbox.domain(port)` exposes a public URL, up to 15 ports
    ([Vercel Sandbox concepts](https://vercel.com/docs/sandbox/concepts),
    [pricing and limits](https://vercel.com/docs/sandbox/pricing), checked 2026-10-07). Access control
    on an exposed port is not documented in the pages checked, so the bearer is the only control.
  - Cloudflare: the bridge Worker requires a manager → bridge secret and the per-sandbox token. The
    architecture page for the Sandbox SDK does not describe its preview-URL token in enough detail
    to rely on ([Cloudflare Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/),
    checked 2026-10-07), and this design does not use it.
- A manager that keeps no allocation table (LC7, Vercel) must be able to re-derive the bearer from
  the sandbox name, for example as an HMAC under a manager secret, or receive it from its caller.
  E5 decides which.
- **Sandbox → gateway** goes over public HTTPS with the existing per-run gateway token (default
  `GATEWAY_TOKEN_TTL_SECONDS` 300, range 1–3600). `MODEL_GATEWAY_URL` (`apps/web/server/gateway/issuer.ts:39`)
  is an internal URL in Compose and stays one. The gateway gains a **separate, sandbox-facing public
  URL setting** (proposed name `GATEWAY_PUBLIC_URL`; E2 and E5 decide the final name), TLS from the
  host platform, and per-token rate limits. The driver always allows the gateway host (LC4).
- **What stays private:** the admin API, the runner manager, Postgres and the object store are not
  routable from a sandbox. The sandbox holds only its own per-run token (ADR-0113).

**Rejected:**

- **Private networking or VPC peering.** None of the three providers offers it to a customer in the
  pages checked.
- **An unauthenticated public sandbox port.** Anyone who finds the URL could drive the runner.
- **Relying on the provider's port token alone.** Only E2B documents one; the bearer is the same on
  all three, and a Vercel port has nothing else.

### LC4 — Network policy (E2, E3, E4, E7)

ADR-0117 decision 2 says a sandbox reaches only the gateway and the proxy, and a driver that cannot
guarantee that by topology refuses `restricted`. A managed sandbox's topology is the provider's, not
ours. This ADR accepts a **provider-enforced allowlist as the equivalent** only when the provider
can also **deny CIDRs**, and states what the driver must always deny.

- **Always denied:** the cloud metadata address and link-local `169.254.0.0/16` and `fe80::/10`,
  RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT `100.64.0.0/10`, unique-local
  `fc00::/7`, and loopback. **Always allowed:** the gateway host (LC3).
- **Mapping of the run spec's `networkPolicy`:**
  - `none`: only the gateway host.
  - `restricted`: the gateway host plus `allowedDomains`.
  - `open`: everything except the always-denied list.
- **Provider mechanics (all checked 2026-10-07):**
  - **E2B** ([internet access](https://docs.e2b.dev/sandbox/internet-access)): `allowInternetAccess:
    false`, and `network.allowOut` / `network.denyOut` take IPs, CIDRs and domains; allow beats deny.
    `updateNetwork()` **replaces** the rules, it does not merge. Domain filtering covers HTTP on port 80
    and TLS on port 443 only. `8.8.8.8` is allowed automatically when domain filtering is used; the
    driver accepts that (DNS only). Metadata and private ranges are not mentioned, so the driver
    sets `denyOut` for them explicitly. `restricted` is `denyOut` of everything plus `allowOut` of
    the gateway and `allowedDomains`. Because allow beats deny, an explicit `denyOut` CIDR cannot
    override an `allowOut` domain match: a connection to an always-denied address that carries an
    allowed domain in SNI or Host would be let through by the documented precedence, which breaks
    the always-denied list above and ADR-0117 decisions 2 and 4. **The `external` driver with
    `provider: 'e2b'` therefore refuses `restricted` by name until E7's live lane shows the
    always-denied list holds** against a connection that carries an allowed domain. `none` and
    `open` follow the mapping above.
  - **Vercel** ([firewall](https://vercel.com/docs/sandbox/concepts/firewall)): the modes are
    `allow-all` (the default), `deny-all` and a user policy with allowed domains (matched by SNI),
    allowed CIDRs and **denied CIDRs**; `update()` changes it at runtime. The page states that
    denied ranges take precedence over allowed domains and address ranges, but that order between
    denied CIDRs and allowed-domain SNI matching is **unverified**: E7 must prove that a connection
    to an always-denied CIDR with an allowed domain in SNI is blocked before `restricted` is
    accepted on `vercel-sandbox`, and if it is not, `restricted` is refused there. A policy that
    has only denied subnets means deny-all, so `open` is allow `0.0.0.0/0` and `::/0` together with the
    always-denied list. Plain HTTP cannot be filtered by domain, and domain fronting is possible: a
    sandbox can reach any host behind the same edge as an allowed domain. `restricted` therefore
    means HTTPS to the named domains, with that residual risk stated in the runtime warning of
    spec §14.9.
  - **Cloudflare** ([outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)):
    `enableInternet = false` plus `allowedHosts` and `deniedHosts` (globs; the page documents CIDR
    entries as well, with `deniedHosts` evaluated first), and Worker outbound handlers. HTTPS
    filtering needs `interceptHttps = true`, and only ports 80 and 443 are filterable. The CIDR
    denial of the metadata and private ranges is documented, not proven, so
    **`cloudflare-sandbox` refuses `restricted` by name until E4's lane shows the always-denied
    list is enforced**. `@cloudflare/containers@0.3.7` matches `deniedHosts` as hostname globs, so
    a CIDR entry never matches; `cloudflare-sandbox` therefore also refuses `open` by name until
    the same lane proves IP-level denial. ADR-0131 amends this: `cloudflare-sandbox` also refuses
    `none`, because the live lane reached public, private, metadata and IPv6 targets under it.
- **The capability tables are a proposal until E7 proves them.** A policy mode whose conformance lane
  (spec A.12) fails is declared unsupported on that provider, not passed with a weaker test. The
  proof for E2B includes that a non-80/443 connection to an allowed domain's address does not
  escape the policy; the page documents filtering only for those two ports. It also includes that a
  connection to an always-denied CIDR (for example `169.254.169.254:443`) carrying an allowed domain
  in SNI or Host is blocked; until it is, `restricted` stays refused on E2B (above). The same
  proof is required on Vercel Sandbox before `restricted` is accepted there.

**Rejected:**

- **Routing sandbox egress through the ADR-0117 proxy.** It would need a public, authenticated
  proxy for each session, and the sandbox would still have a direct route out.
- **Refusing `restricted` on every provider for good.** It gives up a control each vendor
  documents; E2B and Cloudflare are refused only until E7 or E4 proves the always-denied list.
- **Accepting any provider allowlist without CIDR denial.** The metadata address and private
  ranges would be reachable by IP.
- **Treating `open` as "no policy".** Metadata and private ranges are denied even then.

### LC5 — Tool sandbox (E2, E3, E4; ADR-0118 TS2, TS3)

- ADR-0118's per-session tool sandbox is a second `create()` on the **same driver and provider** as
  the agent sandbox, with the same reachability (LC3), the same policy rules (LC4) and per-run
  tokens (TS3). It is **not refused** on `external` or on the native drivers.
- A provider that refuses `restricted` (Cloudflare and E2B until LC4's proof) cannot host a tool
  sandbox whose egress is `restricted`, as ADR-0118's consequences already say, and refuses it by name.
- It costs one more runtime per session that has a code tool or a `stdio` server, and none for a
  session that has neither.

**Rejected:**

- **Refusing the tool sandbox by name on `external`.** It leaves code tools unusable on every Track E
  cloud.
- **A tool sandbox on a different provider than the agent sandbox.** It needs two keys and two
  policies for one session.

### LC6 — Provider credentials (E2)

- The provider API key (E2B key, Vercel access token with team and project ids, Cloudflare bridge
  secret) is stored in a runtime connection (`RUNTIME_CONNECTION__` secret,
  `apps/web/server/runtimes/connections.ts:84`). This is the first driver that decrypts one.
- **web decrypts it**, at allocation, in the run resolver that already holds the secrets service,
  and sends it in the allocate request over the authenticated web → manager channel. The manager
  holds it **in memory for the call only**. It is never logged (redaction covers the key,
  `X-API-Key`, the Vercel token and the traffic token), never persisted, and never put into the
  sandbox environment. A manager that keeps no state (LC7) receives it on each call that needs the
  provider (allocate, destroy, and a lookup by session key).
- Vercel Sandbox accepts an OIDC token or an access token with team id, project id and token
  ([Vercel Sandbox authentication](https://vercel.com/docs/sandbox/concepts/authentication), checked
  2026-10-07). The OIDC path works only for code running on Vercel; this driver uses the **access
  token** so the same connection works from any host and from `aw dev`.
- The key is the same on every host and locally: there is one path, the runtime connection. An
  `E2B_API_KEY` environment variable is read **only by E7's live test lane** (a CI secret), never by
  the product, including `aw dev` and Compose.

**Rejected:**

- **The manager decrypts.** The master key would have to live in a second service.
- **A deploy-time environment variable only.** It bypasses the connection UI, rotation and audit.
- **Vercel OIDC for the Vercel driver.** It does not exist outside Vercel, so the driver would
  differ by host.
- **Reading the key from the sandbox's own environment.** The agent sandbox must hold only its
  per-run token (ADR-0113).

### LC7 — Serverless control plane (E5, E6)

Three long-lived assumptions break on both hosts: the launcher's detached stream consumer
(`apps/web/server/runs/launcher.ts:598-599`), the in-process retention scheduler
(`apps/web/server/sessions/retention.ts:149`) and migrations in the web `CMD` (`Dockerfile:147-154`;
unit C2 #795 is making migrations run once). The runner manager's allocation table is in memory
(`apps/runner/src/manager.ts:64-67`, `:384-385`).

**Vercel (E5).** The control plane is Next.js on Vercel Functions with Fluid compute.

- **Longest run = the function's maximum duration.** The default duration is 300 s; the maximum is
  300 s on Hobby and 800 s on Pro and Enterprise (1800 s is described as beta and is not relied on;
  [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration),
  checked 2026-10-07). The launcher's consumer runs under `waitUntil`, whose promises have the
  same timeout as the function and are cancelled when it times out
  ([`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package),
  checked 2026-10-07). A run whose deadline is longer than the configured maximum is **refused by
  name** (proposed code `run_deadline_exceeds_host`; E5 fixes it) before it starts. One model
  stream through the gateway is bounded the same way, and so is each tool call in a run.
- **Retention** is a Vercel Cron route, `apps/web/app/api/cron/retention`. Cron calls the path with
  `GET` and sends `Authorization: Bearer $CRON_SECRET` when that variable is set; delivery is best
  effort, can be duplicated, and a failed invocation is not retried
  ([Vercel managing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs), checked
  2026-10-07). The route checks the secret and is idempotent. On Hobby a cron runs once a day, at
  any minute of the hour; on Pro it can run each minute
  ([Vercel cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing), checked 2026-10-07).
- **Migrations** are an `aw deploy` step (C2's run-once job), not a function.
- **The gateway and the manager are Vercel Functions too.** The manager becomes **stateless**: the
  allocation table is replaced by a provider lookup keyed by the session key (the Vercel sandbox
  *name*, E2B metadata), with the bearer re-derivable (LC3) and the provider key sent per call (LC6).

**Cloudflare (E6).** The existing `web`, `gateway` and `runner` images run as **Cloudflare
Containers** behind a routing Worker.

- **Longest run = the existing run deadline.** A Worker has no wall-clock limit while the client is
  connected (CPU time is 30 s by default and 5 minutes at most on the Paid plan;
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-10-07),
  and a container has no fixed maximum lifetime, with `sleepAfter` defaulting to 10 minutes
  ([Containers FAQ](https://developers.cloudflare.com/containers/faq/), checked 2026-10-07).
  A host restart can stop a container; it receives `SIGTERM` and a grace period of 15 minutes
  ([Containers architecture](https://developers.cloudflare.com/containers/platform-details/architecture/),
  checked 2026-10-07). A run that is cut short ends with the **existing interrupted status**.
- **Retention** is a Cron Trigger (five-field cron, so at most once a minute;
  [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), checked
  2026-10-07; one invocation has a 15-minute wall-time limit in the Workers limits page above) that
  calls the same route. Postgres is reached by **direct TCP from the container**, as today; the
  Workers TCP-sockets page recommends Hyperdrive for Worker code
  ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), checked
  2026-10-07), and private IPs are blocked there, so Worker-side code does not reach a private
  database.
- Container environment and Worker secrets reach a container through `env` on
  `ctx.container.start()`, and an update is read on the next start, not by a running process
  ([Containers environment variables and secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/),
  checked 2026-10-07). A secret rotation therefore takes effect at the next container start.
- The manager keeps its in-memory table with **one instance**; a restart reconciles from the
  provider.

**Rejected:**

- **Rewriting `web` onto Workers through OpenNext.** Large and unverified against this codebase.
- **Keeping in-process schedulers on hosts that sleep.** The work would not run.
- **A durable queue product.** A new dependency without a need the run limit above does not meet.
- **Moving the run-stream consumer into the manager or the sandbox on Vercel.** It lifts the
  800 s limit and makes E5 much larger; revisit if the limit proves too short.

### LC8 — Native data plane (E5, E6)

- **Vercel.** Vercel Postgres has been retired in favour of Marketplace providers
  ([Vercel Postgres](https://vercel.com/docs/postgres), checked 2026-10-07); the default is **Neon**
  through the Marketplace. The object store is **any S3-compatible store** through the existing S3
  adapter (R2 or S3); **Vercel Blob is rejected for now**, since it has no stated S3 API
  ([Vercel Blob](https://vercel.com/docs/vercel-blob), checked 2026-10-07), so it would need a new
  adapter. The master key is a Vercel **Secret** environment variable (write-only after saving;
  [Vercel environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables),
  checked 2026-10-07) on the existing `local-key` provider (`MASTER_KEY_PROVIDER`).
- **Cloudflare.** An external Postgres (Neon or Supabase) over TCP. R2 through the S3 adapter, at
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` with region `auto`
  ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/), checked 2026-10-07). The master key
  is a Worker secret passed to the container (LC7) on `local-key`.

**Rejected:**

- **A new KMS-like master-key provider per host.** Neither host offers one natively, so it would be
  an invention.
- **Vercel Blob now.** See above; revisit when an S3 API is documented.

### LC9 — The agent app (E5, E6)

One `aw deploy` to either host deploys the control plane, the gateway, the manager and the project's
frontend.

- **Frontend.** On Vercel it is a second Vercel project; on Cloudflare it is Workers static assets.
  It gets `baseUrl` set to the control plane's URL, which is added to the control plane's
  `allowedOrigins`. Browser tokens are unchanged.
- **Hosted chat and widget** are served by the control plane on both hosts.
- **`aw push`, `aw promote` and rollback** behave as on GCP; a version and its pinned tool bundle
  move together (ADR-0118 TS1).
- **Code tools** (ADR-0118) run in the tool sandbox of LC5 once B3 and B4 land; **`stdio` MCP** once B5
  lands; the **eval gate** once C4 lands. On Vercel each of these is bounded by the run limit of LC7.
- **Secrets** reach sandboxes only as ADR-0118 TS4 says; the control plane's own secrets are host
  environment variables (LC8).
- Anything not supported on a host is refused **by name**, with a stable error code, never by silent
  degradation.

**Rejected:**

- **Deploying only the control plane and leaving the frontend to the developer.** The Owner's goal
  is the whole app from one command.
- **Serving the frontend from the control plane.** It couples the project's release to the
  platform's and breaks the `baseUrl` model the SDK already has.

### LC10 — Host × sandbox (E7)

Native sandboxes are offered **only on their own cloud**. E2B is offered on every cloud.

| host \ sandbox | E2B (`external`) | Vercel Sandbox | Cloudflare Sandbox |
| --- | --- | --- | --- |
| Vercel | supported | supported (default) | refused: `driver_not_offered_on_cloud` |
| Cloudflare | supported | refused: `driver_not_offered_on_cloud` | supported (default) |

The error code name is proposed; E3 and E4 fix it. A refused pair is refused when the runtime is
saved, not when a run starts.

What works on each supported pair:

| Part of the agent app | Vercel + E2B | Vercel + Vercel Sandbox | Cloudflare + E2B | Cloudflare + Cloudflare Sandbox |
| --- | --- | --- | --- | --- |
| Frontend | yes | yes | yes | yes |
| API | yes¹ | yes¹ | yes | yes |
| Hosted chat | yes¹ | yes¹ | yes | yes |
| Widget | yes¹ | yes¹ | yes | yes |
| `aw push` | yes | yes | yes | yes |
| `aw promote` | yes | yes | yes | yes |
| Rollback | yes | yes | yes | yes |
| Code tools | after B3, B4¹, and LC4's proof when `restricted` | after B3, B4¹, and LC4's proof when `restricted` | after B3, B4, and LC4's proof when `restricted` | after B3, B4, and LC4's proof when `restricted` |
| `stdio` MCP | after B5¹, and LC4's proof when `restricted` | after B5¹, and LC4's proof when `restricted` | after B5, and LC4's proof when `restricted` | after B5, and LC4's proof when `restricted` |
| Eval gate | after C4¹ | after C4¹ | after C4 | after C4 |

¹ On Vercel a run, a model stream and a tool call are each bounded by the function's maximum
duration (LC7: 300 s on Hobby, 800 s on Pro and Enterprise). A longer run deadline is refused by
name.

## Proposed `RuntimeCapabilities`

These are the values the drivers declare, using the fields of spec §14.5
(`packages/runtime/src/driver.ts:95-106`). Precedent for the shape is
`packages/runtime/src/aca-sessions.ts:35-48` and `packages/runtime/src/cloud-run.ts:33-41`. A row
whose basis is "ours" states a design choice, not a vendor fact. Each vendor fact has its source and
check date in its own row. E7's lanes prove the table (LC4); a value that fails is changed to
unsupported.

### `external` with `provider: 'e2b'`

| Field | Value | Basis | Source |
| --- | --- | --- | --- |
| `isolation` | `microvm` | Firecracker microVM, stated on the vendor's marketing page only | [e2b.dev](https://e2b.dev/), checked 2026-10-07 |
| `customImage` | `true` | template from an image or Dockerfile, no multi-stage | [base image](https://docs.e2b.dev/template/base-image), checked 2026-10-07 |
| `persistentFilesystem` | `false` | sandboxes can be paused; ours does not use it | ours; [sandbox lifecycle](https://docs.e2b.dev/sandbox), checked 2026-10-07 |
| `sessionAffinity` | `true` | one sandbox per session, addressed by its own URL | ours; [public URL](https://docs.e2b.dev/network/public-url), checked 2026-10-07 |
| `maxSessionSeconds` | `3600` (Hobby) or `86400` (Pro), from the configured tier; `3600` when unset | 1 h on Hobby, 24 h on Pro; default `timeout` 300 s | [sandbox](https://docs.e2b.dev/sandbox), [create-sandbox](https://docs.e2b.dev/api-reference/sandboxes/create-sandbox-v2), checked 2026-10-07 |
| `networkPolicies` | `none`, `open`; `allowlist` pending E7's proof | `allowOut`/`denyOut` take CIDRs, but allow beats deny, so the always-denied list is unproven against an allowed domain (LC4); domain filtering on ports 80 and 443 only | [internet access](https://docs.e2b.dev/sandbox/internet-access), checked 2026-10-07 |
| `execCommands` | `true` | our runner server provides exec | ours |
| `gpu` | `false` | not offered by this driver | ours |
| `managedByProvider` | `true` | E2B runs the sandbox | [e2b.dev](https://e2b.dev/), checked 2026-10-07 |
| `typicalStartMs` | `null` | no start-time figure is published; E7 measures | [e2b.dev](https://e2b.dev/), [sandbox](https://docs.e2b.dev/sandbox), checked 2026-10-07 |

### `vercel-sandbox`

| Field | Value | Basis | Source |
| --- | --- | --- | --- |
| `isolation` | `microvm` | Firecracker microVM | [concepts](https://vercel.com/docs/sandbox/concepts), checked 2026-10-07 |
| `customImage` | `true` | OCI `linux/amd64` image in Vercel Container Registry, pinned `@sha256` | [images](https://vercel.com/docs/sandbox/concepts/images), checked 2026-10-07 |
| `persistentFilesystem` | `false` | sandboxes are persistent by default (state saved on stop); create takes `persistent: false`, which `vercel-sandbox` sets (E3, checked 2026-10-08, not yet verified live) | ours; [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), checked 2026-10-07 |
| `sessionAffinity` | `true` | one named sandbox per session | ours; [REST](https://vercel.com/docs/rest-api/sandboxes/), checked 2026-10-07 |
| `maxSessionSeconds` | `2700` (Hobby) or `86400` (Pro, Enterprise), from the configured tier; `2700` when unset | default 5 min, `extendTimeout()`; 45 min on Hobby, 24 h on Pro and Enterprise; 10 concurrent sandboxes on Hobby | [pricing and limits](https://vercel.com/docs/sandbox/pricing), checked 2026-10-07 |
| `networkPolicies` | `none`, `open`; `allowlist` pending E7's proof | firewall with denied CIDRs, documented as taking precedence over allowed domains but unverified until E7 (LC4), so `restricted` is refused by name until then; `none` is `allowedDomains: [gateway host]` and `open` is `allowedCIDRs: [0.0.0.0/0, ::/0]`, both with `deniedCIDRs` set to the always-denied ranges (E3) | [firewall](https://vercel.com/docs/sandbox/concepts/firewall), checked 2026-10-07 |
| `execCommands` | `true` | our runner server provides exec | ours |
| `gpu` | `false` | not offered by this driver | ours |
| `managedByProvider` | `true` | Vercel runs the sandbox | [concepts](https://vercel.com/docs/sandbox/concepts), checked 2026-10-07 |
| `typicalStartMs` | `null` | pages state no figure; E7 measures | [concepts](https://vercel.com/docs/sandbox/concepts), checked 2026-10-07 |

`maxSessionSeconds` is also bounded by the run limit of LC7 when the host is Vercel; the capability
value is the sandbox's, the run limit is the control plane's.

### `cloudflare-sandbox`

| Field | Value | Basis | Source |
| --- | --- | --- | --- |
| `isolation` | `microvm` | Containers run in Firecracker microVMs | [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/), checked 2026-10-07 |
| `customImage` | `true` | image from a supported registry | [image management](https://developers.cloudflare.com/containers/platform-details/image-management/), checked 2026-10-07 |
| `persistentFilesystem` | `false` | no persistent filesystem is claimed; a host restart can stop a container | ours; [FAQ](https://developers.cloudflare.com/containers/faq/), checked 2026-10-07 |
| `sessionAffinity` | `true` | one container instance per session through the bridge Worker | ours; [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/), checked 2026-10-07 |
| `maxSessionSeconds` | `null` | no fixed maximum lifetime; `sleepAfter` defaults to 10 minutes; host restarts can stop a container | [FAQ](https://developers.cloudflare.com/containers/faq/), checked 2026-10-07 |
| `networkPolicies` | none: `none`, `open` and `allowlist` are all refused (ADR-0131; `open` and `allowlist` until E4's proof) | `allowedHosts`/`deniedHosts` document CIDR, HTTPS filtering needs `interceptHttps`, ports 80 and 443 only | [outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/), checked 2026-10-07 |
| `execCommands` | `true` | our runner server provides exec | ours |
| `gpu` | `false` | not offered by this driver | ours |
| `managedByProvider` | `true` | Cloudflare runs the container | [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/), checked 2026-10-07 |
| `typicalStartMs` | `null` | the pages state a cold start of about 1 to 3 seconds, a range and not a typical figure; E7 measures | [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/), [FAQ](https://developers.cloudflare.com/containers/faq/), checked 2026-10-07 |

## Unit → clause

| Unit | Clause |
| --- | --- |
| E2 — `external` driver, E2B provider, shared forwarder, gateway public URL | LC1, LC3, LC4 (`restricted` refused by name), LC5 (tool sandbox `restricted` refused by name), LC6 |
| E3 — `vercel-sandbox` driver | LC1, LC2, LC3, LC4 (`restricted` accepted only after E7's proof) |
| E4 — `cloudflare-sandbox` driver and bridge Worker | LC1, LC2, LC3, LC4 |
| E5 — Vercel as a deployment cloud | LC7, LC8, LC9 (Vercel) |
| E6 — Cloudflare as a deployment cloud | LC7, LC8, LC9 (Cloudflare) |
| E7 — lanes that prove the tables, including the E2B and Vercel deny-precedence proofs that lift the `restricted` refusal | LC4, LC5, LC6 (`E2B_API_KEY` as a CI secret), LC10 |

Issue #826's nine questions: 1 → LC1; 2 → LC2; 3 → LC3; 4 → LC4; 5 → LC5; 6 → LC6; 7 → LC7;
8 → LC8; 9 → LC9. The host × sandbox matrix is LC10 and the capability tables follow it.

### Relation to earlier ADRs

- **Amends spec §14.4.** `docs/spec.md` still lists `external` as the one row for E2B, Daytona,
  Modal, Vercel and Cloudflare until E3 and E4 edit it. The development plan D-09 still says
  "external not offered" until a later unit edits it. The developer-platform build-deploy plan
  still names this ADR "ADR-0119" (0119 is PR #816's). Until those units land the documents
  disagree, and this ADR is the record that wins.
- **Amends ADR-0117 decision 2.** A provider-enforced allowlist is the equivalent only with CIDR
  denial (LC4); a provider that cannot show it refuses `restricted`.
- **Applies ADR-0118 TS2 and TS3.** The tool sandbox is a second `create()` on the same driver, with
  per-run tokens (LC5).
- **Amends ADR-0118 TS5.** Its egress rule is LC4 here.
- **Applies ADR-0113.** The sandbox holds only its per-run gateway token (LC3, LC6).
- **Depends on C2 #795** for migrations that run once (LC7).
- **Does not change dependency-policy §6.** All six vendor packages stay on `denyByName` (LC1).

## Consequences

- A developer can deploy the whole agent app to Vercel or Cloudflare with one `aw deploy` and run
  sessions in E2B or the host's own sandbox, once E2–E7 land. Until then none of this exists, and
  the runtime UI still says "None registered".
- Three hand-written REST clients need fake-server tests, and each provider fact in the code
  carries its URL and check date.
- The sandbox reaches the gateway over the public internet. The gateway needs a public URL, TLS and
  per-token rate limits, and a run token is a credential that must stay short-lived.
- Network policy is the provider's, so it is a provider claim to prove, not a topology we control.
  `restricted` on Vercel is HTTPS only, carries the domain-fronting residual risk, and is accepted
  only after E7 proves denied CIDRs win over allowed domains; on E2B it is refused by name, since its
  allow-beats-deny precedence could let an allowed domain in SNI or Host reach an always-denied
  address, until E7 proves otherwise; on Cloudflare it is refused until proven. §14.9's runtime
  warning says so.
- The longest run on Vercel is 300 s on Hobby and 800 s on Pro and Enterprise, and longer deadlines
  are refused by name. The manager there is stateless and needs the bearer to be re-derivable.
- `maxSessionSeconds` depends on a configured plan tier, and falls back to the lower value when none is
  set, so a driver never claims more than the floor.
- The Cloudflare driver is not the Sandbox SDK, so it does not get that SDK's features; it gets our
  runner server unchanged.
- Vendor limits will drift. Each carries a date, and E7's lanes are where they are re-checked.
- If this is reversed, `external` is again the one unimplemented row of §14.4 and the deployment
  clouds are the three of today.

## Alternatives rejected

- **Everything through `external`, with Vercel and Cloudflare as providers.** They would have a
  sandbox but no deployment cloud, against the Owner's shape (LC1).
- **Vendor SDKs.** A `denyByName` removal, a D-09 record and vendor types near the boundary (LC1).
- **A bootstrap or snapshot image on Vercel, or the Sandbox SDK base image on Cloudflare.** No pin,
  expiry or a denied package (LC2).
- **Private networking to the sandbox.** None is offered (LC3).
- **Accepting a provider allowlist without CIDR denial, or refusing `restricted` everywhere.**
  The first leaves metadata reachable; the second discards a control each vendor documents (LC4).
- **Refusing or relocating the tool sandbox.** Code tools would not run on Track E clouds, or would
  need two keys (LC5).
- **The manager decrypting provider keys, or a deploy-time variable only.** A second master-key
  holder, or no rotation (LC6).
- **Workers through OpenNext, in-process schedulers on sleeping hosts, or a queue product.** Large
  and unverified, not run, or an unneeded dependency (LC7).
- **Vercel Blob now, or a new master-key provider per host.** No S3 API, or no native service (LC8).
- **Control plane only, or the frontend served by the control plane.** Neither is the whole app from
  one command (LC9).
- **Every sandbox on every cloud.** A native sandbox is a cloud's own service; offering Vercel
  Sandbox from Cloudflare would put a second vendor's key and network path in every deployment for
  no gain over E2B (LC10).

## Amendment — LC4: E2B's per-VM MMDS at 169.254.169.254 (issue #832, 2026-10-08)

LC4 lists the cloud metadata address and link-local `169.254.0.0/16` as always denied. The provider
live lane (run 37768729288) found that `169.254.169.254:80` connects from inside an E2B sandbox under
both `none` and `open`. What answers there is not cloud metadata: it is Firecracker's MMDS, a
per-sandbox service of the VM's own VMM that E2B enables unconditionally because envd needs it for
`/init` authentication and log export (e2b-dev/infra @54579116,
`packages/orchestrator/pkg/sandbox/fc/client.go:360-369`). Firecracker answers those frames before
they reach the tap device, so no egress rule, E2B's or ours, can block it, and E2B offers no option
to disable it. Every other `169.254.x` address still goes through the filter, and the host's cloud
metadata is blocked by E2B separately (`firewall.go:27`). It serves `instanceID`, `envID`, `address`
(E2B's log collector) and `accessTokenHash` (a SHA-512 of the envd token, not the token), and no API
key, team data, environment variable or runtime bearer.

**The exception is narrow and proven, never a pass on a bare connect.** For a provider where
`169.254.169.254:80` does not connect, LC4 is unchanged and the row passes. Where it connects, the
`none-blocks-cloud-metadata` and `open-blocks-cloud-metadata` rows of `infra/tests/providers` pass
only if the probe inside the sandbox proves all of:

- an unauthenticated `GET /` answers 401, as MMDS does without a token;
- the MMDS token flow returns a non-empty JSON object whose keys are within `instanceID`, `envID`,
  `address` and `accessTokenHash`; any other key fails. Only key names are recorded, never values
  or tokens;
- no cloud metadata answers: GCP (`GET /computeMetadata/v1/` with `Metadata-Flavor: Google`), AWS
  IMDSv2 (token `PUT` and `GET /latest/meta-data/iam/`) and AWS IMDSv1 (`GET
  /latest/meta-data/iam/`) must all fail. MMDS answers the IMDSv2 token path itself, so the proof
  rests on `iam/` never returning 2xx;
- a second link-local target, `169.254.169.253:80`, stays blocked, which shows the `/16` deny still
  holds.

The informational row `metadata-is-per-vm-mmds` makes the exception visible in every run (`pass`
with the key names when proven, `n/a` when the address does not connect). If a run ever sees anything
beyond MMDS there, the row fails and E2B is refused for untrusted code.

The lane also gains a `no-ipv6-egress` row for every provider: TCP to an IPv6 public host and to
`fe80::1`, `fc00::1` and `::1` from inside the sandbox. Under `none` and `open` the link-local, ULA
and loopback targets must be unreachable, and under `none` the public host too; a sandbox with no
IPv6 route passes. Vercel's API accepts IPv4 CIDRs only (issue #828), so for `vercel-sandbox` this
row is the only IPv6 proof.
