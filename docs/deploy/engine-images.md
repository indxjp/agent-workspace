# Engine runtime images

A runtime image carries the engine-neutral runner and exactly one engine adapter. A deployment
chooses which engines it offers by which runtime images it configures, and
`GET /api/engines` reports `installed: true` for exactly those engines. The decision is
[ADR-0073](../adr/0073-one-runtime-image-per-engine.md).

## Images

The release publishes one image per engine that has an adapter package:

| Engine             | Image                                      | Base                                            |
| ------------------ | ------------------------------------------ | ----------------------------------------------- |
| `claude-agent-sdk` | `agent-workspace/runtime-claude-agent-sdk` | `node:24.19.0-bookworm-slim` (glibc), by digest |
| `openai-agents`    | `agent-workspace/runtime-openai-agents`    | `node:24.19.0-bookworm-slim` (glibc), by digest |
| `pi`               | `agent-workspace/runtime-pi`               | `node:24.19.0-bookworm-slim` (glibc), by digest |
| `mastra`           | `agent-workspace/runtime-mastra`           | `node:24.19.0-bookworm-slim` (glibc), by digest |

Each image carries two labels, readable with `docker image inspect`:

- `io.agent-workspace.engine`: the engine id;
- `io.agent-workspace.engine-version`: `<adapter version>+<SDK version>`.

To build one locally:

```sh
node scripts/engine-images.mjs            # <engine> <image> <engine-version>, one per line
docker build --build-arg ENGINE=claude-agent-sdk -f runtime.Dockerfile --target runtime .
docker build --build-arg ENGINE=openai-agents --build-arg ENGINE_VERSION=0.0.0+0.20.0   -f runtime.Dockerfile --target runtime .
docker build --build-arg ENGINE=pi --build-arg ENGINE_VERSION=0.0.0+1.1.0    -f runtime.Dockerfile --target runtime .
docker build --build-arg ENGINE=mastra --build-arg ENGINE_VERSION=0.0.0+1.76.0   -f runtime.Dockerfile --target runtime .
```

The runner's manifest names no adapter (ADR-0074 D11): the build installs the selected adapter
through its own `--filter` and links it into the runner, so an image never carries a second one.

## Configuration

Set one variable per engine, on **both** the control plane (`web`) and the runner manager:

| Surface                  | Setting                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Environment              | `AGENT_WORKSPACE_RUNTIME_IMAGE_<ENGINE>`, for example `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` |
| Helm                     | `images.runtime.<engine>`, for example `images.runtime.claude-agent-sdk`                               |
| `create-agent-workspace` | writes `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` into `.env`                                    |
| Azure Container Apps     | the session pool's image; `ACA_SESSION_POOL_ENGINE` names its engine                                   |

`<ENGINE>` is the engine id upper-cased, with `-` written `_`.

- In production every value the runner manager starts sandboxes from must be pinned by `sha256`
  digest; a tag-only value stops it at start-up. The control plane checks only that each value is an
  image reference: it never starts a container, so a tag there still reports the engine installed.
  This is what lets `docker compose up` run a production-built `web` against the locally built
  `agent-workspace/runtime:dev`, while the compose runner manager runs with `NODE_ENV=development`.
- A key naming an unknown engine, or a value that is not an image reference, stops the process at
  start-up. The error names the variable and never its value.
- A runner manager whose driver takes an image (`docker`, `cloud-run-service`) and has none
  configured at all refuses to start.
- An engine with no image reports `installed: false`, and a run on it answers
  `422 engine_not_installed` before any sandbox is created.
- An Azure dynamic-session pool runs one image, so it offers one engine. Provision a second pool
  and runner manager to offer a second engine.

## Upgrading from a single runtime image

Before ENG-07 a deployment set one `RUNTIME_IMAGE` on the runner manager. After the upgrade:

1. `RUNTIME_IMAGE` is still read as the `claude-agent-sdk` entry when
   `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` is not set, so the runner manager keeps working.
   It is **not** independently upgradable, though: the manager's allocation body now requires
   `engine`, and a control plane from the previous release does not send it.
   [ADR-0069](../adr/0069-the-engine-identity-migrations-require-a-single-revision-cutover.md)'s
   single-revision cutover already covers this: drain the previous revision of `web`, `gateway` and
   the runner manager before the new one starts, as the deployment guides say.
2. **The control plane now needs the map too.** The templates this repository ships
   (`compose.yaml`, the CLI's `compose.yaml`, the Helm chart, the GCP and Azure Terraform modules)
   already pass it to the web process. If you manage the web process's environment yourself, add
   `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` (or `RUNTIME_IMAGE`) to it **before** you roll
   out the new web image. Without it every engine reports `installed: false` and every run answers
   `422 engine_not_installed`.
3. A Helm values file that sets `images.runtime` to a single string still renders; the chart passes
   it as `RUNTIME_IMAGE`. Move it to `images.runtime.claude-agent-sdk` at your next change.
4. The image is published as `agent-workspace/runtime-claude-agent-sdk`. Its contents are the old
   `agent-workspace/runtime` image plus the two labels. Update any pinned repository name at the next
   release.

## Offering the OpenAI Agents SDK engine

`openai-agents` ([ADR-0074](../adr/0074-the-openai-agents-sdk-runs-a-plain-agent-behind-the-port.md))
is offered exactly when its image is configured:

1. Pull or build `agent-workspace/runtime-openai-agents` and pin it by digest.
2. Set `AGENT_WORKSPACE_RUNTIME_IMAGE_OPENAI_AGENTS` (Helm: `images.runtime.openai-agents`) on
   **both** the web process and the runner manager. Until then `GET /api/engines` reports it
   `installed: false` and a run on it answers `422 engine_not_installed`.
3. No cutover step is needed. Migration `0028` only widens the engine `CHECK` constraints to admit
   `openai-agents`; a revision from the previous release writes only `claude-agent-sdk`, which the
   old and the new constraints both admit, so old and new revisions may serve side by side during
   the rollout. Roll back **before** any run uses `openai-agents`: the previous release cannot parse
   a stored `openai-agents` row, so after one exists, rolling back means restoring the backup.

The engine reaches its model only through the gateway, so the sandbox needs no egress to OpenAI or
Anthropic; the SDK's trace export is disabled in the adapter.

## Offering the pi coding agent engine

`pi` ([ADR-0081](../adr/0081-pi-runs-in-process-with-a-pinned-loader-behind-the-port.md)) is
offered the same way. `scripts/engine-images.mjs` derives `runtime-pi` from `packages/engine-pi`,
and `runtime.Dockerfile` needs no change:

1. Pull or build `agent-workspace/runtime-pi` and pin it by digest.
2. Set `AGENT_WORKSPACE_RUNTIME_IMAGE_PI` (Helm: `images.runtime.pi`) on **both** the web process
   and the runner manager. Until then `GET /api/engines` reports it `installed: false` and a run on
   it answers `422 engine_not_installed`.
3. No cutover step is needed. Migration `0029` only widens the engine `CHECK` constraints to admit
   `pi`, additively; old and new revisions may serve side by side during the rollout. Roll back
   **before** any run uses `pi`: the previous release cannot parse a stored `pi` row, so after one
   exists, rolling back means restoring the backup.

pi reaches its model only through the gateway, in Anthropic Messages, with the run token as the
model's `Authorization: Bearer` header; the gateway is unchanged. The adapter reads nothing from
`~/.pi` or `~/.agents` in the image, and `bash` runs with the request's environment rather than the
runner's.

## Offering the Mastra engine

`mastra` ([ADR-0084](../adr/0084-mastra-runs-a-plain-agent-with-memory-over-the-platform-store.md))
is offered the same way. `scripts/engine-images.mjs` derives `runtime-mastra` from
`packages/engine-mastra`, and `runtime.Dockerfile` needs no change:

1. Pull or build `agent-workspace/runtime-mastra` and pin it by digest.
2. Set `AGENT_WORKSPACE_RUNTIME_IMAGE_MASTRA` (Helm: `images.runtime.mastra`) on **both** the web
   process and the runner manager. Until then `GET /api/engines` reports it `installed: false` and a
   run on it answers `422 engine_not_installed`.
3. No cutover step is needed. Migration `0031` only widens the engine `CHECK` constraints to admit
   `mastra`, additively; old and new revisions may serve side by side during the rollout. Roll back
   **before** any run uses `mastra`: the previous release cannot parse a stored `mastra` row, so
   after one exists, rolling back means restoring the backup.

Mastra reaches its model only through the gateway, in the connection's own dialect (Anthropic
Messages, OpenAI Responses or Chat Completions), with the run token as the bearer; the gateway is
unchanged. The sandbox needs no egress to Mastra Cloud, PostHog or any observability vendor: the
adapter never constructs a `Mastra` instance, sets `MASTRA_TELEMETRY_DISABLED=1` and
`MASTRA_OFFLINE=1` before Mastra loads, and gives Mastra no database — memory is journalled into
the platform's session store, and a run whose environment carries a database variable is refused.
The image is larger than the others (Mastra's dependency tree carries several AI SDK provider
generations); check its size against your registry quota before the first rollout.

Outside production, a control plane with no runtime image configured at all assumes
`claude-agent-sdk → agent-workspace/runtime:dev`, the tag `compose.yaml` builds. Production has no
default. ENG-07 itself involved no database migration.
