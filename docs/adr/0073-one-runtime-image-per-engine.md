# ADR-0073 — One runtime image per engine, chosen from an `engine → image` map

Status: accepted
Date: 2026-09-29
Decided by: the implementer of ENG-07 (agent-engines programme, tracker #299, unit ENG-07, issue
#306), finished locally on the Owner's decision after the hosted runner was lost twice
Scope: `runtime.Dockerfile`; `scripts/engine-images.mjs`; `infra/release/*`;
`.github/workflows/ci.yml` (the runtime-image job); `packages/runtime/src/engine-images.ts` and
every image-taking driver; `apps/runner/src/manager*.ts`; `apps/web/server/engines/images.ts`,
`apps/web/server/engines/registry.ts`, `apps/web/server/runs/api.ts`; the Helm chart's
`images.runtime`; the compose files and Terraform modules that configure a runtime image;
`formal/AgentWorkspace/Behaviour/EngineImages.lean`

## Context

ADR-0065 made an agent's engine an extension point behind one port, and ADR-0070 landed the port
and its first adapter, `packages/engine-claude-agent-sdk`. Until this unit one `runtime.Dockerfile`
built one image, `agent-workspace/runtime`, which carried the engine-neutral runner **and** the
Claude adapter, and every driver was constructed with one `image` string. Two things follow from
that and neither survives a second engine:

- an image that carries every adapter carries every adapter's third-party SDK — and its native
  binaries and its licence tree — into every sandbox, whichever engine the run uses;
- `GET /api/engines` (ENG-02) had nothing to say about `installed` except a constant in the
  descriptor, and the run route had no way to refuse an engine this deployment cannot start
  before a sandbox was created for it.

## Decision

### D1 — One image per engine

`runtime.Dockerfile` takes `ARG ENGINE` (default `claude-agent-sdk`) and copies exactly one
adapter package, `packages/engine-${ENGINE}`, into the build. pnpm's `--filter
"@agent-workspace/runner..."` walks the workspace graph, so the production `node_modules` holds
only the selected adapter's dependency tree. The image is published as
`agent-workspace/runtime-<engine>` and carries two labels:

- `io.agent-workspace.engine=<engine id>`;
- `io.agent-workspace.engine-version=<adapter version>+<sdk version>`.

The labels are derived from the copied manifests and checked during the build
(`scripts/engine-images.mjs --verify-label`), so a build that would mislabel itself fails. Each
adapter declares its third-party SDK under `agentWorkspace.engineSdk` in its `package.json`. The
engine list is derived from the tree (`packages/engine-<id>`), and an engine whose adapter does not
exist yet has no image: each engine unit adds its own row by adding its package.

### D2 — The catalogue is the map

A deployment configures one image per engine it offers:

- environment: `AGENT_WORKSPACE_RUNTIME_IMAGE_<ID>`, where `<ID>` is the engine id upper-cased with
  `-` written `_` (`AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`, `…_PI`);
- Helm: `images.runtime.<engine>`;
- the CLI's generated `.env`: the same variables.

`installed` in `GET /api/engines` is **exactly** "the configured map holds an image for this
engine", for every registered engine alike. A descriptor no longer carries its own `installed`.
The parser lives in `packages/runtime` (`parseEngineImageMap`, `readEngineImageMap`) and both the
control plane and the runner manager call it, so the two processes cannot disagree about which
engines a deployment offers.

### D3 — Dispatch picks the image of the run's engine

`RuntimeConfig.engine` is required. Every driver that takes an image (`docker`, `kubernetes`,
`cloud-run-service`) is constructed with the map and resolves the image for `config.engine` in
`create()`, before anything is created. An engine with no image answers `engine_not_installed`:

- at the run route, as `422 engine_not_installed`, after the session's engine is pinned and before
  the run row or any sandbox exists;
- at a driver, as a thrown refusal before any container, pod or service exists.

`local` and `sandbox-runtime` take no image: they run the runner in-process and load whatever
adapters are installed in the workspace. They still receive `engine`.

### D4 — The base image rule

`claude-agent-sdk` keeps its glibc Debian bookworm base: the Claude Agent SDK ships a
platform-specific native CLI binary through its `optionalDependencies`, and musl is not a platform
it publishes. Another engine may use a smaller base only if its SDK has no native binary, and the
image's own base is what records which. The base is pinned by digest (`NODE_IMAGE` in
`runtime.Dockerfile`), and every image CI or a test pulls stays anonymously pullable (ADR-0066).

### D5 — A malformed map fails start-up and names no value

A key naming an engine the catalogue does not publish, a value that cannot be an image reference,
or a duplicate key makes parsing throw `EngineImageConfigurationError`. The control plane parses the
map when `apps/web/server/engines/images.ts` is first loaded and the runner manager at start-up, so
a malformed map stops the process rather than failing a run later.

The digest rule — in production, a value not pinned by `sha256` digest also throws — applies where
the value is **consumed**: the runner manager's `engineImagesFor` (`requireDigest` when
`NODE_ENV=production`) and every image-taking driver's `assertDigestPinnedEngineImages` at
construction. The control plane checks the reference's shape and not its digest, in production or
out. It never starts a container and never hands the value to a driver; it reads the map only to
answer `installed` and the run route's `422 engine_not_installed`, and whether a value is pinned
changes neither answer. Requiring the digest there too would refuse the shipped `compose.yaml`,
whose `web` container inherits `NODE_ENV=production` from the `Dockerfile`'s `web` target while its
engine image defaults to the locally built `agent-workspace/runtime:dev` (found in #328's review). The message names the
configuration keys at fault and **never a value**: an image reference carries a registry host and
usually a project id, and naming the key is enough to fix the mistake.

An empty map is legal for the parser, and a driver built over one refuses every `create()`. A
runner manager whose driver takes an image (`docker`, `cloud-run-service`) can serve no run without
one, though, so it refuses to start on an empty map rather than come up healthy and fail every
allocation (ADR-0015). The guard sits in the runner manager's start-up, not in the drivers, whose
total `create()` the `no-image-at-all` replay vector pins.

### D6 — One engine per ACA session pool

An Azure Container Apps dynamic-session pool is provisioned with one container image, and nothing
in its management API lets one allocation ask for another. The `aca-sessions` driver therefore
takes the pool's single `engine` (`ACA_SESSION_POOL_ENGINE`, default `claude-agent-sdk`) instead of
a map, and refuses a run for any other engine before an allocation is made. A deployment offering
two engines over ACA provisions two pools and two runner managers. This is recorded as a per-driver
gap in `docs/runtime-driver-matrix.md`, as the issue's stop condition asks, rather than a redesign
of pooling.

### D7 — Upgrade path and the development default

- The pre-ENG-07 `RUNTIME_IMAGE` is still read as the `claude-agent-sdk` entry when
  `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` is absent. It is never a default for any other
  engine.
- The control plane now needs the map too. Every deployment template this repository ships
  (`compose.yaml`, the CLI's compose template, the Helm chart, the GCP Terraform modules) passes it
  to the web process. A deployment that manages its own environment adds the variable to the web
  process before upgrading, or every engine reports `installed: false` and every run answers
  `422 engine_not_installed`; `docs/deploy/engine-images.md` has the step.
- The runner manager is **not** independently upgradable: its allocation body now requires
  `engine`, which a control plane from the previous release does not send. ADR-0069's
  single-revision cutover already covers this — the previous revision of `web`, `gateway` and the
  runner manager is drained before the new one starts.
- Outside production, a control plane whose environment configures no engine image at all assumes
  `claude-agent-sdk → agent-workspace/runtime:dev`, the tag `compose.yaml` builds, so `pnpm dev`
  keeps working. Production has no default. Whether a configured value must be digest-pinned is
  the runner manager's decision, not the control plane's (D5).
- The release publishes `agent-workspace/runtime-claude-agent-sdk`. Its contents equal the
  pre-ENG-07 `agent-workspace/runtime` apart from the two labels; an operator who pins the old
  repository name moves to the new one at the next release.

No database migration is part of this unit.

## Consequences

- Adding an engine is adding its adapter package and its image variable; no Dockerfile, driver or
  catalogue edit.
- A pulled image says what it carries. That the labels describe the bytes is a hypothesis the Lean
  model states and the build check enforces; Lean cannot prove what an image contains.
- `Test Runtime` probes the catalogue's first engine; verifying a second engine's image is a probe
  with that engine.
- **Open item for the second engine.** `apps/runner/package.json` still depends on
  `@agent-workspace/engine-claude-agent-sdk`, because the runner's tests and type-check import it.
  With one engine that is exactly one adapter per image. An `ENGINE=pi` build would fail at
  `pnpm install`, because the runner's manifest names a workspace package the build did not copy.
  The unit that adds the second adapter (#307) moves adapters out of the runner's production
  dependencies; until then `scripts/engine-images.mjs` lists only `claude-agent-sdk`, so CI never
  attempts that build.
- While `ENGINE_IDS` publishes one engine, `422 engine_not_installed` is reachable only by leaving
  `claude-agent-sdk` out of the map; a second published engine reaches it with its own id.

## Alternatives considered

- **One multi-engine image.** Rejected: every sandbox would carry every SDK, its native binaries
  and its licences, whichever engine the run uses. Out of scope in the issue too.
- **Let the runner report which engines it can start.** Rejected: `installed` would depend on a
  network call from the catalogue route, and the refusal would come after a sandbox was created.
- **Keep one `image` string per driver and add `images` beside it.** Rejected: two ways to say one
  thing, and the string would silently win for engines the map omits.
