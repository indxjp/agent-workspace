# ADR-0103 — One project file holds every environment, and `aw deploy` applies it

Status: accepted in part (slice 1: `kind: Project` v2 with a `local` environment only, `aw dev` as one published process, and `@indx-workspace/sdk/define` for agents and surfaces; slice 2: top-level `engine`, `models`, MCP `connectors` and `policy`, and the secret reference; issue #621: a `production` environment of `target` and `url`, bridged to the v1 profile, and `aw deploy production`; 2026-10-04: D15 reversed by the blueprint decision Q1, `preview` is a pointer and not a control plane); the rest remains proposed — draft from the developer-journey hearing (decisions D3, D5, D9, D10, D15, D16)
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; slice 1 accepted 2026-10-02 by the planning writer of the developer-journey delivery on the Owner's delegation (see "Slice 1 acceptance"); slice 2 accepted 2026-10-03 by the implementing agent of S2-00b on the Owner's delegation (see "Slice 2 acceptance"); the rest to be confirmed when it is accepted
Scope: `packages/contracts` (a new profile schema), `packages/cli` (`create`, `render`, `deploy`), `packages/aw` (`dev`, `push`, `pull`), `packages/embedded`, `packages/gateway` (providers); extends ADR-0055, ADR-0089, ADR-0090 and ADR-0094

## Slice 1 acceptance

Accepted on 2026-10-02 for slice 1 of the developer-journey delivery
(the delivery plan), by the planning writer on the
Owner's delegation. Only the decisions below are accepted. Everything else in this record remains
proposed.

Accepted now:

- **`apiVersion: agentworkspace.dev/v2`, `kind: Project`, with `name` and `environments`**, defined
  in `@indx-workspace/contracts/project-file` (the `./projects` subpath is already the projects
  resource family). Each environment has the v1 shape (`cloud`, `storage`, `runtime`, `identity`)
  plus `port`. In slice 1 the only environment accepted is `local`, with `cloud: local` and the
  embedded stores. Every other key or environment is refused with its path, never accepted and
  ignored. `engine`, `models`, `connectors`, `policy` and `approval` are not accepted yet.
- **A v1 `kind: Deployment` reads as a project with one environment**: `local` for
  `cloud: local`, `production` otherwise, and the reader reports that it lifted the document.
  `aw dev` refuses an environment it cannot honour (a lifted Compose `storage`, a cloud other than
  `local`, no `local`). The CLI's `render`, `validate`, `deploy` and `doctor` refuse
  `kind: Project` and point at P-2.
- **The restricted YAML reader (ADR-0089) moves to `@indx-workspace/sdk/project`** and accepts
  nested mappings, leaving the shape to Zod. The CLI imports it from there, so one reader remains.
  Its refusals (anchors, aliases, custom tags, duplicate keys, several documents) are unchanged.
- **Names resolve per environment, for models only**: `model: 'default'`, or no model, resolves to
  the workspace's model connection named `default` when one exists, and to the deployment default
  otherwise.
- **`aw dev` is one process**, by the mechanism in
  [ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md):
  `packages/embedded` becomes the published `@indx-workspace/embedded`, serving `local` only.
- **Definitions live in `@indx-workspace/sdk/define`**, released at the SDK's version. Slice 1
  ships `defineAgent`, `defineSurface`, `mcp`, `skill` and `files`. Their input types derive from
  the contracts' Zod schemas, with no code-generation step.

Still proposed: the other environments, preview, `aw dev --prod-like`, `aw deploy <env>`, the
published Terraform modules, the cloud model providers, `render` per environment, and
`defineTeam`, `defineEval`, `openapiTool`, `postgresTool` and `secret`.

## Amendment — what S1-23 settled (issue #506, 2026-10-02)

Reason: the S1-19 exit test found that every project `npm create` scaffolds is refused its first
run with `422 model_connection_unresolved`. The scaffold writes `model: 'default'`, which the
agent version turns into connection `default` with model `null`. The agent layer of the run model
ladder counts only when it has both halves, and a fresh local workspace has no project or
workspace default model, so no layer resolved. "Names resolve per environment" above said
`model: 'default'` falls back to "the deployment default", but nothing defined that default.

- **C7's deployment default is a model id per provider.** The deployment configures it in
  `AW_DEPLOYMENT_DEFAULT_MODELS`, a JSON object keyed by model provider, for example
  `{"anthropic":"claude-sonnet-4-5","openai":"gpt-5.1"}`. The server reads it once at startup
  (`readDeploymentDefaultModels` in `apps/web/server/models/deployment-default.ts`) with a strict
  schema: only the five model providers are keys, and each value is a trimmed, non-empty id of at
  most 200 characters with no whitespace, control or invisible format character (Unicode `Cf`,
  such as a zero-width space or a bidi override, which would make a look-alike id). Unset or blank
  means absent. An invalid value is logged as `[compose] AW_DEPLOYMENT_DEFAULT_MODELS ignored:
<reason>`, never echoing the value, and treated as absent, so runs are refused rather than given
  a guessed model. The server does not refuse to start over it, because the composition root
  degrades and logs for every optional piece of run configuration, and the local launcher does not
  validate it, because the schema lives in the server and a second copy in `packages/embedded`
  could drift from it.
- **It is the explicit, named last layer of the ladder**: run > agent > project > workspace >
  deployment. The first layer that is present still wins outright (#129).
- **It applies only when the agent names no model and no other layer names one.** It pairs the
  agent's connection (or, when the agent names none, the workspace's connection named `default`)
  with the id configured for that connection's provider. This is the one named
  exception to "never a connection from one level with a model from another", and it is reported
  as its own layer, `deployment`, in the resolution and in the composer's run-target line ("the
  deployment default"). An agent that names connection X without a model, in a project whose
  default is connection Y with a model, runs on Y's pair: the deployment default is last.
- **#129's no-silent-skip rule is kept.** The layer is built whenever the agent names no model
  and no earlier layer resolves, whether or not a default is configured. When no id is configured for
  the connection's provider, the run is refused with `model_connection_unresolved` naming the
  deployment layer. The connection gets the same checks as at every other layer (exists, ready,
  credential readable; a rejected credential is `model_credential_rejected`). Validation follows
  #393: an unreadable model list lets the run proceed unvalidated with a warning, and a readable
  list must hold the id or, when it lists only dated releases, a `<id>-YYYYMMDD` release, of which
  the newest is used; otherwise the run is refused with `model_unavailable`. The composer's
  run-target line reads stored configuration only, so it shows the configured id and says "or its
  newest dated release" rather than claiming the exact id the run will snapshot.
- **A refusal at this layer names the agent's connection.** The deployment supplies only the model
  id, so "the agent's model connection ... is not ready" and "the deployment default model X is not
  available at the agent's model connection Y" point the user at what to fix.
- **C7 is read again at run time, in the deployment layer only.** A version that names no
  connection, or `default`, is stored with no connection when the workspace had no connection
  named `default` when it was applied: `aw dev` without `ANTHROPIC_API_KEY` reaches that state,
  and the restart that then creates `default` does not re-apply the unchanged version. So when
  the deployment layer is reached for an agent with no model and no connection, it uses the
  workspace's connection named `default` (`deploymentLayer` in
  `apps/web/server/compose/run-preflight.ts`; names are unique, so there is at most one). The
  agent layer still reads only the stored pair, so a run that the agent, project or workspace
  layer resolved before this amendment resolves there, on the same connection, unchanged: an
  agent that stores a model but no connection is never paired with `default`. With no such
  connection the deployment layer refuses with `model_connection_unresolved`, saying the
  workspace has no connection named `default`. Binding `default` before the ladder was rejected
  because it moved such agents from the workspace layer to the agent layer. Re-applying versions
  from `aw dev` was rejected: it would leave every other path that creates `default` later (the
  UI, the API) with the same stuck agent.
- **It is absent in every production posture unless an operator sets it.** Compose, Helm and the
  Terraform modules set nothing. The local runtime sets a default
  ([ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md),
  amendment for S1-23).

Alternatives rejected:

- **`aw dev` sets the workspace default model.** It needs a new route, a new row in the
  authorisation matrix and Lean changes, for a need only the local runtime has.
- **The scaffold names a model id.** It contradicts C7 (`model: 'default'` resolves per
  environment) and ties every scaffolded project to one provider.
- **Folding the default into the agent layer.** The agent layer outranks the project and workspace
  defaults, so the deployment default would no longer be last.

Proof: the RC-8 theorems in `formal/AgentWorkspace/Theorems/Normative/RunCompose.lean` (the
deployment layer is last, applies only when every other layer is absent, and an unconfigured
default is refused with no fallback), `apps/web/server/compose/run-request.test.ts` and
`run-preflight.test.ts`, and `packages/embedded/src/local-launcher.integration.test.ts`, where an
agent pushed with `model: 'default'` starts a run.

## Slice 2 acceptance

Accepted on 2026-10-03 for slice 2 of the developer-journey delivery
(the delivery plan, §8), by the implementing agent of
S2-00b (issue #521) on the Owner's delegation. Only the decisions below are accepted. Everything
else in this record remains proposed.

Accepted now, each refused at its path when malformed, never accepted and ignored:

- **Top-level `engine` (contract C12).** An agent that names no engine gets the project's `engine`
  when its version body is written, and `claude-agent-sdk` when the project names none. An agent's
  own engine wins.
- **`models` without a model id (contract C11).** `models.<name>` declares a model connection by
  name; a `model` key under `models.<name>` is refused, because connections carry no model id.
  With no `models:`, C6 holds unchanged. With `models:` present, `aw dev` creates each missing
  connection, refuses a provider mismatch with a hint, PATCHes a configuration difference,
  rotates a credential when `hasCredential` is false or its fingerprint changed (SD16), and never
  deletes.
- **MCP `connectors`**, with the transports `http` and `sse`: the connectors `mcp()` already
  defines can now be declared in the project file. Their write tools run without confirmation
  (ADR-0108, "Slice 2 acceptance").
- **Top-level `policy`**: the deployment ceiling (SD5, SD6; see ADR-0102, "Slice 2 acceptance").
  A per-environment `policy` and `approval` stay refused.
- **The secret reference (SD3, contract C10).** YAML spells it `{ secret: NAME }`, the same strict
  object as TS `secret('NAME')`, with `NAME` matching `^[A-Z][A-Z0-9_]{0,127}$`. It is a name
  only. On `local`, `aw` reads the environment variable `NAME` and sends its value only inside a
  connector or model-connection create or rotate request, which seals it as today. No
  free-standing workspace secret is created, because `/api/secrets` is Owner-only and the local
  key is `admin`. When the variable is missing, `aw` prints
  `<NAME> is not set: run export <NAME>=… in the shell aw dev started from, then restart aw dev` and skips that resource. A
  string where a reference belongs is refused at its path.
  [ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md) records
  the decision.
- **Tools are connectors (SD1, contract C15).** A `tools/*.ts` definition (`openapiTool`,
  `postgresTool`) becomes a catalog connector of kind `openapi` or `postgres`, and a version
  references it by name in `resources.connectors`, as it does an `mcp()` connector. The version
  body shape does not change.
  [ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md) records
  the decision.
- **SD7 — only `aw dev` applies `models`, `connectors` and tools, and only to its own runtime.**
  `aw push` to a remote workspace applies none of them and reports a missing name as it does
  today (`422 agent_definition_references_missing`). Reason: applying project resources to a
  shared workspace is R-4 (slice 7).
- **SD16 — secret fingerprints.** `aw dev` keeps, in the gitignored `.agent-workspace/`, an
  HMAC-SHA256 fingerprint of each secret value it sent, under a random per-project key stored
  beside it, never the value. A changed fingerprint rotates that credential on the next start,
  with a notice.
- **`openapiTool`, `postgresTool` and `secret` leave slice 1's "Still proposed" list.** ADR-0113
  decides them (SD1–SD4, SD13–SD17).

Declared gap: there is no v2 JSON editor schema. `packages/schemas/agent-workspace.schema.json`
is generated from the v1 `kind: Deployment` profile only
(`packages/cli/scripts/generate-profile-schema.mjs:3-7`), so the new keys get no editor
validation; `aw check` validates them. Extending the generator is a cli-lane unit of a later
slice.

Still proposed: environments other than `local`, a per-environment policy, `approval`, preview,
`aw dev --prod-like`, `aw deploy <env>`, the published Terraform modules, the cloud model
providers, `render` per environment, `defineTeam` and `defineEval`.

## Amendment — `production` is a deploy recipe, and `aw deploy production` (issue #621, 2026-10-04)

Accepted on 2026-10-04 by the implementing agent of 80-14 (issue #621) on the Owner's delegation,
with the Owner's answers to its plan. It changes "Each environment holds what a v1
`kind: Deployment` holds" for `production` only, and moves `aw deploy <env>` out of "Still
proposed" for `production` only.

- **`environments.production` is `{ target, url }` and nothing else.** `target` names a deploy
  recipe, `single-vm` (the Compose project on one machine) or `gcp-cloudrun` (the
  `infra/terraform/gcp-cloudrun` module); `url` is the `https:` origin it is served at, with no
  credential, path, query or fragment. Both are defined in
  `@indx-workspace/contracts/project-file` (`ProductionEnvironmentSchema`). Any other key under
  `production` (`cloud`, `storage`, `identity`) is refused at its path, as is any environment other
  than `local` and `production`. A lifted v1 profile is unchanged: its `production` keeps the v1
  shape, under `lifted: true`.
- **The v1 profile becomes an internal format.** `projectToDeploymentProfile(project, env)` in
  `packages/cli/src/deploy/project.ts` is pure: it derives the profile from the recipe through the
  same per-cloud defaults `create-agent-workspace --cloud` writes (`single-vm` → `cloud: local`
  with SeaweedFS and the `docker` runtime; `gcp-cloudrun` → `cloud: gcp`) and validates it with the
  CLI's profile schema. The v1 profile schema stays, because deployed v1 projects use it.
- **The bootstrap Owner is the `local` environment's identity.** `production` carries no third
  field; `aw deploy` prints the admin email after an apply.
- **`aw deploy production` reuses `agent-workspace deploy` (ADR-0094) in-process.** It plans by
  default and applies only with `--yes`; pending changes exit 3, because `aw`'s 2 is a usage error.
  The bridged profile and its generated `.env` live outside the project, at
  `~/.config/agent-workspace/deployments/<project>/<env>/`, so a customer edits only
  `agent-workspace.yaml` and no `.aw/<env>/` directory is rendered. The directory is created 0700
  and `.env` 0600, and secrets are generated once and never regenerated over an existing
  directory. `aw deploy` never destroys: there is no destroy or down subcommand.
- **`aw` loads the deploy steps with a dynamic `import()` of `@indx-workspace/cli`**, an optional
  peer dependency, and fails fast with "install @indx-workspace/cli" when it is missing, so the
  storage clients the CLI carries are not in every `aw` install. This is the one exception to
  `aw-depends-only-on-sdk-and-contracts`: a single `aw` file (`commands/deploy.ts`) may reach the
  CLI's `./deploy` export, and `aw-reaches-cli-only-through-deploy` refuses any other aw file
  reaching the CLI (`dependency-cruiser.config.mjs`, `docs/architecture.md`).
- **A single-VM deploy publishes web on `127.0.0.1:3000` only** and trusts one proxy hop: the
  Owner terminates TLS for `url` with Caddy on the VM (`docs/deploy/single-vm.md`). Every Owner
  prerequisite — Node.js 24, Docker Engine with the Compose plugin, the published release images,
  and (for `--yes`) a DNS record for the `url` host — is refused by name before anything is
  created.

Alternatives rejected: spawning `agent-workspace deploy` (the issue asks for an in-process call);
the bridge in `aw` (it needs the CLI's defaults and schema anyway); moving the deploy steps into
the SDK (the SDK is isomorphic); rendering into the project root or `.aw/<env>/` (deployment
secrets beside `aw dev` files, and per-environment render directories are out of scope).

Proof: the contract tests in `packages/contracts/src/project-file.test.ts` and the golden tests in
`packages/cli/src/deploy/project.test.ts` (one v2 file in, one v1 profile out, per target).

Still proposed: environments other than `local` and `production`, the Azure recipe, preview,
`render` per environment, and the published Terraform modules.

## Amendment — `preview` holds no infrastructure (blueprint decision Q1, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q1). It reverses "Preview is a small environment in the production cloud"
below, and the hearing's decision D15 with it.

- `environments.preview` names no cloud, storage or identity of its own. It shares production's
  control plane and may name a smaller runtime for evaluation runs. The version it shows is a
  pointer ([ADR-0101](0101-the-platform-owns-agent-versions.md), amendment Q1).
- `aw deploy preview` and `.aw/preview/` are not built. `aw deploy <env>` applies to an environment
  that holds infrastructure: today `local` and `production`.
- Why: a second control plane would need versions, evaluation cases and connections copied into it,
  and the isolation it buys is already given by the version pin, the per-run sandbox and the
  policy ceiling.

## Context

Today `agent-workspace.yaml` is `kind: Deployment` (ADR-0089): one file describes one deployment —
its cloud, stores, default runtime and identity. A team that wants a laptop environment and a
production environment generates two projects. `render` re-renders the artefacts (ADR-0090), and
`agent-workspace deploy` (ADR-0094) applies one profile with Compose, Helm or Terraform, showing a
plan first and changing nothing without `--yes`. The Terraform modules and the Helm chart live in
this repository, not in the generated project. Local
development runs the same five services under Compose. The embedded single-process mode exists
only inside the repository (`packages/embedded`).

Model connections accept five providers: `anthropic`, `anthropic-compatible`, `openai`,
`azure-openai` and `openai-compatible`.

## Decision

### `kind: Project`, `apiVersion: agentworkspace.dev/v2`

One file per repository holds:

- `engine` and `models` — the default engine and named model connections (`default`, …), with a
  credential reference or a cloud identity, never a value;
- `connectors` — the tool catalog the admin approves (ADR-0102);
- `policy` — ceilings, overridable per environment (ADR-0102);
- `environments` — `local`, `preview`, `production` and any others. Each environment holds what a
  v1 `kind: Deployment` holds today (cloud, region, storage, runtime, identity), plus `approval`.

A v1 `Deployment` document is read as a project with one environment. `agent-workspace upgrade`
(Phase 3) rewrites it.

### Names resolve per environment

Code and versions reference `model: 'default'` and `mcp('github')`. Each environment resolves the
name to a connection. The same version runs on Vertex AI in production and on the Claude API on a
laptop without changing.

### Cloud model providers are first-class

`bedrock`, `vertex` and `foundry` join `MODEL_PROVIDERS`. They authenticate with the cloud's
identity (IAM role, workload identity, managed identity), not a stored key (D10).

### Local is one process; production-like is opt-in

- `aw dev` runs the control plane, gateway and runner in one process, with the host's OS sandbox,
  and starts in seconds. The embedded mode becomes a published capability, not a contributor-only
  one (D9).
- `aw dev --prod-like` runs the five services under Compose, as `pnpm start` does today.

### Preview is a small environment in the production cloud

_Reversed by the amendment above (decision Q1, 2026-10-04): `preview` is a pointer in the
production control plane. Kept for the record._

`preview` is a separate, smaller control plane in the same cloud account as production (D15).
`aw deploy preview` creates it once. Draft versions get workspaces and URLs inside it (ADR-0101).

### `aw deploy <env>` plans, waits for approval, and applies

- `aw deploy` renders `.aw/<env>/` (Terraform that calls a published module, or Compose), shows the
  plan, and applies only after `--yes` or an approval (D5). The rendered files stay readable, and an
  operator may apply them with their own Terraform.
- `aw deploy` is for infrastructure changes only. Agent changes go through version promotion
  (ADR-0101), which never touches infrastructure.
- The Terraform modules are published (registry or OCI), so a generated project does not need a
  clone of this repository.

### Definitions live in `@indx-workspace/sdk/define`

`defineAgent`, `defineTeam`, `defineSurface`, `defineEval`, `openapiTool`, `postgresTool` and
`secret` are a subpath of the SDK, released at the SDK's version (D16).

## Alternatives rejected

- **One directory per environment** (`environments/local/agent-workspace.yaml`, …). This is closest
  to today's format, but it repeats every shared setting and makes promotion between environments a
  copy.
- **Separate repositories for infrastructure and content.** Rejected for the default; large
  platform teams can still split them.
- **Generate Terraform and stop.** Rejected (D5); `aw deploy` wraps Terraform rather than
  replacing it, consistent with the decision in the developer-platform product and roadmap §7.

## Consequences

- The deployment-profile reader (ADR-0089) gains a v2 schema in `packages/contracts`, and its
  JSON Schema is generated from it.
- `render` (ADR-0090) renders one directory per environment under `.aw/`.
- `packages/embedded` moves from a contributor tool to a published runtime, with its own security
  review: no tenant isolation, so it serves `local` only.
- The gateway gains three provider adapters, each needing live proof, like D-2 to D-4.
