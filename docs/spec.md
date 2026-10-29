# Build a Minimal Self-Hosted Enterprise Control Plane for the Claude Agent SDK

## 1. Objective

Build an extremely small, simple, fully self-hostable TypeScript platform that acts as an **enterprise deployment and management layer around the Claude Agent SDK**.

The core idea is:

> **Claude Agent SDK = agent programming/runtime layer**
> **This project = enterprise control plane, deployment layer, model gateway, sandbox manager, and simple management UI**

Do not replace the Claude Agent SDK.

Do not build another agent framework.

Do not recreate LangChain, Dify, n8n, Temporal, Kubernetes, LiteLLM, or an AI workflow builder.

Instead, provide the smallest possible layer that lets an enterprise administrator or non-technical operator configure, deploy, run, and manage Claude Agent SDK agents through a very simple UI.

The project should feel closer to:

> "A tiny self-hosted operating console for Claude Agent SDK"

than:

> "A large AI platform."

The primary principles are:

1. Claude Agent SDK native first.
2. TypeScript only.
3. Self-hosted first.
4. Cloud-agnostic.
5. Minimal dependencies.
6. Minimal number of services.
7. Minimal amount of custom agent logic.
8. Simple enough for a non-engineer to operate.
9. Everything important should be configurable from the UI.
10. Advanced options should remain hidden unless explicitly requested.
11. The same application should work on AWS, GCP, Azure, on-premise, or a normal Linux VM.
12. Deployment should require as few commands and concepts as possible.

---

# 2. Product Concept

A company should be able to run something conceptually like:

```bash
npx create-agent-workspace my-company-ai
cd my-company-ai
docker compose up -d
```

Then open:

```text
http://localhost:3000
```

The initial setup should ask only a few questions:

1. Which model provider do you want to use?
2. Enter the credentials.
3. Which sandbox/runtime should agents use?
4. Create the first administrator.
5. Create your first agent.

After this, the company should have a usable Claude Agent SDK deployment.

A non-technical administrator should then be able to manage agents without editing TypeScript, JSON, YAML, `.claude` directories, environment variables, MCP configuration files, or Docker files.

---

# 3. What the Platform Must Manage

The frontend should expose simple management interfaces for the major concepts needed around Claude Agent SDK.

The minimum product surface is:

* A general chat screen (the home page)
* Agents
* Projects
* Models / Model Providers
* Users
* API Keys
* Files
* Skills
* MCP Connectors
* Sandboxes / Runtime Profiles
* Sessions / Runs
* Sharing (agents and run history: private / workspace / public link)
* Permissions
* Secrets
* Basic usage and logs

Do not add unrelated features.

Specifically avoid adding things such as:

* vector databases
* RAG pipelines
* visual workflow builders
* graph databases
* arbitrary automation engines
* prompt marketplaces
* billing systems
* complex analytics dashboards
* CRM features
* document extraction pipelines
* custom orchestration DSLs

unless they become absolutely necessary for the Claude Agent SDK runtime itself.

One narrow exception (ADR-0147): on-demand text extraction from workspace files, and lexical
PostgreSQL full-text search over that extracted text, are in scope. Vector databases, embeddings
and RAG pipelines remain excluded, and extraction is never an ingestion pipeline.

Subtraction (ADR-0160): a deployment may leave out, and a workspace Owner may switch off, the
features that ADR names. This only removes surface; it adds none, and switching a feature off
deletes no data.

---

# 4. Architectural Principle

Use the following architecture.

```text
                         ┌──────────────────────────┐
                         │       Web Browser        │
                         │                          │
                         │ Simple Enterprise UI     │
                         └─────────────┬────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────┐
                         │      Control Plane       │
                         │                          │
                         │ Next.js / TypeScript     │
                         │ Auth                     │
                         │ Users                    │
                         │ Agents                   │
                         │ Files                    │
                         │ Skills                   │
                         │ MCP                      │
                         │ Runtime Config           │
                         └─────────────┬────────────┘
                                       │
                           create/run/resume agent
                                       │
                                       ▼
                         ┌──────────────────────────┐
                         │      Agent Runner        │
                         │                          │
                         │ Claude Agent SDK         │
                         │ TypeScript               │
                         └─────────────┬────────────┘
                                       │
                             Runtime Driver
                                       │
        ┌───────────────┬──────────────┼──────────────┬───────────────┐
        ▼               ▼              ▼              ▼               ▼
Local / Process   Sandboxed      Docker         Kubernetes    Managed Sandbox
Development Only  Process        Single Node    Enterprise    ACA Sessions
                  npx, no Docker                              AgentCore / ECS
                                                              Cloud Run / GKE
        │               │              │              │               │
        └───────────────┴──────────────┼──────────────┴───────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────┐
                         │    Agent Workspace       │
                         │                          │
                         │ /workspace               │
                         │ .claude/skills           │
                         │ files                    │
                         │ MCP configuration        │
                         │ Claude Agent SDK         │
                         └─────────────┬────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────┐
                         │      Model Gateway       │
                         │                          │
                         │ Anthropic-compatible     │
                         │ /v1/messages             │
                         └─────────────┬────────────┘
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
             Anthropic            Azure OpenAI         Other Providers
             Claude API              / OpenAI          via adapters
```

---

# 5. The engine is the core; the platform is thin

An agent's **engine** is the harness that turns an agent definition and a prompt into model calls,
tool calls and a stream of events. The implementation MUST use a real agent engine as the agent
runtime. The Claude Agent SDK:

```bash
@anthropic-ai/claude-agent-sdk
```

is the reference engine, and the only one today. Other engines are an extension point behind one
port, decided by [ADR-0065](adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md);
what the platform owns and what it still refuses to own are that record's D2 and D3.

Do not implement a custom agent loop.

Do not create a generic `Agent` abstraction that replaces an engine's semantics. An engine adapter
translates configuration onto its engine's native options; it does not re-implement what the engine
already does, and it does not emulate what the engine lacks — a capability an engine cannot honour
is a typed refusal (ADR-0065 D3).

Our abstraction should remain extremely thin.

For example, for the reference engine:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
```

should ultimately be what executes an agent.

The platform configuration should simply compile UI/database settings into that engine's options.

Conceptually, again for the reference engine:

```ts
const options = {
  cwd,
  model,
  mcpServers,
  skills,
  allowedTools,
  maxTurns,
  maxBudgetUsd,
  settingSources,
  env,
};

for await (const event of query({
  prompt,
  options,
})) {
  // stream event to UI
}
```

Avoid introducing unnecessary intermediate agent abstractions. The one abstraction that is
deliberate is the engine port itself: an interface, a registry and a gate, and nothing else
(ADR-0065 D2).

---

# 6. Claude SDK Feature Mapping

The management UI should directly represent Claude Agent SDK concepts wherever possible.

For example:

| UI Concept          | Claude Agent SDK Concept                  |
| ------------------- | ----------------------------------------- |
| Agent model         | `model`                                   |
| Working directory   | `cwd`                                     |
| Skills              | `skills` + `.claude/skills/`              |
| MCP connectors      | `mcpServers`                              |
| Tool permissions    | `allowedTools` / permission configuration |
| Max turns           | `maxTurns`                                |
| Budget              | `maxBudgetUsd`                            |
| Session resume      | `resume`                                  |
| Session persistence | `SessionStore`                            |
| Environment         | `env`                                     |
| Agent events        | SDK event stream                          |
| Subagents           | Agent SDK subagent configuration          |
| Hooks               | Agent SDK hooks                           |
| Telemetry           | OpenTelemetry support                     |

Prefer native SDK functionality over custom implementations.

---

# 7. Skills Management

Skills should remain completely compatible with Claude Agent SDK.

Do not invent a proprietary skill format.

A skill should ultimately be represented as:

```text
.claude/
└── skills/
    └── invoice-review/
        ├── SKILL.md
        └── optional-supporting-files
```

The UI should simply make managing these files easier.

For example:

```text
Skills

Invoice Review
Security Review
Financial Analysis
Document Writer
```

Selecting a skill should show:

```text
Name
Description
Instructions
Supporting Files
Allowed Tools
Assigned Agents
```

Users should be able to:

* create a skill
* edit a skill
* upload supporting files
* enable/disable it
* assign it to agents
* export it
* import an existing Claude skill directory

Internally, materialize the skill into the appropriate `.claude/skills/<name>/` directory before launching the agent.

The stored representation should stay compatible with Claude's native `SKILL.md` structure.

---

# 8. MCP Server Management

MCP should also remain Claude-native.

Support the MCP transport types used by the Agent SDK:

### Local stdio MCP

Example:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
}
```

### Remote HTTP MCP

```json
{
  "type": "http",
  "url": "https://example.com/mcp"
}
```

### SSE MCP

```json
{
  "type": "sse",
  "url": "https://example.com/mcp/sse"
}
```

The frontend should expose this simply.

Example:

```text
Connectors

[ + Add Connector ]

GitHub
Slack
Internal Database
Google Drive
Filesystem
```

The connector creation wizard should be:

```text
Name
Type
  ○ Remote URL
  ○ Local command

URL / Command

Authentication
  ○ None
  ○ API Key
  ○ Bearer Token
  ○ OAuth

[ Test Connection ]
[ Save ]
```

Do not expose raw MCP JSON to normal users.

Put raw JSON under an optional "Advanced" section.

Credentials must not be included directly in normal agent configuration.

Store secrets separately and inject them at runtime.

---

# 9. Model Gateway

Implement a very small TypeScript LLM gateway.

This should be conceptually:

> "The minimum TypeScript subset of LiteLLM necessary for Claude Agent SDK."

Do NOT attempt to port LiteLLM.

Do NOT support 100+ providers initially.

Do NOT implement LiteLLM's dashboard, billing, logging framework, virtual key ecosystem, or router architecture.

The primary compatibility contract should be:

```text
POST /v1/messages
POST /v1/messages/count_tokens
POST /v1/responses
POST /v1/chat/completions
GET  /v1/models
GET  /health
POST /v1/tools/:connectorId/mcp
POST /v1/tool-sandbox/mcp
POST /v1/tool-sandbox/endpoint/mcp
```

The `/v1/tools/:connectorId/mcp` route serves a run's tool connectors (ADR-0113 C16). It is a stateless streamable-HTTP MCP endpoint authenticated by the same run token. Every request re-checks that the run is active and that the connector is in the run's tool set, in the run's workspace and enabled. The route never resolves the model key and is never metered, and `GET` answers `405`.

The `/v1/tool-sandbox/mcp` route (ADR-0118 TS3) forwards a run's code-tool MCP requests to the session's tool sandbox. It is authenticated by the run token alone and only while the run is active. The sandbox origin is read from the run record, never from the request; the gateway recomputes the sandbox's own per-run bearer, so the agent sandbox never holds it. The route never resolves the model key, is never metered, and `GET` answers `405`.

The last route (ADR-0134 part 2) forwards a public tool endpoint call to the endpoint tool sandbox of an `mcp-project` endpoint client. Its only caller is the control plane, and its only credential is a 60-second endpoint grant the control plane signs with the gateway signing secret. The grant carries the sandbox origin and never verifies as a run token. The gateway recomputes the sandbox's own bearer from the client id, answers `401` to a missing, invalid or expired grant and `400` to a non-`http(s)` origin, never resolves the model key, is never metered, and `GET` answers `405`.

The gateway should expose the Anthropic Messages API format because Claude Agent SDK can be pointed at it using:

```text
ANTHROPIC_BASE_URL
```

The runner should therefore only need to know:

```text
ANTHROPIC_BASE_URL=http://gateway:4000
ANTHROPIC_AUTH_TOKEN=<internal-token>
```

The gateway decides which actual provider handles the request.

`POST /v1/responses` and `POST /v1/chat/completions` are the same contract for an engine that speaks
the OpenAI dialects rather than Anthropic Messages (ADR-0068). They carry the same run token, cross
the same authentication boundary and are metered the same way, and for an `openai`, `azure-openai`
or `openai-compatible` model connection the body is **passed through** to the upstream's matching
endpoint rather than translated. On an Anthropic-family connection they answer
`400 protocol_not_supported_for_connection`: an engine that wants an Anthropic model speaks
Anthropic Messages, which the gateway already serves. A request asking for a vendor-hosted tool
answers `400 hosted_tool_not_permitted`, because such a tool would execute outside the sandbox;
`POST /v1/responses` with `background: true` answers `400 background_not_supported`, because the
gateway publishes no route to retrieve a backgrounded response and so could never meter it; and a
request carrying `previous_response_id`, `conversation` or `prompt` answers
`400 vendor_state_not_permitted`, because that state lives at the model vendor, outside this
platform's session boundary. Every relayed body, on `POST /v1/responses` and
`POST /v1/chat/completions` alike, carries `store: false` for the same reason.

---

# 10. Model Gateway Provider Architecture

Define an intentionally tiny interface.

For example:

```ts
interface ModelProvider {
  id: string;

  listModels(context: RequestContext): Promise<ModelInfo[]>;

  createMessage(
    request: AnthropicMessageRequest,
    context: RequestContext,
  ): Promise<Response>;

  countTokens?(
    request: AnthropicCountTokensRequest,
    context: RequestContext,
  ): Promise<AnthropicCountTokensResponse>;

  capabilities: ModelCapabilities;
}
```

Do not build an enormous provider SDK.

Provider modules should be isolated.

Example:

```text
gateway/
├── index.ts
├── router.ts
├── types.ts
└── providers/
    ├── anthropic.ts
    ├── openai.ts
    ├── azure-openai.ts
    └── openai-compatible.ts
```

Start with these providers:

### P0

* Anthropic API
* Anthropic-compatible endpoint

### P1

* OpenAI
* Azure OpenAI

### P2

* generic OpenAI-compatible provider
* Google Gemini / Vertex if required

Native Claude deployments through:

* Anthropic
* Amazon Bedrock
* Google Cloud
* Microsoft Foundry

should preferably use their native Claude compatibility wherever possible rather than translating unnecessarily.

---

# 11. Anthropic → Non-Anthropic Translation

When an OpenAI or Azure OpenAI model is selected, translate the Anthropic Messages request into the provider's native request.

Prefer the OpenAI Responses API where available.

Implement only the parts required for practical Agent SDK compatibility.

The translation layer should cover:

* system instructions
* user messages
* assistant messages
* text content blocks
* tool definitions
* tool calls
* tool results
* streaming
* stop reasons
* usage
* errors
* reasoning/thinking where a meaningful mapping exists

Maintain exact Anthropic-compatible responses outward.

Example:

```text
Claude Agent SDK
      │
      │ Anthropic Messages API
      ▼
TypeScript Gateway
      │
      │ translation
      ▼
Azure OpenAI Responses API
      │
      │ response
      ▼
TypeScript Gateway
      │
      │ Anthropic response
      ▼
Claude Agent SDK
```

---

# 12. Never Pretend Providers Are Fully Equivalent

This is important.

A non-Claude model behind an Anthropic-compatible proxy should be treated as a compatibility mode.

Some Claude-specific features cannot be perfectly represented by other model APIs.

Therefore every model should expose capability metadata.

For example:

```ts
type ModelCapabilities = {
  streaming: boolean;
  toolUse: boolean;
  thinking: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
  contextManagement: boolean;
  webSearch: boolean;
  tokenCounting: boolean;
};
```

Before deploying an agent, compare:

```text
Agent Required Capabilities
vs.
Model Supported Capabilities
```

If something is unsupported, show:

```text
⚠ This model does not fully support Claude prompt caching.
The agent can still run, but behavior may differ.
```

Never silently claim 100% compatibility.

---

# 13. Model Management UX

The Models page should be extremely simple.

```text
Models

Claude Sonnet
Anthropic
Connected

GPT
Azure OpenAI
Connected

+ Add Provider
```

Adding a provider:

```text
Choose Provider

○ Anthropic
○ Microsoft Azure OpenAI
○ OpenAI
○ OpenAI-compatible
○ Advanced
```

Then ask only provider-specific values.

Azure example:

```text
Azure OpenAI

Endpoint
https://company.openai.azure.com

API Key
••••••••••••

Deployment
gpt-...

API Version
...

[Test Connection]

[Save]
```

Secrets should never be displayed again after creation.

---

# 14. Runtime (Sandbox) Architecture

Sandbox selection is a **first-class, user-selectable concept**, because Claude Agent SDK agents read and write files and execute shell commands.

The operator — not the codebase — decides where an agent actually runs.

The same agent definition must be runnable on a laptop with no Docker, on a single Docker host, on Kubernetes, or on a managed sandbox service offered by AWS, Google Cloud, or Azure, **without changing the agent, the skills, the MCP configuration, or any application code**.

Only the selected runtime changes.

## 14.1 Design rules

1. The runtime is stored in the database and chosen in the UI, exactly like the model provider.
2. Adding a runtime must never require touching the agent layer.
3. There is exactly one abstraction (`RuntimeDriver`). Do not add a second one.
4. Every driver must be honest about what it isolates. See section 14.5.
5. The default must work with zero infrastructure (`npx`), and the recommended production default must be a container.
6. No cloud is privileged. AWS, GCP, and Azure drivers are peers of the Docker and Kubernetes drivers.

## 14.2 The runtime driver interface

Keep the interface intentionally tiny.

```ts
type RuntimeDriverId =
  | "local"
  | "sandbox-runtime"
  | "docker"
  | "kubernetes"
  | "gke-agent-sandbox"
  | "aca-sessions"
  | "aws-agentcore"
  | "aws-ecs"
  | "cloud-run-sandbox"
  | "cloud-run-service"
  | "external"
  | "vercel-sandbox"
  | "cloudflare-sandbox";

interface RuntimeHandle {
  id: string;
  driver: RuntimeDriverId;
  /** container id, pod name, session identifier, task ARN, sandbox id */
  externalId: string;
  workspacePath: string;
  createdAt: Date;
  expiresAt?: Date;
}

interface RuntimeDriver {
  id: RuntimeDriverId;
  capabilities: RuntimeCapabilities;

  create(config: RuntimeConfig): Promise<RuntimeHandle>;

  startAgent(
    runtime: RuntimeHandle,
    request: AgentRunRequest,
  ): Promise<AgentConnection>;

  destroy(runtime: RuntimeHandle): Promise<void>;
}

interface AgentConnection {
  events: AsyncIterable<AgentEvent>;
  sessionId: Promise<string>;
  interrupt(): Promise<void>;
}
```

That is the whole contract. If a driver needs more, the driver keeps it internal.

## 14.3 The runtime container contract

Every driver except `local` and `sandbox-runtime` launches the **same runtime image**, which runs a small HTTP server around the Claude Agent SDK.

Defining one HTTP contract is what makes managed sandbox services usable without per-vendor agent code, because every managed sandbox product in this space is fundamentally "send an HTTP request into an isolated container."

```text
GET  /healthz            liveness / readiness
POST /run                start a run, respond with an SSE stream of SDK events
POST /interrupt          cancel the current run
POST /files              hydrate the workspace from a tar stream
GET  /files              collect persistent files as a tar stream
```

Provider-required aliases live in the same server so that no separate image is needed:

| Target                        | Required by the platform                                  |
| ----------------------------- | --------------------------------------------------------- |
| Amazon Bedrock AgentCore      | `POST /invocations` and `GET /ping` on port `8080`        |
| Azure Container Apps sessions | any path; the pool forwards the path to the target port   |
| Kubernetes / Docker / ECS     | our own paths on port `8080`                              |

The runtime process must be able to run as a non-root user, on `linux/amd64` and `linux/arm64`.

ARM64 is not optional: Bedrock AgentCore Runtime is Graviton-only, and an `amd64` image is rejected at deploy time.

## 14.4 Driver catalog

| Driver              | Tier | Isolation                         | Where the sandbox runs                  | Image source          |
| ------------------- | ---- | --------------------------------- | --------------------------------------- | --------------------- |
| `local`             | P0   | none (same process/user)          | the control-plane host                  | n/a                   |
| `sandbox-runtime`   | P0   | OS-level (bubblewrap/Seatbelt)    | the control-plane host                  | n/a                   |
| `docker`            | P0   | container (optionally gVisor)     | a Docker host                           | any OCI registry      |
| `kubernetes`        | P1   | container, or gVisor RuntimeClass | your cluster                            | any OCI registry      |
| `gke-agent-sandbox` | P2   | gVisor, managed by GKE            | GKE                                     | Artifact Registry     |
| `aca-sessions`      | P2   | Hyper-V per session               | Azure Container Apps dynamic sessions   | ACR                   |
| `aws-agentcore`     | P2   | Firecracker microVM per session   | Bedrock AgentCore Runtime               | ECR (ARM64)           |
| `aws-ecs`           | P2   | VM-isolated Fargate task          | ECS on Fargate                          | ECR                   |
| `cloud-run-sandbox` | P2   | Cloud Run sandbox in a gen2 microVM | Cloud Run service / worker pool       | Artifact Registry     |
| `cloud-run-service` | P1   | container, gen2 microVM           | one private Cloud Run v2 service per session | Artifact Registry |
| `external`          | P3   | vendor-defined                    | E2B, Daytona, Modal, Cloudflare         | vendor                |
| `vercel-sandbox`    | P3   | Firecracker microVM per session   | Vercel Sandbox (REST)                   | Vercel Container Registry |
| `cloudflare-sandbox` | P3  | container (Cloudflare Containers) | one container per session behind a bridge Worker | any OCI registry |

### `local`

Development only. Runs the Agent SDK as a child process of the runner.

Never advertise this as tenant isolation. The UI must show a persistent warning when an agent is deployed on `local`.

### `sandbox-runtime`

The zero-infrastructure default for `npx` installs on macOS and Linux.

Wraps the runner process with [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), which uses `bubblewrap` on Linux and Seatbelt on macOS to enforce filesystem and network allowlists **without a container**, routing all egress through a local proxy.

This covers file tools, hooks, and MCP servers, not only Bash. It shares the host kernel and does not terminate TLS, so it is a real improvement over `local` but not a substitute for a container in multi-tenant deployments. It does not support native Windows; on Windows the `npx` install defaults to `docker`.

### `docker`

The recommended single-machine production default. One container per session (or per agent, configurable).

Harden it by default:

```bash
docker run \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,nosuid,size=256m \
  --pids-limit 256 \
  --memory 1g --cpus 1 \
  --user 1000:1000 \
  --network agent-egress \
  -v workspace-<session>:/workspace \
  agent-workspace/runtime:<digest>
```

Where the deployment provides gVisor, expose it as a profile flag rather than a new driver (`docker run --runtime=runsc`).

### `kubernetes`

One Pod per runtime, with `NetworkPolicy`, `securityContext`, resource limits, and optionally a gVisor `RuntimeClass`. This is the portable enterprise driver and works on EKS, GKE, AKS, OpenShift, and self-hosted clusters through one Helm chart.

### Managed cloud sandbox drivers

`gke-agent-sandbox`, `aca-sessions`, `aws-agentcore`, `aws-ecs`, and `cloud-run-sandbox` exist so an enterprise can use the isolation product it has already bought and approved.

They are thin: each is a small module that creates a session, forwards `POST /run`, streams the response back, and destroys the session. See **Appendix A** for the exact configuration of each.

### `cloud-run-service`

`cloud-run-sandbox` assumes a `gcloud run deploy --sandbox-launcher` / in-container `sandbox` CLI surface that does not exist in the Cloud Run Admin API or gcloud SDK as of this writing (checked against gcloud SDK 581.0.0, stable/alpha/beta). `cloud-run-service` is the real driver: `create()` deploys one private Cloud Run v2 service per session (`--no-allow-unauthenticated`, gen2 execution environment, `maxInstanceRequestConcurrency: 1`), `destroy()` deletes that exact service, and the manager forwards the same `POST /run` / `/interrupt` / `/files` HTTP contract to it over HTTPS with a Google-signed identity token scoped to that one service URL instead of the plain-HTTP reachability `docker` and `kubernetes` assume on a private network. See `docs/adr/ADR-cloud-run-service-driver.md` and `packages/runtime/src/cloud-run.ts`. `cloud-run-sandbox` stays in the catalog as the id a future driver may claim once that surface ships; nothing in this codebase implements it today.

### `external`

One driver for third-party sandbox vendors (E2B, Daytona, Modal, Vercel Sandbox, Cloudflare Sandboxes), selected by a `provider` field.

Do not create a package per vendor. Do not let a vendor SDK type leak past the driver boundary.

### `cloudflare-sandbox`

The native sandbox driver of the Cloudflare cloud (ADR-0120 LC1-LC4, LC6). It reuses the `external` driver's HTTPS forwarding and refusals under its own id, with a provider that calls a small bridge Worker shipped in `infra/cloudflare/sandbox-bridge/`, because Cloudflare Containers are driven from a Worker through Durable Objects and have no REST API for the manager to call. It refuses every network policy (`none`, `restricted` and `open`) with `network_policy_unsupported` until a live run proves Cloudflare denies egress (ADR-0131). A container has no fixed maximum lifetime; it sleeps after a period without activity. The bridge secret is a per-request credential and is never stored (LC6). Not yet verified live: no deployment has been exercised against a real account.

## 14.5 Runtime capabilities — never pretend drivers are equivalent

The same rule as section 12 applies to runtimes.

```ts
type RuntimeCapabilities = {
  isolation: "none" | "os-sandbox" | "container" | "gvisor" | "microvm";
  customImage: boolean;
  persistentFilesystem: boolean;
  sessionAffinity: boolean;
  maxSessionSeconds: number | null;
  networkPolicies: ("none" | "allowlist" | "open")[];
  execCommands: boolean;
  gpu: boolean;
  managedByProvider: boolean;
  typicalStartMs: number | null;
  fileTransfer: "push-archive" | "local-disk";
};
```

Before deploying, compare the requirements of the agent with the capabilities of the runtime and show a plain-language warning:

```text
⚠ This runtime cannot enforce a domain allowlist.
Network access will be all-or-nothing.

⚠ Sessions on this runtime end after 8 hours.
Longer runs will be resumed on a fresh sandbox.
```

Never silently downgrade a guarantee.

## 14.6 Session affinity and long runs

The control plane owns the mapping `session → runtime handle`.

Managed session products impose their own lifetimes: Azure Container Apps destroys a session once its cooldown expires, and Bedrock AgentCore stops a microVM after roughly 15 minutes idle or 8 hours of lifetime.

Do not fight this. When a sandbox is gone, create a new one and resume the Claude session with the `resume` option of the SDK, rehydrating the workspace from object storage. Session durability lives in PostgreSQL and object storage, never in a sandbox.

## 14.7 Isolation inside the sandbox

The Agent SDK has its own sandbox settings. Use them; do not reimplement them.

```ts
const options = {
  cwd,
  env,                    // only the secrets this agent needs
  settingSources: [],     // never inherit host or user .claude settings
  sandbox: { enabled: true, /* filesystem + network rules */ },
};
```

Two rules:

* `settingSources` must be `[]` unless the workspace explicitly opts in, so that no host-level `.claude` state leaks into a tenant runtime (see section 25).
* Inside an unprivileged container, nested OS sandboxing requires the weaker-nested-sandbox setting; treat that as defense in depth on top of the container, never as the boundary itself.

## 14.8 Choosing a runtime in the UI

```text
Runtime

○ This machine (development only)          no isolation
● Sandboxed process                        npx, no Docker required
○ Docker                                   recommended for self-hosting
○ Kubernetes
○ Managed sandbox
    ○ Azure Container Apps dynamic sessions
    ○ Amazon Bedrock AgentCore Runtime
    ○ Amazon ECS on Fargate
    ○ Google Cloud Run sandboxes
    ○ Google Cloud Run (per-session service)
    ○ GKE Agent Sandbox
    ○ Vercel Sandbox
    ○ Cloudflare Sandbox
○ External provider

[ Test Runtime ]   [ Save ]
```

`Test Runtime` must actually create a sandbox, run `echo`, and destroy it. A runtime that has never been tested is displayed as unverified.

Credentials for a cloud runtime are stored in the secrets layer (section 23) and are never shown again after creation.

## 14.9 Switching the runtime

Switching must be a normal UI operation, not a migration project. But it is only honest to promise that for runtimes the deployment can actually reach, so define the boundary precisely.

### What makes a runtime selectable

A driver appears in the runtime picker only when all three are true:

```text
1. A runtime connection exists       endpoint + credentials, stored as a secret
2. The runtime image is reachable    published to the registry that platform can pull from
3. Test Runtime has passed           create → echo → destroy, at least once
```

Otherwise it is shown disabled with the reason, never hidden:

```text
○ Azure Container Apps dynamic sessions
  Not configured — no session pool registered.        [ Set up ]

○ Amazon Bedrock AgentCore Runtime
  Image not published to ECR for this account.        [ How to publish ]
```

The control plane registers and selects runtimes. It does not build images, create session pools, or provision clusters. Adding a new cloud is a one-time administrator task documented in Appendix A; switching between already-registered runtimes is a dropdown.

### What happens on save

Changing the runtime on an agent takes effect **from the next run**. Runs already in flight finish on the runtime they started on, and the UI says so.

Before saving, compare the requirements of the agent against `RuntimeCapabilities` and show the differences in plain language. Block the save only when the agent would be broken, warn otherwise:

```text
Changing runtime: Docker → Azure Container Apps dynamic sessions

⚠ Domain allowlist is not supported on this runtime.
  "Restricted" will become all-or-nothing egress.

✕ This agent uses a local command connector (Filesystem MCP).
  This runtime has no outbound network for package downloads.
  Bundle the connector into the runtime image, or switch it to a remote URL.
```

The switch itself is recorded in the audit log (section 36).

### What survives a switch

| State                | Survives | Why                                                      |
| -------------------- | -------- | -------------------------------------------------------- |
| Workspace files      | ✓        | Object storage is the source of truth; the new sandbox is hydrated |
| Skills, connectors   | ✓        | Materialized into the workspace at launch                |
| Claude session       | ✓        | Session id in PostgreSQL, resumed with `resume`          |
| Anything else in the old sandbox | ✗ | Sandboxes are disposable by definition          |

For the session to actually resume, the durable `SessionStore` (section 20) must persist the Agent SDK session state, not only the session id. If session state lives solely in `CLAUDE_CONFIG_DIR` inside a sandbox, a runtime switch silently loses the conversation — treat that as a release blocker, not a detail.

### Reversibility

Switching back must restore the previous behaviour exactly. Runtime selection therefore stores a profile reference, never a copy of the profile, and never mutates the agent definition.

If switching a runtime requires editing the agent, the abstraction has failed and the driver is wrong, not the agent.

---

# 15. Runtime Profiles

A runtime profile is the reusable, human-readable answer to "how much machine, and how much network."

```text
Runtime Profiles

Standard
Docker · 1 CPU · 1 GB RAM · 5 GB disk · Network: Restricted

Heavy
Kubernetes · 4 CPU · 8 GB RAM · 20 GB disk

Read Only
Docker · 1 CPU · 1 GB RAM · Filesystem: Read only · Network: None
```

## 15.1 Profile schema

```ts
interface RuntimeProfile {
  id: string;
  name: string;

  driver: RuntimeDriverId;
  /** Which stored runtime connection (cluster, session pool, ECR image...) to use. */
  runtimeConnectionId?: string;

  cpu?: number;
  memoryMb?: number;
  diskMb?: number;

  networkPolicy: "none" | "restricted" | "open";
  allowedDomains?: string[];

  filesystem: "read-only" | "read-write";
  persistPaths?: string[];

  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;

  /** Escape hatch. Validated per driver with Zod, hidden under "Advanced". */
  driverConfig?: Record<string, unknown>;
}
```

`driverConfig` is where per-cloud detail lives (session pool name, RuntimeClass, task definition ARN, machine size). It must never be required to create a working profile: every driver ships defaults.

## 15.2 How the network policy maps to each driver

`networkPolicy` is the setting operators care about most, and it is also the setting whose enforcement differs most between drivers. Map it explicitly and report what was actually achieved.

| Driver              | `none`                        | `restricted` (allowlist)                             | `open`                    |
| ------------------- | ----------------------------- | ---------------------------------------------------- | ------------------------- |
| `sandbox-runtime`   | default deny                  | domain allowlist via the built-in proxy (no TLS inspection) | allow all          |
| `docker`            | `--network none`              | egress network plus an allowlisting proxy container  | bridge network            |
| `kubernetes`        | default-deny `NetworkPolicy`  | `NetworkPolicy` plus egress proxy                    | permissive policy         |
| `gke-agent-sandbox` | default deny (built in)       | `NetworkPolicy` on the sandbox pod                   | permissive policy         |
| `aca-sessions`      | `sessionNetworkConfiguration.status: EgressDisabled` | **not supported** — approximate with an egress-enabled pool behind a proxy | `EgressEnabled` |
| `aws-agentcore`     | network mode `Sandbox`        | VPC mode plus security groups / egress proxy         | network mode `Public`     |
| `aws-ecs`           | no NAT, no internet gateway   | security groups, VPC endpoints, egress proxy         | public subnet or NAT      |
| `cloud-run-sandbox` | default (no `--allow-egress`) | `--allow-egress` plus VPC egress and Cloud NAT rules | `--allow-egress`          |

Where a driver cannot express a policy natively, the UI must say so rather than silently accepting it.

`none` must always mean "the gateway and nothing else", never "no network at all" — an agent that cannot reach the gateway cannot call a model and is useless.

On drivers whose egress control is a single all-or-nothing switch (`aca-sessions`, `aws-agentcore` in sandbox mode, `cloud-run-sandbox` without `--allow-egress`), verify per driver whether the gateway is still reachable with egress off. Where it is not, implement `none` as *egress enabled, restricted to the gateway by our proxy*, and record in `RuntimeCapabilities` that the enforcement point is the proxy rather than the platform. This is a required item in the driver conformance suite (Appendix A.12), not an assumption.

## 15.3 Filesystem and persistence

Workspaces are ephemeral by default. Object storage is the source of truth (section 16).

```text
object storage → hydrate → /workspace → run → collect persistPaths → object storage
```

Every driver declares how files reach it in `RuntimeCapabilities.fileTransfer`: `push-archive` streams one tar archive to the runtime's `POST /files` and collects with `GET /files` (every sandbox), and `local-disk` extracts it on the control-plane host's own disk (`local`).

## 15.4 Advanced isolation

gVisor, Firecracker, Kubernetes `RuntimeClass`, and vendor sandboxes are **deployment options selected by a profile**, never concepts that leak into the agent layer.

Adding one must not change `runner/src/claude.ts`.

---

# 16. File Management

Files should be deliberately simple.

Do not build RAG.

Do not automatically create embeddings.

Do not create an indexing pipeline.

Files are simply workspace files accessible by the Claude Agent SDK's file tools.

One narrow exception (ADR-0147): a file's text may be extracted **on demand**, when an agent tool or
an API request asks for it, never on upload and never by a background job over every file. The
extracted text may be stored in PostgreSQL and searched lexically (`tsvector` / `tsquery`),
scoped by the same tenant, workspace and RBAC rules as the file itself. There are still no
embeddings, no vector column or store, no external search or extraction service, and no automatic
retrieval injected into prompts.

The UI should provide:

```text
Files

/
├── contracts/
│   ├── agreement.pdf
│   └── pricing.xlsx
├── instructions.md
└── report-template.docx
```

Allow:

* upload
* download
* delete
* rename
* folders
* preview metadata
* read a file's extracted text, and search file text lexically (ADR-0147)
* assign folders/files to an agent
* read-only or read-write access

A run's caller may also attach files to one run (ADR-0146). The request names catalogue file ids;
each is authorised exactly as `GET /api/files/:id` would authorise it, and the run receives it as a
`read` grant, so a run with attachments cannot run commands. Every refusal (no such id, another
workspace's file, a file the caller's role may not read, a session-scoped token) is the same
`404 file_not_found`, so a caller cannot tell a file that is not theirs from one that is not there.
The `.attachments/` prefix is reserved for a session's own uploads. A workspace member cannot write
under it or delete a file or folder in it (`400 reserved_path`), read it (`404 file_not_found`; it
is also absent from a root listing) or assign a file in it to an agent or a project (`400
unknown_file`); moving a file out of it by rename promotes it into the ordinary workspace. A session
token may attach only a file under its own `.attachments/<sessionId>/` prefix, which it fills
through `POST /api/sessions/:id/attachments` on a surface with `parts.attachments`: one file a
request (10 MiB, name in the `name` query parameter), at most 20 files or 50 MiB a session, and 10
uploads a minute a session. Any other id stays the same concealed `404`. The session retention pass
(`AW_SESSION_TRANSCRIPT_RETENTION_DAYS`) deletes `.attachments/<sessionId>/` of each session whose
stored conversation it purges; a promoted file is kept.

Storage should use an abstraction like:

```ts
interface ObjectStore {
  put(...)
  get(...)
  delete(...)
  list(...)
}
```

Support:

### Development

Local filesystem.

### Production

S3-compatible object storage.

This allows:

* AWS S3
* MinIO
* GCS-compatible adapters if needed
* Azure Blob adapter later

For the default fully self-hosted stack, use MinIO or local S3-compatible storage.

Before starting a runtime:

```text
object storage
      ↓
hydrate
      ↓
/workspace
      ↓
Claude Agent SDK
```

After completion, files explicitly marked as persistent can be synchronized back.

---

# 17. Agent Management

Creating an agent should not resemble writing infrastructure configuration.

The main flow should be approximately:

## Step 1 — Agent

```text
Name

Customer Support Agent

Instructions

You help employees answer questions...
```

## Step 2 — Model

```text
Claude Sonnet

or

GPT via Azure
```

## Step 3 — Capabilities

```text
Files
✓ Company Handbook

Skills
✓ Customer Support

Connectors
✓ Internal Search
✓ Jira
```

## Step 4 — Permissions

```text
What can this agent do?

✓ Read files
✓ Write files
○ Run commands
○ Access unrestricted internet
```

## Step 5 — Runtime

```text
Environment

Standard Sandbox
Docker
1 CPU / 1 GB RAM

[Deploy Agent]
```

That should be enough.

---

# 18. Agent Detail UX

An agent page should look approximately like:

```text
Customer Support Agent

[Run] [•••]

Overview
Model
Files
Skills
Connectors
Permissions
Runtime
Runs
```

The Overview should show:

```text
Status       Ready
Model        Claude Sonnet
Runtime      Standard Sandbox
Files        12
Skills       3
Connectors   2

Latest Run
2 minutes ago
Completed
$0.08
```

Do not create a complex dashboard.

---

# 19. Runtime Chat / Agent Visualization

When an agent is running, the user should see what it is doing without needing to understand technical traces.

Example:

```text
User
Prepare a summary of these contracts.

Agent
Reviewing uploaded files...

✓ Read agreement-01.pdf
✓ Read agreement-02.pdf

Searching internal contract database...

✓ Internal Contract Search

Preparing summary...

Agent
Here is the summary...
```

Provide an expandable:

```text
Show technical details
```

which can reveal:

* SDK events
* tool calls
* MCP calls
* token usage
* runtime events
* errors

but keep it hidden by default.

Use streaming rather than waiting for the full run.

SSE is sufficient unless WebSockets provide a clear benefit.

Prefer fewer moving parts.

---

# 19.5 Home — One General Chat Screen

The home page is a chat screen, in the shape people already know from Claude and ChatGPT.

It is not a dashboard, not a list page, and not a launcher that sends the user somewhere else. The user
opens the product, types, and the run starts on that screen.

```text
┌──────────────────────────────────────────────────────────┐
│  What can I help with?                                   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Ask anything…                                     │  │
│  │                                                    │  │
│  │  [ Agent: General ▾ ]  [ + Files ]  [ + Connectors ]│ │
│  │                                        [ Send ]     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Recent                                                  │
│  Contract summary — Contract Review — 2 minutes ago      │
│  Handbook question — Customer Support — yesterday        │
└──────────────────────────────────────────────────────────┘
```

## 19.5.1 Rules

1. The composer is the primary control. Three pickers live inside it and nothing else:

   ```text
   Agent        which agent runs the message   (default: the workspace "General" agent)
   Files        workspace files for this chat  (subset of what the agent may read)
   Connectors   MCP connectors for this chat   (subset of what the agent may use)
   ```

2. **The home chat introduces no new runtime concept.** A message from the home screen is an ordinary
   run of the selected agent, in that agent's runtime, with that agent's permissions. The file and
   connector pickers are per-session *narrowing*, never widening: a picker can only offer what the
   selected agent is already permitted to use, so the chat screen can never grant capability the agent
   does not have.

3. The workspace ships one built-in agent named **General**: default model, no files, no connectors,
   read-only sandbox. It exists so the first message works before anyone has configured anything.
   It is an ordinary row in `agents`, editable and deletable like any other.

4. Switching the agent mid-conversation starts a new session. Say so in one line rather than silently
   forking, because the Claude session belongs to one agent configuration.

5. Once the first message is sent, the screen becomes the run view of section 19 — the same activity
   list, the same collapsed **Show technical details**. There is no second chat implementation.

6. Agents, Files, Skills and Connectors remain browsable pages. Home is the fast path, not the only path.

---

# 20. Session Management

Use Claude Agent SDK sessions rather than inventing a conversation format.

Store:

```text
workspace user
agent
Claude session ID
created_at
updated_at
status
```

Use the Agent SDK's session resume behavior.

Implement a TypeScript `SessionStore` backed by durable storage.

Prefer using PostgreSQL because PostgreSQL is already required for control-plane metadata.

Avoid adding Redis only for session storage.

The platform should support:

```text
New session
Resume session
List sessions
Archive session
```

Forking can be added later if it remains easy.

---

# 20.5 Projects

A project is a named container for related work: an instruction, a set of files, a default agent, and the
sessions that belong to it. Nothing more.

It exists because enterprise work arrives in bundles — "Q3 supplier contracts", "SOC 2 evidence",
"Onboarding rewrite" — and without a container every one of those becomes either a throwaway chat or a
whole new agent.

```text
Projects

Q3 Supplier Contracts        Contract Review    18 sessions   34 files
SOC 2 Evidence               General            4 sessions    12 files
Onboarding Rewrite           Document Writer    9 sessions    6 files
```

## 20.5.1 What a project is

```ts
interface Project {
  id: string;
  workspaceId: string;
  name: string;
  /** Extra context appended after the agent's own instructions. Optional. */
  instructions?: string;
  /** Which agent new sessions in this project start with. */
  defaultAgentId?: string;
  fileIds: string[];
  mcpServerIds: string[];
  visibility: "private" | "workspace" | "public";
  createdBy: string;
}
```

## 20.5.2 Rules

1. A project is **configuration reuse, not a runtime**. Running a project session is running its agent
   with the project's files and connectors already selected. There is no project executor, no project
   state machine, no per-project sandbox concept.
2. Project instructions are appended to the agent's instructions. They never replace them, and they
   never grant tools or permissions — permissions belong to the agent (section 17, step 4).
3. A session belongs to at most one project. Moving a session between projects is allowed and audited.
4. Project files are ordinary workspace files (section 16) referenced by the project. A project is not a
   second filesystem.
5. Do not add project-level model settings, budgets, or runtimes in the MVP. If a project genuinely needs
   different settings, that is an agent.

> Implementation note (RF-001): the current application already persists workspace and project model
> defaults, which conflicts with rule 5. The refactoring safe default preserves that existing behavior
> without expanding it until Product and Architecture ratify removal or retention. See the
> [refactoring decision ledger](architecture/refactoring/claude-agent-workspace-refactoring-decisions.md).

---

# 20.6 Sharing and Publishing

Users must be able to share what they have built and what an agent has done: an **agent** and a
**session/run transcript** are both shareable objects.

This is a link-sharing feature. It is not a marketplace, not a social feed, and not a catalogue with
ratings, installs, or discovery ranking. See section 38.

> Refactoring note (RF-001): the safe default, ratification owner, and first blocking unit for
> runnable public links live in the
> [refactoring decision ledger](architecture/refactoring/claude-agent-workspace-refactoring-decisions.md).
> Runnable public links specifically are not a currently releasable capability.

## 20.6.1 Three visibilities, for every shareable object

```text
Private     the creator only                          (default)
Workspace   any member of the workspace with a role that allows viewing
Public      anyone with the link, unauthenticated, read only
```

Shareable objects are exactly:

```text
agent
session (its run history / transcript)
project
skill
```

Files are **not** independently shareable. A file reaches a viewer only as part of a published session
transcript, and only when the publisher explicitly includes attachments.

## 20.6.2 Publishing a session (run history)

```text
Share “Contract summary”

Who can see this
  ○ Only me
  ○ Everyone in Meridian Manufacturing
  ● Anyone with the link

Include
  ✓ Messages
  ✓ Tool and connector activity      (names and durations, not arguments)
  ○ Technical details                (raw SDK events, token usage)
  ○ Output files                     (1 file, 6.1 KB)

⚠ A published transcript is a snapshot. Later messages in this session are not added
  to the published page unless you publish again.

[ Copy link ]   https://agents.meridian.example/s/pub_7Yk2mQ
```

Rules:

1. Publishing is a **snapshot**, produced at publish time and stored separately from the live session.
   A public link must never be a live view of a session that is still being written to.
2. Secrets, environment variables, connector credentials, internal endpoint URLs and gateway tokens are
   removed from a published snapshot at creation time — not filtered at render time.
3. Tool arguments and file contents are excluded unless the publisher opts in per category, because a
   transcript routinely contains customer data the publisher has not read back.
4. A published link is revocable. Revoking is immediate and permanent for that link; re-publishing mints
   a new one.
5. Optional expiry (`24 h`, `7 days`, `30 days`, `never`) and optional passphrase. Neither is required.
6. Every publish, re-publish and revoke is an audit event (section 36) recording who, what, and which
   visibility.

## 20.6.3 Publishing an agent

Two distinct things a user may want, and they must never be confused:

```text
Share the definition   the viewer sees how the agent is configured, and can copy it into
                       their own workspace. Nothing runs.

Share a runnable link  the viewer can send messages to the agent from a minimal public page.
                       Runs execute in the publisher's workspace, on the publisher's budget.
```

Definition sharing is the default and the safe one. Runnable links are opt-in and carry hard limits:

```text
Runnable public link

Budget cap            $20 total, then the link stops accepting messages
Per-visitor limit     5 messages per hour
Runtime               inherits the agent's runtime profile
Permissions           the agent's permissions, minus "Run commands" and minus write access
Files                 read-only, and only files the publisher explicitly attaches
Sessions              one ephemeral session per visitor, never shared, never resumable by another visitor
Kill switch           a single "Stop accepting messages" control, and an automatic stop on budget
```

A published definition never carries secrets. Connector credentials, model provider credentials and
environment values are replaced by named placeholders, and the importer is told what to supply:

```text
This agent needs:
  · a model connection      (any Claude-capable provider)
  · connector "Jira"        (you will be asked for your own credentials)
  · 2 files                 (not included in this share)
```

## 20.6.4 Administration

Workspace administrators need one page listing every share that exists:

```text
Shared links

Contract summary          session   Public link   created by Aya Ito     14 views    [Revoke]
Customer Support Agent    agent     Workspace     created by Aya Ito                 [Revoke]
Invoice Triage            agent     Runnable      created by Kenji Sato  $12 of $20  [Stop]
```

A workspace-level policy switch disables public links entirely (`Public sharing: off`), and it must be
enforced server-side, not by hiding the button. Existing public links are suspended, not deleted, when
the policy is turned off, so that turning it back on does not silently re-expose the wrong things —
suspended links stay listed with their state visible.

---

# 21. Users and RBAC

Keep authorization simple.

Use one top-level concept:

```text
Workspace
```

Users belong to a workspace.

Roles:

```text
Owner
Admin
Builder
Viewer
```

Suggested permissions:

### Owner

Everything.

### Admin

Users, agents, models, API keys, connectors, runtimes.

### Builder

Create/edit/run agents, skills, files, connectors where permitted.

### Viewer

Run permitted agents and view their own sessions.

Roles are monotonic: a higher role always has at least the access of a lower role, in the order
Owner, Admin, Builder, Viewer. Where a literal reading of the clauses above would give a lower role
something a higher one lacks, the higher role gets it (ADR-0116, ADR-0152).

Sharing rights follow the same four roles and add nothing new:

```text
Owner     everything, including the workspace "Public sharing: off" policy switch
Admin     revoke or suspend any share in the workspace, see the shared-links page
Builder   share own agents, projects and sessions to workspace or public link
Viewer    share own sessions to workspace; public links only if the workspace allows it
```

Publishing a **runnable** public link (section 20.6.3) requires Admin or Owner, because it spends the
workspace budget on behalf of anonymous visitors.

Do not implement an enterprise IAM product.

Use generic OIDC for enterprise SSO.

This should allow integration with systems such as:

* Microsoft Entra ID
* Okta
* Keycloak

without provider-specific authentication logic.

A local bootstrap administrator may be supported for initial setup.

---

# 22. API Keys

Provide workspace API keys for programmatic access.

Example:

```text
API Keys

Production
ak_live_********
Last used: 2h ago

CI
ak_live_********
Last used: yesterday

+ Create API Key
```

API keys should support:

```text
name
workspace
permissions
created_at
last_used_at
expires_at
revoked_at
```

Show the raw secret only once.

Store only a secure hash.

> Refactoring safe default (RF-001): an API key may create a durable Session only after RF-101
> provides a machine `WorkspacePrincipal` that explicitly owns it. Today `resolveActorUserId` still
> falls back to the workspace's oldest human Owner; RF-101 characterizes that behavior, and until
> RF-101 lands an API key must not borrow a human Owner for an own-scoped Session operation; see the
> [refactoring decision ledger](architecture/refactoring/claude-agent-workspace-refactoring-decisions.md).

---

# 23. Secrets

Never put provider credentials directly into:

* agent definitions
* skill files
* MCP files
* database-visible JSON
* frontend responses

Provide a central secrets layer.

Examples:

```text
ANTHROPIC_API_KEY
AZURE_OPENAI_API_KEY
GITHUB_TOKEN
INTERNAL_DATABASE_TOKEN
```

The runtime receives only the secrets required by that particular agent.

Eventually support external secret managers, but do not make this a requirement for the MVP.

The default implementation may encrypt values in PostgreSQL using a deployment-level master key.

---

# 24. Security Boundary

Treat the agent sandbox as potentially untrusted.

The web/control plane must never run arbitrary agent-generated shell commands itself.

The architecture must be:

```text
Control Plane
     │
     ▼
Runtime Manager
     │
     ▼
Sandbox
     │
     ▼
Agent SDK
```

Never:

```text
Browser
   ↓
Next.js API route
   ↓
exec(agentGeneratedCommand)
```

Network access should be configurable.

Recommended production default:

```text
deny by default
```

with explicit allowlists.

Provider credentials should ideally be injected by a gateway/proxy outside the sandbox so the agent does not directly receive master credentials.

---

# 25. Multi-Tenant Isolation

Do not allow Claude configuration from one workspace to leak into another.

Each runtime must have its own:

```text
cwd
CLAUDE_CONFIG_DIR
workspace files
skills
configuration
```

For enterprise/shared environments, explicitly control Claude setting sources and memory behavior rather than accidentally reading host-level `.claude` state.

Never mount a developer's actual:

```text
~/.claude
```

inside customer runtimes.

Each workspace and session must get a distinct directory.

---

# 26. Model Gateway Authentication

The Agent SDK should authenticate to the internal model gateway, not directly expose provider master keys.

Conceptually:

```text
Agent Sandbox
      │
      │ short-lived internal token
      ▼
Model Gateway
      │
      ├── Anthropic secret
      ├── Azure secret
      └── OpenAI secret
```

This provides a natural place for:

* credential injection
* model routing
* simple usage accounting
* audit logging
* provider failover later

Do not implement complex billing.

---

# 27. Minimal Database Model

Keep the schema understandable.

The main tables should roughly be:

```text
workspaces
users
memberships

agents
model_connections
runtime_profiles

skills
mcp_servers
files

agent_skills
agent_mcp_servers
agent_files

projects
project_files
project_mcp_servers

sessions
runs

shares
share_views

api_keys
secrets
audit_events
```

> Implementation note (RF-001): the current schema also includes `run_events`, a tenant-scoped,
> per-Run ordered child table used for durable SSE replay. See
> [RF-001 — Durable `run_events` are the production authority](adr/RF-001-durable-run-events-are-the-production-authority.md).

`shares` is one table for every shareable object, not one table per type:

```text
shares
  id
  workspace_id
  subject_type      agent | session | project | skill
  subject_id
  visibility        private | workspace | public
  mode              definition | runnable        (agents only)
  snapshot          JSONB, the redacted published copy (sessions)
  include           JSONB, what the publisher opted into
  budget_cap_usd    runnable links only
  spent_usd
  expires_at
  passphrase_hash
  created_by
  revoked_at
```

Do not normalize aggressively unless necessary.

Use JSONB where it meaningfully reduces code.

---

# 28. Technology Stack

Everything we own should be TypeScript.

Recommended stack:

### Runtime

```text
Node.js
TypeScript
```

### Package management

```text
pnpm workspace
```

### Frontend / Control Plane

```text
Next.js
React
TypeScript
Tailwind
shadcn/ui
```

### Agent Runtime

```text
@anthropic-ai/claude-agent-sdk
```

### Database

```text
PostgreSQL
Drizzle ORM
```

### File Storage

```text
S3-compatible object storage
```

### Validation

```text
Zod
```

### Observability

```text
OpenTelemetry
```

### Containers

```text
Docker
Docker Compose
```

### Enterprise cluster

```text
Kubernetes
Helm
```

Avoid:

```text
Redis
Kafka
Temporal
RabbitMQ
ElasticSearch
Qdrant
Celery
Python services
Go services
Java services
microservice proliferation
```

unless a real technical constraint proves they are required.

---

# 29. Repository Structure

Keep the repository intentionally small.

Use something close to:

```text
agent-workspace/
│
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── server/
│   │   └── package.json
│   │
│   └── runner/
│       ├── src/
│       │   ├── agent.ts
│       │   ├── sessions.ts
│       │   ├── runtime.ts
│       │   └── server.ts
│       └── package.json
│
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── config.ts
│   │   │   └── schemas.ts
│   │   └── package.json
│   │
│   ├── gateway/
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── router.ts
│   │   │   └── providers/
│   │   │       ├── anthropic.ts
│   │   │       ├── openai.ts
│   │   │       ├── azure-openai.ts
│   │   │       └── openai-compatible.ts
│   │   └── package.json
│   │
│   ├── runtime/
│   │   ├── src/
│   │   │   ├── driver.ts
│   │   │   ├── local.ts
│   │   │   ├── sandbox-runtime.ts
│   │   │   ├── docker.ts
│   │   │   ├── kubernetes.ts
│   │   │   └── managed/
│   │   │       ├── aca-sessions.ts
│   │   │       ├── aws-agentcore.ts
│   │   │       ├── aws-ecs.ts
│   │   │       ├── cloud-run-sandbox.ts
│   │   │       ├── gke-agent-sandbox.ts
│   │   │       └── external.ts
│   │   └── package.json
│   │
│   └── cli/
│       ├── src/
│       └── package.json
│
├── infra/
│   ├── docker/
│   ├── helm/
│   └── examples/
│
├── migrations/
│
├── compose.yaml
├── Dockerfile
├── pnpm-workspace.yaml
├── package.json
├── .env.example
└── README.md
```

Do not create packages unless they represent genuinely reusable boundaries.

If two packages become only a few files, merge them.

Low code volume is a feature.

---

# 30. NPX Experience

Publish a small project generator.

Conceptually:

```bash
npx create-agent-workspace@latest my-agent-platform
```

The generated project should already contain everything required to run.

Then, with no Docker and no cloud account:

```bash
cd my-agent-platform
npx agent-workspace start
```

or, for the standard self-hosted stack:

```bash
docker compose up -d
```

or, for development:

```bash
pnpm install
pnpm dev
```

The generator may optionally ask:

```text
? Database
  ● Included PostgreSQL
  ○ External PostgreSQL

? Storage
  ● Local / MinIO
  ○ Existing S3

? Runtime
  ● Sandboxed process   (no Docker required)
  ○ Docker
  ○ Kubernetes
  ○ Managed sandbox     AWS / GCP / Azure

? Authentication
  ● Local administrator
  ○ OIDC
```

Defaults should always be provided, and the runtime default must be the strongest isolation the machine can actually deliver, as described in Appendix A.3.

A user should be able to press Enter through the wizard and get a functioning deployment.

---

# 31. Cloud-Agnostic Deployment

Do not create fundamentally different applications for AWS, Azure, and GCP.

The same images should run everywhere.

Cloud differences are allowed in exactly two places: the container registry, and the runtime driver an operator selects. Both are configuration, not code paths in the application. **Appendix A** documents each one concretely, including ECR, Artifact Registry, ACR, ECS, Cloud Run, and Azure Container Apps.

## Single VM

Supported environments include:

```text
AWS EC2
Google Compute Engine
Azure VM
on-prem Linux VM
bare metal
```

Deployment:

```bash
docker compose up -d
```

## Kubernetes

Same containers should support:

```text
EKS
GKE
AKS
OpenShift
self-hosted Kubernetes
```

through one Helm chart.

Do not create separate AWS/GCP/Azure implementations unless cloud-specific infrastructure is optional.

---

# 32. Deployment Modes

Support two clear modes.

## Simple Mode

Target:

```text
development
small enterprise deployments
single tenant
internal applications
```

Components:

```text
Web
Runner
Gateway
PostgreSQL
Object Storage
```

Run with Docker Compose.

## Cluster Mode

Target:

```text
multiple teams
high concurrency
stronger tenant isolation
enterprise production
```

Components:

```text
Web
Gateway
Runner Manager
PostgreSQL
S3
Kubernetes sandbox pods
```

Run with Helm.

Do not introduce a third architecture unless necessary.

---

# 33. Keep Services Minimal

A normal single-node deployment should have approximately:

```text
web
runner
gateway
postgres
storage
```

Five components are enough.

If `web` and `runner` can safely be merged without compromising sandbox boundaries, evaluate that.

Do not split things merely because "microservices are scalable."

Optimize for operational understandability.

---

# 34. API Design

Expose a very small control-plane API.

Examples:

```text
POST   /api/agents
GET    /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id
DELETE /api/agents/:id
GET    /api/agents/:id/feedback

POST   /api/agents/:id/runs
GET    /api/runs/:id
GET    /api/runs/:id/events
POST   /api/runs/:id/feedback

GET    /api/sessions
POST   /api/sessions/:id/messages
POST   /api/sessions/:id/attachments   upload one file for a visitor session (ADR-0146; surface with parts.attachments)

GET    /api/models
POST   /api/model-connections

GET    /api/skills
POST   /api/skills

GET    /api/connectors
POST   /api/connectors

GET    /api/files
POST   /api/files

GET    /api/users
POST   /api/users

GET    /api/runtime-profiles
POST   /api/runtime-profiles

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id

POST   /api/shares                     create a share for agent|session|project|skill
GET    /api/shares                     workspace administration list
DELETE /api/shares/:id                 revoke

GET    /p/:token                       public page (session snapshot or agent definition)
POST   /p/:token/messages              runnable public link only, rate limited
GET    /p/s/:name                      hosted surface chat page (ADR-0105: loopback, or framed by an allowed origin)
POST   /p/s/:name/sessions             session bootstrap: loopback publisher, or visitor from an allowed origin
GET    /p/s/:name/widget.js            one-tag widget loader (ADR-0105: loopback, or a surface with allowed origins)
GET    /p/s/:name/try                  host page whose body is the one script tag (ADR-0105)
POST   /mcp/projects/:name              public MCP endpoint of an mcp-project endpoint client (ADR-0134: endpoint-scoped API key only, rate limited)
GET    /.well-known/oauth-authorization-server                          OAuth authorization-server metadata (RFC 8414; ADR-0134 part 3)
GET    /.well-known/oauth-protected-resource/mcp/projects/:name         protected-resource metadata of an mcp-project endpoint (RFC 9728)
GET    /oauth/authorize                 consent page for one endpoint client (browser session only)
POST   /oauth/authorize                 approve or deny that consent (browser session only, same-origin)
POST   /oauth/token                     authorization_code with PKCE S256, client_credentials, refresh_token (rate limited)
POST   /oauth/revoke                    revoke an access or refresh token (RFC 7009)
POST   /api/a2a/agents/:agentName      A2A v0.3 JSON-RPC of the agent's production version (ADR-0135: endpoint-scoped or workspace API key, rate limited)
GET    /api/a2a/agents/:agentName/.well-known/agent-card.json   its A2A agent card (ADR-0135)
```

`POST /api/sessions/:id/messages` is an intended route in this sketch, not a shipped handler.
The current route inventory classifies its sub-resource but does not declare that POST route
(F-093). Continuing a session currently uses `POST /api/agents/:id/runs` with `sessionId`.

The public routes live under `/p/` rather than `/api/` so that "is this request authenticated?" is
answerable by looking at the path prefix alone.

The one other prefix is `/mcp/`, where a project's public tool endpoint (ADR-0134) lives. It is not a page: it answers `401` without an API key, and it accepts only an API key scoped to that project's endpoint client.

The OAuth 2.1 authorization server for endpoint clients (ADR-0134 part 3) lives under `/oauth/`, and its discovery documents under `/.well-known/`, because the OAuth and MCP specifications fix those paths. The discovery documents and the token and revocation endpoints are public by protocol: the last two authenticate the endpoint client, never a member. The consent page requires a browser session. An access token they issue is accepted only by the endpoint it names (`/mcp/projects/:name` or an agent's A2A endpoint, whose protected-resource metadata is declared with a mandate beside the A2A routes, ADR-0135).
`/api/a2a/` is a protocol prefix, not a resource: A2A v0.3 fixes where a client finds an agent and its card (ADR-0135), so the two routes above are the only ones under it, they authorise as `POST /api/agents/:id/runs`, and `a2a` has no row in the §21 permission table.

`POST /api/agents/:id/runs` takes an optional `attachments`: one to ten `{ "fileId" }` objects,
without repeats, naming workspace files the run receives read-only (ADR-0146, §16). A file the
caller cannot read is `404 file_not_found`; an agent whose permissions do not include `readFiles`
is `422 run_attachments_unreadable`. An attachment over 10 MiB, more than 20 attachments, or attachments over 50 MiB in
total (a session's earlier uploads count), are `422 run_attachments_too_large`, and an agent whose runtime profile uses the `local`
driver, which is never handed session files, is `422 run_attachments_unsupported_runtime`. None
of these creates a run.

Do not invent RPC frameworks if ordinary HTTP is enough.

---

# 35. Observability

Take advantage of the Claude Agent SDK's OpenTelemetry support.

Record basic information such as:

```text
run
session
agent
model
provider
status
duration
input tokens
output tokens
estimated cost
tool calls
errors
```

The default UI only needs:

```text
Runs

Completed     23s     $0.08
Completed     8s      $0.01
Failed        4s      -
```

A detailed trace viewer is not necessary for the MVP.

Allow external OTEL collectors through environment configuration.

---

# 36. Audit Log

Enterprise environments need a basic audit trail.

Record important control-plane actions:

```text
user created
user deleted
agent changed
provider credential changed
API key created
API key revoked
connector changed
permission changed
runtime profile changed
project created
project deleted
session published
public link revoked
runnable link stopped
public sharing policy changed
```

Do not log secrets.

The UI can simply show:

```text
Audit Log

Ito changed Customer Support Agent
2 minutes ago

Admin added Azure OpenAI
1 hour ago
```

No SIEM product needs to be built.

---

# 37. Configuration Philosophy

Configuration should follow this order:

```text
UI / Database
     ↓
typed internal config
     ↓
Claude Agent SDK config
     ↓
runtime
```

Avoid making users edit `.env` for normal application configuration.

Environment variables should primarily be for deployment-level values:

```text
DATABASE_URL
MASTER_ENCRYPTION_KEY
OBJECT_STORAGE_ENDPOINT
BOOTSTRAP_ADMIN
```

Agent-specific configuration belongs in the database.

---

# 38. Non-Goals

Explicitly treat the following as non-goals for the initial project:

* building an alternative Claude Agent SDK
* reproducing Claude Code
* reproducing LiteLLM
* arbitrary workflow automation
* RAG
* embeddings
* vector search
* model training
* model fine-tuning
* complex billing
* marketplace
* prompt management platform
* low-code workflow canvas
* Kubernetes management UI
* observability platform
* secret-manager replacement
* identity-provider replacement

RAG, embeddings and vector search stay non-goals. On-demand text extraction and lexical PostgreSQL
full-text search over extracted text are not RAG and are in scope (ADR-0147).

Sharing (section 20.6) is deliberately link-shaped and stops there. A share is a URL with a visibility
setting. Explicitly not in scope: a public directory of agents, install counts, ratings, comments,
follower graphs, forking of other people's agents, or any ranking of shared content. If a feature would
only make sense with a browsable catalogue behind it, it belongs to the marketplace non-goal above.

This project succeeds through subtraction.

---

# 39. Code Quality Rules

The implementation must aggressively optimize for readability.

Rules:

1. Prefer plain TypeScript.
2. Prefer functions over large class hierarchies.
3. Avoid abstract factories unless there are at least two real implementations.
4. Avoid dependency injection frameworks.
5. Avoid decorators.
6. Avoid event-bus abstractions unless genuinely needed.
7. Avoid internal RPC frameworks.
8. Avoid generated code unless useful.
9. Avoid premature caching.
10. Avoid generic repositories such as `BaseRepository<T>`.
11. Avoid huge configuration schemas.
12. Keep files small.
13. Keep public interfaces small.
14. Delete abstractions that are not paying for themselves.
15. Use the official Claude Agent SDK instead of reimplementing its features.

A contributor should be able to understand the major architecture in less than an hour.

---

# 40. Dependency Rule

Before adding a dependency, ask:

> Can this be implemented safely and clearly in approximately 50 lines of TypeScript?

If yes, strongly consider implementing it directly.

But do not reimplement security-sensitive standards such as:

* cryptography
* JWT verification
* OAuth
* database clients
* container protocols

Use mature libraries there.

---

# 41. Provider Compatibility Tests

Create one provider compatibility test suite.

Every provider must be tested against the same scenarios:

```text
✓ basic response
✓ streaming
✓ system prompt
✓ multi-turn conversation
✓ tool call
✓ tool result
✓ multiple tool calls
✓ errors
✓ usage
✓ cancellation
```

Additional optional tests:

```text
thinking
prompt caching
structured output
context management
```

Generate a matrix such as:

```text
                     Claude   Azure GPT   OpenAI
Streaming              ✓          ✓         ✓
Tools                  ✓          ✓         ✓
Thinking               ✓          ~         ~
Prompt caching         ✓          -         -
Context management     ✓          ~         ~
```

Where:

```text
✓ native/compatible
~ approximated
- unsupported
```

Never hide compatibility differences.

---

# 42. Agent SDK Upgrade Policy

Treat Claude Agent SDK as an upstream dependency.

Do not copy SDK internals into this repository.

Pin a compatible version.

Automate tests against upgrades.

Keep all SDK-specific translation concentrated in one small module, and keep exactly one such
module per engine:

```text
packages/engine-<id>/src/<boundary>.ts
```

is the only translation site for an engine's SDK ([ADR-0065](adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md) D2).
Until the port and the adapter packages exist (ENG-04), the reference engine's single site is:

```text
apps/runner/src/claude.ts
```

`tests/no-sdk-import.test.ts` holds the boundary as an allow-list of one file per engine SDK,
checked for set equality, so an unlisted importer fails the build.

If Anthropic changes an SDK option, updating the platform should require changing only a small number of files. The same holds for any other engine's SDK.

---

# 43. UI Design Principles

The interface should feel:

* calm
* sparse
* obvious
* enterprise-friendly
* understandable without documentation

Avoid:

* giant configuration forms
* excessive cards
* developer terminology
* nested settings pages
* JSON editors
* terminal-style interfaces
* dozens of navigation items

Use progressive disclosure.

Normal users see:

```text
Name
Model
Files
Skills
Connectors
Permissions
Runtime
```

Experts may click:

```text
Advanced
```

to see things like:

```text
maxTurns
maxBudgetUsd
environment
raw MCP settings
network policy
SDK options
```

---

# 44. Main Navigation

Keep the navigation close to:

```text
New chat            the home screen (section 19.5)

Projects
Agents
Files
Skills
Connectors

Runs

Administration
  Models
  Storage
  Users
  API Keys
  Runtimes
  Shared links
  Settings
```

Storage is listed for workspace Owners and Admins only; other roles do not see the entry, and the
pages behind it refuse them.

Recent chats are listed directly under "New chat" in the sidebar, newest first, capped at about ten with
a "See all" link into Runs. That list is navigation, not a feature area, and it must not grow filters,
folders or tags.

Entries whose feature is switched off (ADR-0160) are not shown. Nothing is ever added this way.

Do not add more top-level sections without strong justification.

---

# 45. Home Page

The home page is the general chat screen defined in section 19.5:

```text
What can I help with?

┌──────────────────────────────────────────────┐
│ Ask anything…                                │
│ [ Agent: General ▾ ] [ + Files ] [ + Connectors ]  [ Send ] │
└──────────────────────────────────────────────┘

Recent
Contract summary        Contract Review     2 minutes ago
Handbook question       Customer Support    yesterday
```

That is enough.

Do not begin with an analytics dashboard, and do not begin with a grid of agent cards either — the
first thing on the screen is a place to type.

The primary object in the product is still the Agent. The chat screen is how an agent is reached, and
the agent picker in the composer is what makes that visible.

---

# 46. Development Plan

Implement incrementally.

## Phase 0 — Foundation

Goal:

> Run one Claude Agent SDK agent through a browser on a self-hosted machine.

Implement:

* pnpm workspace
* Next.js application
* runner
* PostgreSQL
* Claude Agent SDK
* agent CRUD
* the general chat home screen and the built-in "General" agent (section 19.5)
* basic run API
* SSE event streaming
* one model connection: Anthropic
* local development runtime
* Docker Compose
* basic authentication

Completion criteria:

```text
npx create-agent-workspace demo
cd demo
docker compose up -d
```

opens the application and allows:

```text
Create Agent
→ enter instructions
→ select Claude
→ Run
→ receive streamed result
```

No other features are required before this works reliably.

---

# 47. Phase 1 — Enterprise Resources

Goal:

> Configure everything needed by an Agent SDK deployment through the UI.

Implement:

* files
* skills
* MCP connectors
* runtime profiles
* Docker sandbox driver
* tool permissions
* session resume
* durable `SessionStore`
* secrets
* API keys
* users
* RBAC
* projects
* sharing: private / workspace / public link, for agents and sessions
  (runnable public links come after the budget accounting in Phase 2)

Completion criteria:

A non-technical user can deploy an agent with:

```text
model
files
skills
MCP
permissions
sandbox
```

without editing code or configuration files.

---

# 48. Phase 2 — Model Gateway

Goal:

> Allow model/provider switching without changing Claude Agent SDK agent code.

Implement:

```text
/v1/messages
/v1/messages/count_tokens
/v1/models
```

Providers:

```text
Anthropic
OpenAI
Azure OpenAI
OpenAI-compatible
```

Implement:

* streaming translation
* tool translation
* usage translation
* error translation
* model capability metadata
* compatibility test suite

Completion criteria:

The same agent definition can switch from:

```text
Claude
```

to:

```text
Azure-hosted GPT
```

through the UI without changing agent application code.

Clearly warn users about unsupported Claude-specific features.

---

# 49. Phase 3 — Enterprise Deployment

Goal:

> Run the same platform across enterprise infrastructure.

Implement:

* Kubernetes runtime driver
* Helm chart
* runtime driver conformance test suite (Appendix A.12)
* one managed cloud sandbox driver, chosen by demand
  (`aca-sessions`, `aws-agentcore`, `aws-ecs`, or `cloud-run-sandbox`)
* external PostgreSQL support
* external S3 support
* OIDC
* audit log
* network restrictions
* OpenTelemetry
* horizontal runner scaling
* production deployment guide

Test on:

```text
generic Linux VM
AWS EC2
GCP Compute Engine
Azure VM

and at least one Kubernetes environment
```

Completion criteria:

No cloud-specific application fork exists.

The same container images run everywhere.

---

# 50. Phase 4 — Hardening, Only If Needed

Only after the previous phases work well, evaluate:

* gVisor
* Firecracker
* the remaining managed cloud sandbox drivers
* `gke-agent-sandbox`
* `external` third-party sandbox providers (E2B, Daytona, Modal, Vercel, Cloudflare)
* external secret managers
* additional LLM providers
* autoscaling
* provider failover
* more advanced usage limits
* SAML if OIDC is insufficient

Do not implement these preemptively.

---

# 51. Testing Strategy

Keep tests practical.

Required:

### Unit

```text
configuration mapping
provider translations
permission mapping
runtime configuration
```

### Integration

```text
Claude Agent SDK → gateway
gateway → provider
runner → sandbox
session resume
MCP connection
skills loading
file hydration
```

### End-to-End

One primary E2E flow:

```text
create user
↓
add model
↓
create agent
↓
upload file
↓
add skill
↓
add MCP
↓
deploy
↓
run
↓
tool executes
↓
stream result
↓
resume session
```

This flow is more important than hundreds of shallow unit tests.

---

# 52. README Requirements

The main README should explain the system in approximately five minutes.

Structure:

```text
What is this?

Architecture

Quick Start

Create Your First Agent

Deploy

Configuration

Security

Development

Claude Agent SDK Compatibility
```

The first commands should be approximately:

```bash
npx create-agent-workspace@latest my-agent-platform
cd my-agent-platform
docker compose up -d
```

Do not begin the README with architecture internals.

---

# 53. Important Architectural Constraint

Never let the control plane become another agent framework.

If we find ourselves implementing concepts such as:

```text
AgentLoop
ToolExecutor
ConversationEngine
MemoryEngine
Planner
TaskRouter
SubAgentOrchestrator
```

stop and check whether the agent engine already provides the capability.

In almost every case, it should.

An engine adapter is not one of these. It translates configuration onto its engine's native
options and its engine's output onto neutral events; when its engine lacks a capability it refuses
with a typed error rather than supplying one ([ADR-0065](adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md) D3).

The platform's responsibility is:

```text
configure
store
secure
deploy
isolate
observe
```

The engine's responsibility is:

```text
reason
plan
use tools
manage context
run the agent loop
```

Maintain that boundary rigorously.

---

# 54. Target Mental Model

The final product should feel like this:

```text
          ┌───────────────────────────┐
          │      Enterprise User      │
          └─────────────┬─────────────┘
                        │
                 simple clicks
                        │
                        ▼
          ┌───────────────────────────┐
          │       Agent Workspace     │
          │                           │
          │  Agent                    │
          │  Model                    │
          │  Files                    │
          │  Skills                   │
          │  MCP                      │
          │  Permissions              │
          │  Runtime                  │
          └─────────────┬─────────────┘
                        │
                   deploy/run
                        │
                        ▼
          ┌───────────────────────────┐
          │       Sandbox Runtime     │
          │                           │
          │    Claude Agent SDK       │
          │    + selected resources   │
          └─────────────┬─────────────┘
                        │
                  model request
                        │
                        ▼
          ┌───────────────────────────┐
          │      Model Gateway        │
          └──────┬─────────┬──────────┘
                 │         │
                 ▼         ▼
              Claude    Azure/OpenAI
```

---

# 55. Ultimate Success Criterion

A traditional enterprise should be able to deploy the repository into its own infrastructure and have a useful Claude Agent SDK environment without needing an AI platform engineer.

A typical workflow should become:

```text
1. Deploy the template.
2. Open the browser.
3. Add the company's model/API connection.
4. Upload files.
5. Add or select Skills.
6. Add MCP connectors.
7. Select a sandbox.
8. Configure basic permissions.
9. Click "Deploy Agent."
10. Start using the agent.
```

Everything underneath should still be recognizable as ordinary Claude Agent SDK configuration.

There should be no proprietary agent runtime.

There should be no unnecessary platform complexity.

There should be no Python requirement.

There should be no cloud lock-in.

There should be no requirement to use LiteLLM.

The project should be small enough that an experienced TypeScript engineer can read and understand nearly the entire codebase.

The desired end state is:

> **The smallest practical enterprise deployment layer for Claude Agent SDK.**

---

# Appendix A — Runtime Drivers and Cloud Deployment Reference

This appendix is the concrete counterpart to sections 14 and 15. It records exactly what each supported runtime looks like in practice, so that implementing a driver is a matter of following a recipe rather than researching a cloud product.

Nothing here may leak into `apps/runner`. All of it lives inside `packages/runtime/src/<driver>.ts` and `infra/`.

## A.1 Two independent choices

Operators make two separate decisions, and the platform must not couple them.

```text
1. Where does the CONTROL PLANE run?     web + gateway + PostgreSQL + object storage
2. Where do SANDBOXES run?               one per session
```

A perfectly normal configuration is a control plane on Azure Container Apps with sandboxes in Azure Container Apps dynamic sessions. Another perfectly normal configuration is a control plane on a single EC2 instance with sandboxes on Bedrock AgentCore. The database records the second choice as a runtime profile; the first is a deployment detail.

## A.2 Images and registries

The project ships exactly **two** images.

| Image                            | Contents                                   | Architectures            |
| -------------------------------- | ------------------------------------------ | ------------------------ |
| `agent-workspace/control-plane`  | Next.js web, model gateway, runner manager | `amd64`, `arm64`         |
| `agent-workspace/runtime`        | Node, Claude Agent SDK, the HTTP contract in section 14.3 | `amd64`, `arm64` |

Rules:

* Build both with `docker buildx` as multi-architecture images. Bedrock AgentCore is Graviton-only, so `arm64` is mandatory for the runtime image, not a nice-to-have.
* Deploy by digest, not by tag. Runtime profiles store a digest so that a run is reproducible and an image cannot be swapped underneath a tenant.
* The runtime image contains no credentials. Everything it needs arrives as environment variables at session creation (section A.11).
* Use immutable tags plus scan-on-push in every registry that supports it.

The registry is per cloud, and it is the only genuinely cloud-specific piece of the pipeline:

| Cloud       | Registry                    | Image reference                                              |
| ----------- | --------------------------- | ------------------------------------------------------------ |
| AWS         | Amazon ECR                  | `<account>.dkr.ecr.<region>.amazonaws.com/agent-workspace/runtime:<tag>` |
| GCP         | Artifact Registry           | `<region>-docker.pkg.dev/<project>/agent-workspace/runtime:<tag>` |
| Azure       | Azure Container Registry    | `<registry>.azurecr.io/agent-workspace/runtime:<tag>`         |
| On-premise  | Harbor, GitLab, Docker Hub  | `registry.example.com/agent-workspace/runtime:<tag>`          |

## A.3 No infrastructure — the `npx` path

This is the first-run experience and it must work with nothing installed but Node.

```bash
npx create-agent-workspace@latest my-agent-platform
cd my-agent-platform
npx agent-workspace start
```

`npx agent-workspace start` brings up the web app, the gateway, and the runner in one Node process, with:

* PostgreSQL: an embedded/local instance if none is configured, otherwise `DATABASE_URL`.
* Object storage: the local filesystem.
* Runtime driver: `sandbox-runtime` on macOS and Linux, `docker` on Windows, `local` only if neither is available.

The generator probes the machine and picks the strongest default it can actually deliver:

```text
? Runtime
  ● Sandboxed process   (detected: bubblewrap)      no Docker required
  ○ Docker              (detected: Docker 27.x)
  ○ Kubernetes          (detected: kubectl context "prod")
  ○ Managed sandbox     AWS / GCP / Azure
```

On Linux the `sandbox-runtime` path needs `bubblewrap`, `socat`, and `ripgrep` on `PATH`; if they are missing, say so and fall back rather than pretending the sandbox is active. Every screen in the UI must show which driver is in force, because "it looked sandboxed" is exactly the failure this platform exists to prevent.

## A.4 Single VM — Docker Compose

Target: AWS EC2, Google Compute Engine, Azure VM, on-premise Linux, bare metal. One `compose.yaml`, five services.

```text
web        control-plane image, port 3000
gateway    control-plane image, port 4000, ANTHROPIC-compatible
postgres   postgres:17
storage    MinIO (or an external S3 endpoint)
runtimes   created on demand by the docker driver, not declared in compose
```

The runner needs access to the Docker socket to create sandboxes, and that is a privileged capability: mount it only into the runner, never into the web container, and never into a sandbox. Where the host provides gVisor, set `runtime: runsc` on created containers through the profile.

Sandbox containers join a dedicated network whose only reachable destination is the gateway. That single rule gives a workable production default: the agent can call the model and nothing else.

## A.5 Kubernetes — one Helm chart everywhere

The same chart must install on EKS, GKE, AKS, OpenShift, and self-hosted clusters.

```text
Deployment   web
Deployment   gateway
Deployment   runner-manager
Job/Pod      one sandbox per session, created by the kubernetes driver
Secret       master encryption key, provider credentials
```

Per-sandbox Pod requirements:

* `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp `RuntimeDefault`.
* Resource `requests`/`limits` from the runtime profile.
* A default-deny egress `NetworkPolicy`, with an explicit allow to the gateway Service.
* `activeDeadlineSeconds` from `timeoutSeconds`.
* Optional `runtimeClassName: gvisor` where the cluster provides it.
* A dedicated namespace and ServiceAccount per workspace, with no cloud IAM binding by default.

The cloud-managed Kubernetes services differ only in storage classes, load balancer annotations, and how the node pool obtains registry credentials. Those belong in `infra/helm/values-<cloud>.yaml`, never in application code.

## A.6 AWS

### A.6.1 Push the images to ECR

```bash
export ACCOUNT=123456789012 REGION=ap-northeast-1 VERSION=0.1.0
export ECR=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com

aws ecr create-repository \
  --repository-name agent-workspace/control-plane \
  --image-tag-mutability IMMUTABLE \
  --image-scanning-configuration scanOnPush=true

aws ecr create-repository \
  --repository-name agent-workspace/runtime \
  --image-tag-mutability IMMUTABLE \
  --image-scanning-configuration scanOnPush=true

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ECR

docker buildx build --platform linux/amd64,linux/arm64 \
  -t $ECR/agent-workspace/control-plane:$VERSION --push -f Dockerfile .

docker buildx build --platform linux/amd64,linux/arm64 \
  -t $ECR/agent-workspace/runtime:$VERSION --push -f runtime.Dockerfile .
```

If your deployment tooling requires a single-architecture image for AgentCore, publish an additional `arm64`-only tag. A plain `docker build` on an x86 machine produces an `amd64` image that AgentCore rejects, and that failure is the single most common AWS setup mistake.

Set a lifecycle policy to expire untagged images, and grant the execution role `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, and `ecr:GetDownloadUrlForLayer` only.

### A.6.2 Control plane on ECS Fargate

```text
ALB → ECS service "web"      (control-plane image, port 3000)
      ECS service "gateway"  (control-plane image, port 4000, internal only)
RDS PostgreSQL               private subnet
S3                           workspace files
Secrets Manager              MASTER_ENCRYPTION_KEY, provider credentials
```

**Important constraint:** Fargate does not allow privileged containers, additional Linux capabilities, or mounting the Docker socket, because it runs on containerd and isolates every task in its own VM-backed environment. The `docker` driver therefore **cannot** run on Fargate. On AWS, choose `aws-ecs`, `aws-agentcore`, or `kubernetes` on EKS. Run the `docker` driver on EC2 only.

### A.6.3 Sandboxes with the `aws-ecs` driver

One Fargate task per session.

```text
create()      RunTask on the runtime task definition
              launchType FARGATE, networkMode awsvpc, private subnet, no public IP
              overrides: env for this run, cpu/memory from the profile
              ephemeralStorage from diskMb (21–200 GB)
startAgent()  wait for RUNNING, then POST /run to the task ENI address on :8080
destroy()     StopTask
```

Notes:

* Each Fargate task already runs in its own isolated VM environment, so a per-session task is a real isolation boundary, not just a namespace.
* Network policy comes from subnets and security groups: `none` means a private subnet with no NAT and only a VPC endpoint or security-group rule to the gateway.
* The task role should have no permissions beyond what the agent needs. Provider credentials stay in the gateway.
* Cold start is seconds, not milliseconds. Use this driver for longer runs, and prefer `aws-agentcore` for interactive chat.

### A.6.4 Sandboxes with the `aws-agentcore` driver

Amazon Bedrock AgentCore Runtime gives one Firecracker microVM per session, which is the strongest isolation available on AWS without operating it yourself.

Requirements our runtime image already satisfies (section 14.3):

```text
architecture   linux/arm64 only
port           8080
endpoints      POST /invocations, GET /ping
image source   ECR
```

Driver behaviour:

```text
create()      generate a session id of at least 33 characters, store it on the run
startAgent()  InvokeAgentRuntime with header
              X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <session id>
              stream the SSE response back to the UI
destroy()     StopRuntimeSession
```

Operational facts to encode in `RuntimeCapabilities`:

* One session, one microVM. The microVM is never reused across sessions, and memory is sanitized on termination.
* Idle sessions stop after about 15 minutes by default; maximum lifetime is about 8 hours per microVM lifecycle. The session id stays valid, and the next invoke provisions fresh compute — which is why section 14.6 resumes rather than fails.
* Filesystem is ephemeral unless session storage is configured; our workspace hydration path does not depend on it.
* Network modes: `Sandbox` (no external network), VPC, or `Public`. Map these to `none` / `restricted` / `open`.
* A second operation on a session that is being provisioned or torn down returns a retryable HTTP 409. Retry with short exponential backoff.
* The client is responsible for mapping users to session ids. Never derive a session id from user-controlled input.

### A.6.5 EKS

Use the `kubernetes` driver. AWS-specific values: IRSA for the runner ServiceAccount, ECR pull credentials on the node role, and the AWS Load Balancer Controller for ingress.

## A.7 Google Cloud

### A.7.1 Push the images to Artifact Registry

```bash
export PROJECT=my-project REGION=asia-northeast1 VERSION=0.1.0
export AR=$REGION-docker.pkg.dev/$PROJECT/agent-workspace

gcloud artifacts repositories create agent-workspace \
  --repository-format=docker --location=$REGION

gcloud auth configure-docker $REGION-docker.pkg.dev

docker buildx build --platform linux/amd64,linux/arm64 \
  -t $AR/control-plane:$VERSION --push -f Dockerfile .

docker buildx build --platform linux/amd64,linux/arm64 \
  -t $AR/runtime:$VERSION --push -f runtime.Dockerfile .
```

The deploying identity needs the Artifact Registry Reader role.

### A.7.2 Control plane on Cloud Run

```bash
gcloud run deploy agent-workspace-web \
  --image=$AR/control-plane:$VERSION \
  --region=$REGION \
  --port=3000 \
  --execution-environment=gen2 \
  --add-cloudsql-instances=$PROJECT:$REGION:agent-workspace \
  --set-secrets=MASTER_ENCRYPTION_KEY=master-key:latest \
  --set-env-vars=DATABASE_URL=...,OBJECT_STORAGE_ENDPOINT=...

gcloud run deploy agent-workspace-gateway \
  --image=$AR/control-plane:$VERSION \
  --region=$REGION --port=4000 \
  --no-allow-unauthenticated
```

Execution environments matter here:

* **gen1** is gVisor-based, with fast cold starts and emulation of most system calls.
* **gen2** is a microVM with full Linux compatibility. Cloud Run jobs and worker pools always use gen2.

Use gen2 for the runner. Storage is Cloud Storage, the database is Cloud SQL for PostgreSQL, and secrets come from Secret Manager.

### A.7.3 Sandboxes with the `cloud-run-sandbox` driver

Cloud Run sandboxes let one Cloud Run instance create isolated child sandboxes, which fits the runner exactly: the runner stays warm and each session gets a fresh sandbox in milliseconds instead of a new Cloud Run resource.

Deploy the runner with the sandbox launcher enabled:

```bash
gcloud run deploy agent-workspace-runner \
  --image=$AR/runtime:$VERSION \
  --region=$REGION \
  --sandbox-launcher \
  --execution-environment=gen2
```

Inside the container, the driver drives `/usr/local/gcp/bin/sandbox`:

```bash
# one ephemeral sandbox per run
sandbox do --write --env ANTHROPIC_BASE_URL=... -- node /app/run.js

# or a persistent named sandbox for a resumable session
sandbox run --detach --write --allow-egress --name sess-<id> -- sleep infinity
sandbox exec sess-<id> -- node /app/run.js
sandbox tar sess-<id> --export-tar /tmp/workspace.tar
```

Properties worth encoding:

* Sandboxed processes cannot see the parent workload, its environment variables, its secrets, or the metadata server. That is a security feature and also a requirement: pass the gateway URL and the short-lived token explicitly with `--env`, and never the master credentials.
* Read-only host filesystem by default; `--write` adds a temporary overlay; `--mount type=bind,source=...,destination=...` gives persistence.
* Egress is off unless `--allow-egress` is set, which maps cleanly onto `networkPolicy`.
* Sandboxes are ephemeral and deleted after execution unless created with `run --detach`.

For a pull-based runner that is not driven by HTTP requests, deploy it as a Cloud Run **worker pool** instead of a service; worker pools are gen2 only.

### A.7.4 Sandboxes with the `gke-agent-sandbox` driver

GKE Agent Sandbox is the managed gVisor path on GKE, aimed precisely at running LLM-generated code.

```text
CRDs             Sandbox, SandboxClaim, SandboxTemplate, SandboxWarmPool
isolation        gVisor kernel isolation
networking       default-deny; the sandbox cannot reach the cluster control plane
warm pools       sub-second provisioning
snapshots        pause/resume a sandbox with Pod snapshots
requires         GKE 1.35.2-gke.1269000 or later for full feature support
```

The driver creates a `SandboxClaim` against a `SandboxTemplate` that references our runtime image, waits for the Sandbox to become ready, and talks to it over the HTTP contract. Because this is still Kubernetes, most of the `kubernetes` driver is reusable; keep the delta small.

### A.7.5 What we deliberately do not use

**Vertex AI Agent Engine Code Execution** is a managed Python-oriented code sandbox with its own API (us-central1 only, 300-second execution timeout, 100 MB file limit, sandbox state retained up to 14 days). It executes snippets; it does not host a long-running Node service, and it does not accept our runtime image. It is not a runtime driver for this platform. Documented here so nobody spends a week discovering it.

## A.8 Azure

### A.8.1 Push the images to ACR

```bash
export RG=agent-workspace ACR=agentworkspace VERSION=0.1.0

az acr create -n $ACR -g $RG --sku Standard
az acr login -n $ACR

# build in the cloud, no local Docker required
az acr build -r $ACR -t agent-workspace/control-plane:$VERSION -f Dockerfile .
az acr build -r $ACR -t agent-workspace/runtime:$VERSION -f runtime.Dockerfile .
```

Prefer a user-assigned managed identity for image pull over admin credentials.

### A.8.2 Control plane on Azure Container Apps

```text
Container Apps Environment
  ├── container app "web"       control-plane image, ingress external, port 3000
  ├── container app "gateway"   control-plane image, HTTPS ingress external with Dynamic Sessions,
  │                             internal otherwise, port 4000
  └── session pool "runtimes"   custom container sessions (see below)

Azure Database for PostgreSQL Flexible Server
Azure Blob Storage (or MinIO for a fully self-hosted stack)
Azure Key Vault
```

Dynamic Session sandboxes cannot reach ingress restricted to apps inside the Container Apps
environment. When Dynamic Sessions are enabled, the gateway therefore has external HTTPS ingress
so sandboxes can call its model routes. Those routes require a short-lived, run-scoped bearer token;
only `/health` is anonymous. Without Dynamic Sessions, the gateway remains internal.

### A.8.3 Sandboxes with the `aca-sessions` driver

Azure Container Apps dynamic sessions provide **Hyper-V isolated** sandboxes allocated from a prewarmed pool in milliseconds. A custom container session pool runs our runtime image, so this is the natural Azure driver.

Session pool resource (`Microsoft.App/sessionPools`):

```json
{
  "type": "Microsoft.App/sessionPools",
  "name": "agent-workspace-runtimes",
  "location": "japaneast",
  "properties": {
    "environmentId": "/subscriptions/.../managedEnvironments/agent-workspace",
    "poolManagementType": "Dynamic",
    "containerType": "CustomContainer",
    "scaleConfiguration": {
      "maxConcurrentSessions": 100,
      "readySessionInstances": 5
    },
    "dynamicPoolConfiguration": {
      "executionType": "Timed",
      "cooldownPeriodInSeconds": 600
    },
    "customContainerTemplate": {
      "registryCredentials": {
        "server": "agentworkspace.azurecr.io",
        "identity": "<USER_ASSIGNED_IDENTITY_RESOURCE_ID>"
      },
      "containers": [
        {
          "name": "runtime",
          "image": "agentworkspace.azurecr.io/agent-workspace/runtime:0.1.0",
          "resources": { "cpu": 1.0, "memory": "2Gi" },
          "probes": [
            { "type": "Startup",  "httpGet": { "path": "/healthz", "port": 8080 },
              "periodSeconds": 5,  "failureThreshold": 30 },
            { "type": "Liveness", "httpGet": { "path": "/healthz", "port": 8080 },
              "periodSeconds": 10, "failureThreshold": 3 }
          ]
        }
      ],
      "ingress": { "targetPort": 8080 }
    },
    "sessionNetworkConfiguration": { "status": "EgressDisabled" },
    "managedIdentitySettings": [
      { "identity": "<USER_ASSIGNED_IDENTITY_RESOURCE_ID>", "lifecycle": "None" }
    ]
  }
}
```

Driver behaviour:

```text
pool endpoint   https://<POOL_NAME>.<ENVIRONMENT_ID>.<REGION>.azurecontainerapps.io

create()        pick a cryptographically random session identifier
                (4–128 chars; the first request allocates the session)
startAgent()    POST <POOL_ENDPOINT>/run?identifier=<SESSION_ID>
                Authorization: Bearer <Entra token>
                the path after the pool endpoint is forwarded to :8080 in the session
destroy()       POST <POOL_ENDPOINT>/.management/stopSession?identifier=<SESSION_ID>&api-version=2025-02-02-preview
inspect         .management/getSession, .management/listSessions
```

Non-negotiable configuration notes:

* Authentication is a Microsoft Entra token with audience `https://dynamicsessions.io`, and the caller needs the **Azure ContainerApps Session Executor** role on the session pool. Give that to the runner managed identity only. A token can reach *any* session in the pool, so it must never be exposed to end users.
* Keep `managedIdentitySettings.lifecycle` at `None`. Setting it to `Main` lets code inside the sandbox mint Entra tokens for the pool identity, which is exactly what untrusted agent code must not be able to do.
* Session identifiers are security-relevant. Generate them cryptographically, map them to workspace and user in PostgreSQL, and never accept one from the client.
* Sessions are destroyed after the cooldown period with no traffic; treat a "session not found" response as a signal to create a new sandbox and resume (section 14.6).
* Egress is disabled by default, which is the right default. There is no native domain allowlist, so `restricted` has to be approximated with an egress-enabled pool behind our proxy — and the UI must say so.
* Anything inside a session is visible to whoever uses that session. One session per user or per conversation, never shared.
* Logs reach Log Analytics as `AppEnvSessionConsoleLogs` when the container writes to stdout/stderr; pool health is visible as `PoolReadyPodCount`, `PoolPendingPodCount`, and `PoolExecutingPodCount`.
* Dynamic sessions are regional; confirm availability before offering the driver in a given region.

### A.8.4 AKS

Use the `kubernetes` driver. Azure-specific values: workload identity for the runner ServiceAccount, ACR attached to the cluster for image pull, and Application Gateway or NGINX for ingress.

## A.9 Third-party sandbox providers (`external`)

One driver, one `provider` field, no vendor types past the boundary.

| Provider          | Isolation                | Notable properties                                        |
| ----------------- | ------------------------ | --------------------------------------------------------- |
| E2B               | microVM                  | dedicated kernel per sandbox; session state bounded by plan |
| Daytona           | container (shared kernel) | persistent by default, workspace lives until deleted      |
| Modal             | container/microVM        | idle compute not billed; Python-first SDK                  |
| Vercel Sandbox    | microVM                  | fast cold start, TypeScript-first                          |
| Cloudflare Sandboxes | container             | edge-resident, TypeScript-first                            |

Evaluate them on isolation model, cold start, statefulness, network policy control, and whether they can run our own image. Do not add one until a customer needs it, and never make one a default.

## A.10 Comparison matrix

Publish this in the documentation, and derive the UI warnings from the same table.

```text
                     local  sbx-rt  docker  k8s   gke-as  aca-sess  agentcore  ecs   cloudrun
Isolation              -      OS      ctr    ctr   gVisor   Hyper-V   microVM   VM     sandbox
Custom image           -       -       ✓      ✓      ✓         ✓         ✓       ✓        ✓
Per-session isolation  -       ~       ✓      ✓      ✓         ✓         ✓       ✓        ✓
Domain allowlist       ~       ✓       ✓      ✓      ✓         -         ~       ~        ~
Deny-all egress        -       ✓       ✓      ✓      ✓         ✓         ✓       ✓        ✓
Persistent filesystem  ✓       ✓       ✓      ✓      ✓         -         ~       ~        ~
Bounded session life   -       -       -      ~      ~     cooldown     ~8h      -        -
Start latency         ms      ms    ~1s    ~2-5s   <1s       ms      ~1s       ~10s      ms
Needs Docker socket    -       -       ✓      -      -         -         -       -        -
Runs on Fargate        -       -       -      -      -         -         -       ✓        -

✓ native   ~ approximated or conditional   - unsupported
```

## A.11 Environment contract for every runtime

Every driver injects the same variables. This is what keeps the drivers interchangeable.

| Variable                      | Value                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL`          | the internal gateway URL                                         |
| `ANTHROPIC_AUTH_TOKEN`        | short-lived token scoped to this run — never a provider key      |
| `CLAUDE_CONFIG_DIR`           | a per-session directory inside the sandbox                       |
| `AGENT_WORKSPACE_RUN_ID`      | run identifier, echoed in every event and log line               |
| `AGENT_WORKSPACE_SESSION_ID`  | Claude session id, for resume                                    |
| `HTTP_PROXY` / `HTTPS_PROXY`  | set only when the profile enforces an allowlist through a proxy  |
| `NODE_USE_ENV_PROXY`          | `1` on Node 24+, since `fetch` ignores proxy variables otherwise |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional collector                                               |
| agent secrets                 | only the secrets assigned to this agent (section 23)             |

Provider master credentials never enter a sandbox. The gateway holds them, and the sandbox holds a token that only the gateway accepts.

## A.12 Driver conformance tests

Mirror section 41: one suite, every driver, same scenarios.

```text
✓ create and destroy a runtime
✓ run a trivial agent turn and stream events
✓ hydrate files in, collect files out
✓ resume a session after the sandbox is gone
✓ enforce networkPolicy "none" (egress to a blocked host fails)
✓ enforce networkPolicy "restricted" (allowed host succeeds, other host fails)
✓ enforce cpu / memory / timeout limits
✓ interrupt a running agent
✓ concurrent sessions do not see each other's files
✓ no host .claude configuration is visible inside the sandbox
```

A driver that cannot pass a scenario declares it unsupported in `RuntimeCapabilities`; it must never pass by weakening the test.

## A.13 References

* Claude Agent SDK — [secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), [sandbox environments](https://code.claude.com/docs/en/sandbox-environments), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
* [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
* Azure — [dynamic sessions](https://learn.microsoft.com/en-us/azure/container-apps/sessions), [custom container sessions](https://learn.microsoft.com/en-us/azure/container-apps/sessions-custom-container), [sessions usage](https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage)
* AWS — [AgentCore runtime sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [AgentCore service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html), [AgentCore tools session isolation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/built-in-tools-how-it-works.html), [Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)
* Google Cloud — [Cloud Run code execution](https://docs.cloud.google.com/run/docs/code-execution), [Cloud Run execution environments](https://docs.cloud.google.com/run/docs/about-execution-environments), [GKE Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox), [Agent Engine Code Execution](https://cloud.google.com/agent-builder/agent-engine/code-execution/overview)
