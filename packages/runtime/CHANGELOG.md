# Changelog

## Unreleased

- The external driver takes `sessionIdleSeconds`: an agent sandbox is created, and renewed by `find`,
  with a timeout of the larger of that and the spec's `idleTimeoutSeconds`, plus 120 seconds, capped
  at the plan maximum (issue #827, part of). A spec with `timeoutSeconds`, a tool-host workload and a
  driver without the option keep their previous timeouts.
- The E2B provider and the external driver can host a tool sandbox (ADR-0118, ADR-0120 LC5, issue
  #827): `workload: 'tool-host'` starts the tool host (`/app/packages/tool-host/dist/main.js`) in
  the sandbox instead of the runner, with no egress at all (not even the gateway), a driver-level
  `writeFile` through envd `/files` for the manifest and tokens, and `accessHeaders` for the
  provider's traffic token. The driver seals its handle ids under their own label, so a runner id
  is not a tool sandbox id. Not yet run against real E2B.
- The external driver's `create` takes `tags` the provider records as metadata, and a provider that
  can `list` gives the driver `destroyTagged`, which kills every sandbox with those tags whichever
  process created it (ADR-0132). A stateless tool-host `find` renews the sandbox's deadline to the
  run spec's timeout. E2B lists through `GET /v2/sandboxes` with a metadata filter.

- `cloudflare-sandbox` declares no network policy and refuses `none` (also when a run has no run spec)
  with `network_policy_unsupported`, as it already did `restricted` and `open` (ADR-0131, issues #829
  and #832). `SandboxNone` already started with `enableInternet = false` and the gateway as the only
  allowed host, but providers-live run 37878740518 reached public, private, metadata and IPv6 targets
  through Cloudflare's L7 outbound proxy. The external driver refuses `none` for any provider that
  does not declare it. Not yet run against real Cloudflare.
- `vercel-sandbox` create no longer sends IPv6 CIDRs in `networkPolicy.subnets`, which accepts IPv4
  only: providers-live run 37771522792 (2026-10-08) answered `400 Invalid CIDR "fe80::/10"` (`none`)
  and `Invalid CIDR "::/0"` (`open`). `none` denies the IPv4 always-denied ranges; `open` allows
  `0.0.0.0/0`. IPv6 egress denial is not configured through Vercel's policy and rests on the lane's
  `no-ipv6-egress` proof (issues #832, #828). Not yet run against real Vercel.
- `vercel-sandbox` create sends Vercel's request `networkPolicy` shape, `{ allow, subnets: { allow,
  deny } }`, instead of the response-only `{ mode: 'custom', allowedDomains, allowedCIDRs,
  deniedCIDRs }` that answered `400` in providers-live run 37752204337 (issue #832, #828). A failed
  provider call now carries Vercel's error code and a short redacted reason in its message. Not yet
  run against real Vercel.
- E2B provider, from the providers-live findings (issues #827 and #832): `none` no longer sends the
  denied CIDR `::/0`, which E2B rejects with 400; a null `domain` in the create response falls back
  to `e2b.app`; the runner is started after create through envd's process API with the sandbox's
  `envdAccessToken`, and the bearer travels only in that process's environment; a failed call carries
  E2B's error message as a short, redacted reason. Not yet run against real E2B.
- A stateless `vercel-sandbox` create is idempotent per session (issue #830, ADR-0128): with a
  `lookupKey` the provider reuses a usable `aw-<lookupKey>` sandbox, waits out one that is starting or
  stopping, deletes only one it read as `stopped`, and treats a `409` as another allocation having won
  the name. Two concurrent allocations no longer destroy a live sandbox. `ExternalSandbox` gained an
  optional `expiresAt`, used for the handle when the provider reports it. `createVercelSandboxProvider`
  takes an optional `retryDelayMs`. Not yet run against real Vercel.
- The `external` and `vercel-sandbox` drivers can recover a session's sandbox without a table (issue
  #830, ADR-0126): a `createSealer(secret, driverId)` seals the handle id with AES-256-GCM, derives the
  bearer and a lookup key from a secret with HKDF-SHA256, and finds the sandbox by that key (Vercel
  sandbox name `aw-<lookupKey>`, E2B metadata `awKey`). Not yet run against real Vercel or E2B.
- Kubernetes driver: opt-in shared-namespace mode (`namespace`, `fieldManager`), so the runner manager
  runs sandboxes as Pods in its release namespace under a namespaced Role (issue #854, ADR-0124). It
  creates no Namespace; each sandbox gets a Service of its Pod's name, `hostAliases` for the
  gateway, session and runtime labels, and NetworkPolicies named for the Pod. `isLive` reads the Pod
  phase. Exports `inClusterKubernetesClient` (ServiceAccount token, no kubeconfig) and
  `sessionLabelValue`. The per-namespace mode is unchanged.
- New `vercel-sandbox` driver id and a Vercel Sandbox provider over REST (no SDK, no new
  dependency), part of issue #828 (ADR-0120 LC1-LC4, LC6). It runs on `createExternalDriver`, which
  takes an optional `driverId` (`'external'` by default, so E2B is unchanged). `restricted` is
  refused by name until the E7 live lane proves a denied range beats an allowed domain. Exports
  `createVercelSandboxProvider`, `vercelSandboxRuntimeCapabilities`. Not yet run against real
  Vercel.
- New `cloudflare-sandbox` driver, part of issue #829 (ADR-0120 LC1-LC4, LC6): the `external`
  driver's forwarding and refusals under its own id, with a provider that calls the bridge Worker in
  `infra/cloudflare/sandbox-bridge/`. only `none` (gateway host only) is supported; `open` and `restricted` are refused by name
  until the live lane proves IP-level denial of the ADR-0120 always-denied ranges (#829). `ExternalDriverId` gains `cloudflare-sandbox`. Exports
  `createCloudflareSandboxDriver`, `createCloudflareSandboxProvider`,
  `cloudflareSandboxRuntimeCapabilities`. Not yet verified against a real Cloudflare account.

- New `external` driver and an internal E2B provider over REST (no SDK, no new dependency), part of
  issue #827 (ADR-0120 LC1-LC6): one sandbox per session, addressed at its public URL with a
  per-sandbox bearer, the provider key passed per call and never stored. `restricted` is refused by
  name (`RuntimeRefusalError`, code `network_policy_unsupported`) until the E7 live lane proves the
  always-denied ranges. Exports `createExternalDriver`, `createE2bProvider`,
  `e2bRuntimeCapabilities`, `assertBuildIdPinnedTemplates`, `RuntimeRefusalError`. Not yet run
  against real E2B.

- Docker driver: `DockerDriver.writeFile(runtime, name, content)` writes one file into `/workspace`
  of a live sandbox over `docker exec` standard input, atomically, so a secret never appears in an
  argument or an environment variable (issue #791, ADR-0118 TS4). `DockerCommand` takes an optional
  second argument, `{ input }`, written to the command's standard input.
- Docker and Kubernetes drivers: new opt-in option `egressProxyImage` (the `packages/egress-proxy`
  image, ADR-0117), plus `proxyBypass` for hosts the sandbox reaches directly (the gateway).
  With it, `restricted` honours `allowedDomains` and `open` becomes the public internet through a
  per-session proxy that refuses cloud metadata, loopback and private addresses. Docker starts one
  proxy container per session on a per-session internal network (`aw-egress-<id>`) shared only with
  its sandbox, and gives the proxy its own non-internal way out (`aw-egress-out-<id>`); neither the
  sandbox nor the proxy is attached to `bridge`, so no other container on the host can use the
  proxy. This refines the Docker row of ADR-0117 decision 7. `create` rolls both networks back on
  failure, and `destroy`, `reapExpired` and `reapAll` remove the proxy and both networks.
  Kubernetes always adds the gateway Service's `.svc` and `.svc.cluster.local` names to the
  sandbox's `NO_PROXY` when the proxy image is set. Kubernetes starts one proxy Pod and Service per session and the sandbox
  `NetworkPolicy` allows the gateway and that proxy only. The driver capabilities list `allowlist`
  only when the image is set. **Behaviour change with the image set:** an `open` sandbox loses
  private hosts, the metadata address and ports other than 80 and 443. Without the image the
  earlier behaviour is unchanged (`restricted` and `allowedDomains` refused, `open` on `bridge`).
  `buildRuntimeEnvironment` now sets the proxy variables for `open` as well as `restricted`.
  `allowedDomains` entries are validated (host names or `*.suffix`; `*` is refused).
- Cloud Run and ACA drivers: the `restricted` refusals now cite ADR-0117 decision 7.
- Docker driver: a session past its `timeoutSeconds` is now stopped and removed by the driver
  itself. A reaper checks every 15 s (`DOCKER_REAP_INTERVAL_MS`) while a sandbox with a deadline
  exists, using the same `rm --force --volumes` path as `reapAll`. The new
  `DockerDriver.reapExpired()` runs one pass on demand. Containers started by an earlier manager
  process are not deadline-reaped (the deadline is held in memory); `reapAll` still covers them.
  A reaped handle reads as not live and its `destroy()` is a no-op. A failed reaper removal is
  logged once per sandbox (`console.warn`) and retried every tick.
- Docker driver: with `workspaceStorage: 'anonymous-volume'` (the Compose manager) `/workspace` is
  now a size-bounded tmpfs: `diskMb` from the run spec, default 1024 MiB
  (`DOCKER_DEFAULT_WORKSPACE_MB`), minimum 16. A full workspace fails with `ENOSPC`. tmpfs pages
  are charged to the memory cgroup, so the container's `--memory` covers the agent's memory plus
  its tmpfs workspace (`memoryMb`, default 1024, plus the workspace size); a full workspace never
  OOM-kills the agent. With `workspaceStorage: 'bind'` (local/dev) the
  host directory cannot be sized by Docker, so it stays unbounded and an explicit `diskMb` is
  refused.
