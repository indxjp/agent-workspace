# Changelog

All notable changes to the Agent Workspace platform (images and deployment) are documented here.
npm packages have their own changelogs: `packages/<name>/CHANGELOG.md`. Release notes: [`docs/release/notes/`](docs/release/notes/).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## Unreleased

### Fixed

- The web refuses an unknown `RUNTIME_DRIVER` instead of treating it as `docker`: composition fails
  with an error that lists the valid ids and does not echo the value. An unset or blank value still
  means `docker`. The Kubernetes runtime row is now disabled unless Kubernetes is the runner
  manager's driver, because Test Runtime could never pass for it and every run on it was refused.
  Its wire shape (`id`, `label`, fields) is unchanged; only `state` and `reason` change.
  `KUBERNETES_RUNTIME_IMAGE` and the web's `KUBECONFIG` check are gone.
- Hosted surfaces and the A2A Agent Card no longer require `BOOTSTRAP_ADMIN` and
  `BOOTSTRAP_ADMIN_PASSWORD` (issue #1168); the deployment workspace is read from `WORKSPACE_SLUG`
  alone, so an OIDC-only deployment serves them.
- The runner no longer exits when an engine's `interrupt()` rejects after a client disconnect or an
  interrupt that arrived during start. The rejection is logged to stderr with the run id and every
  other run on the runtime keeps streaming.
- An `anthropic-compatible` run keeps its provider on settlement: `runs.provider` and the usage ledger
  now say `anthropic-compatible` instead of being overwritten with `anthropic`, and the run is priced
  under `anthropic-compatible:<model>` (or `anthropic-compatible:*`) in `GATEWAY_PRICING_JSON`. A
  deployment that relied on `anthropic:*` prices for a compatible endpoint settles those runs unpriced
  (`unavailable`) until it adds that key.
- The runner's `/files` endpoints now go through the single ustar codec in `packages/runtime`
  instead of a hand-written copy. A member that percent-decodes to a NUL byte (`%00`) is refused
  there too, collecting through a symlinked parent directory is refused, and long paths are split
  at any `/`. Symlink refusals no longer put an absolute host path in the message. Status codes and
  `error` codes (`invalid_archive`, `invalid_file_request`) are unchanged; the message text changed
  from `unsafe workspace path …` to `unsafe archive path …`.
- A fresh `npm install` of the published packages pulled `@earendil-works` 1.2.0 siblings of pi
  (pi declares them as `^1.0.2`), and `aw dev` crashed with "does not provide an export named
  `MCP_TYPESCRIPT_PREAMBLE`". The whole pi family is now pinned exactly at 1.0.2 in
  `@indx-workspace/embedded`, and a test fails if pi gains a
  sibling that is not pinned.
- `GET /api/metrics` returned an empty run list because the telemetry projection was a
  per-module-graph `Map`; it is now anchored on `globalThis` like the other process-wide state
  (issue #1161).

### Added

- `aw platforms publish --platform microsoft-foundry` (issue #976): plans and, with `--yes`, sends the
  agent versions and A2A endpoints the Foundry export holds, using the token of the user's own
  `az login`. Every hosted platform now has a publish executor, and the table is total by type.

### Fixed

- An E2B agent-runtime sandbox no longer holds a slot for the plan maximum (issue #827, part of): the
  runner creates it with a timeout of the session's idle limit (900 seconds, or the profile's
  `idleTimeoutSeconds` if longer) plus 120 seconds, and each reconnect for a later run of the
  session renews it. These session sandboxes, not tool sandboxes, were what the vercel-e2b lane
  found alive at its end. The lightweight journey's sweep log now splits them as `runtime=<n>
tool=<n>`.
- E2B tool sandboxes no longer outlive their run (issue #832, part of #827): when an `external` run
  ends, the control plane releases the tool sandbox that run started (`DELETE
/tool-sandboxes/runs/<runId>`, keyed by the run's `awRun` tag) and never the session's agent
  runtime, a tool sandbox's E2B timeout is its run deadline plus two minutes, a failed run-token
  write or tool recording removes the sandbox it just started, and a 429 from E2B surfaces as
  `tool_sandbox_unavailable` naming the concurrency limit. The lightweight journey kills its lane's
  sandboxes (tag `awWorkspace`) at the end of each E2B lane and runs the two E2B lanes one at a time.

### Added

- Live Managed Agents lane (issue #979, part of it): `tests/e2e/platforms-journey/managed-agents-live.e2e.mjs`
  publishes the journey's agent as `awpt-<run id>` to Claude Managed Agents with the real `ant` CLI
  (a plan without `--yes` exits 3 and creates nothing, then `--yes`), reads it back through the
  Managed Agents list API, and always archives the agents and deletes the skills it created; a
  leftover fails the run. It runs as the `platforms-live-managed-agents` job of `journey-live.yml`,
  `workflow_dispatch` only, with the existing `ANTHROPIC_API_KEY` secret, a checksum-pinned `ant`
  installed in a `run` step (no new action), and outside `ci-success`. `findAgentByName` is tested
  against the committed `fixtures/agents-list.json`.
- A runtime profile with `driver: external` takes `provider: e2b` (issue #827, part of; `runtime.provider`
  in `agent-workspace.yaml`, `driverConfig.provider` on the server). An unknown provider is refused by
  name, as `422 runtime_provider_unsupported` on `POST`/`PATCH /api/runtime-profiles` and at profile
  validation in the CLI schema. Without `provider` a runtime is `e2b`, as before.
- The lightweight journey shows two more things (issue #832, part of #830, #831, #827): the `gate`
  row tries `aw promote` below the eval bar and asserts the refusal names the version (the
  profile-path lanes now deploy with the same `AW_DEPLOYMENT_POLICY` bar `aw deploy` writes), and the
  `widget` row sends one turn from the frontend origin the way the frontend's client does. The docs
  cite run 38215231687 for the Vercel and Cloudflare hosts, with the native-sandbox lanes named as
  `n/a` (#940, ADR-0131), and gain the guides [Deploy on Vercel](docs/sdk/site/guides/deploy-vercel.mdx)
  and [Deploy on Cloudflare](docs/sdk/site/guides/deploy-cloudflare.mdx).
- Developer docs chapter 7, "Run it on other platforms" (issue #978, part of): an optional chapter
  with an overview of `aw platforms`, a guide for each of Claude Managed Agents, Copilot Studio,
  Microsoft 365 declarative agents, Microsoft Foundry, Gemini Enterprise and AWS AgentCore, the three
  eject targets, switching the engine, and a platform compatibility matrix generated from
  `docs/platform-matrix.md` (`pnpm docs:generate` keeps it in step). Publish is described only for
  the platforms that have an executor, Gemini Enterprise included (plan-first, `--yes` to apply,
  with a `gcloud` token); Foundry says it is not yet available. Each publish step still marked
  VERIFY in its executor is labelled "unverified against a live tenant".
- Developer docs chapter 7 (issue #978): the Foundry guide describes plan-first publish with your
  `az` login (the token is never printed; steps still marked VERIFY are labelled "unverified against
  a live tenant"); the Claude Managed Agents and Foundry verdict tables list the drops they were
  missing; the Claude Managed Agents page notes the on-demand live lane: until a run of it passes,
  publishing to Claude Managed Agents is unverified against a live tenant.
- Platforms journey (issue #979, part of it): `tests/e2e/platforms-journey` creates a project from the
  packed packages, exports it to every id in `PLATFORM_TARGETS` with `aw platforms export` and
  compares each verdict list with a committed golden (`golden/<id>.json`, nine files), so a dropped
  or re-mapped field can never change silently. It also asserts `--strict` exits 5, a non-Claude
  model for Managed Agents exits 1 with `platform_model_unsupported`, an unknown platform exits 2,
  `aw platforms doctor` lists every id, and the export → `aw platforms import` → export round trip
  keeps the instructions. It uses no secret and runs as the `platforms-journey` job of
  `journey-live.yml`, outside `ci-success`. `createSupportProject` takes `extraArgs`.
- `aw platforms publish --platform gemini-enterprise` registers or updates the exported A2A agent
  in Gemini Enterprise, plan-first (issue #976, part of): it checks the Agent Card is reachable and
  declares A2A `0.3.0` before it asks `gcloud` for a token, lists the app's agents (following
  `nextPageToken`), and sends a `POST` or `PATCH` only with `--yes`. Microsoft Foundry and the
  total executor table follow.
- A twelfth setup question, `admin.platforms` (`--platform <a>[,<b>…]`, asked last, default
  `none`), in `npm create`, `aw init` and the browser setup (issue #977, part of): each chosen
  hosted platform is written as `platforms: {<id>: {enabled: true}}` in `agent-workspace.yaml`,
  with a "Publish to other agent platforms" README section and an "Other agent platforms"
  AGENTS.md section. With `none` every file is unchanged.
- OpenAPI documents are stored (issue #968, part of; migration 0052 adds the nullable
  `mcp_servers.openapi_document`), so a platform export of a saved agent version carries an OpenAPI
  connector in `project.openapiSpecs` instead of dropping it. The resource still never returns the
  document. A connector registered before this change has no document: replace it (`PATCH` with the full
  body) with its document to export it; until then the export reports it as `dropped`.
- OAuth consent follow-ups (issue #971, part of; ADR-0134 clause 19): the workspace picker returns a
  member to the authorize page (`next`, same-origin only, re-checked on every read), and the consent
  check that a member can run every agent of the client reads the database through the shared
  `ownershipOf` rule instead of the agents runtime.
- `aw platforms publish` for Copilot Studio (import only with `--experimental --yes`) and AWS
  AgentCore, plan-first through the vendor's own CLI (`pac`, `agentcore`) (issue #976, part of).
- Subagents run on the Claude Agent SDK (issue #974, part of; ADR-0133 D14): a version's
  `subagents` are resolved at run time from the version its environment points at (`production`
  when the parent runs its `production` version, else `local`), sent on the private `/run` contract
  as `portable.subagents` (omitted when empty), and compiled into the SDK's `agents` option. Each
  subagent's permissions are AND-ed with its parent's, and a parent policy that denies `Agent` is
  refused with `engine_capability_unsupported`. Mastra, OpenAI Agents and pi refuse a request that
  carries subagents, by name; a version whose subagent has no description is refused on save.
- Subagents run on Mastra and OpenAI Agents (issue #974, part of; ADR-0133 D14): Mastra compiles
  each into a sub-`Agent` under `agents` (own workspace and read-only tool set), OpenAI Agents into
  an `Agent.asTool` (a nested run, not a handoff). Both meter a subagent's usage against the
  `maxBudget` cap without counting it as one of the run's turns, and refuse by name a subagent on
  another model when a cap is set (the cap is priced with the parent's model). Only pi still
  refuses subagents.
- OAuth endpoint-client follow-ups (issue #971, part of; ADR-0134 clause 19): `aw endpoint-clients
secret rotate` and `update --redirect-uri`; `/signin?next=` is honoured for same-origin paths only
  (open redirects refused); the consent page no longer needs the agents runtime; concurrent
  revocations of one token audit once.
- `aw platforms publish --platform <id>` (issue #975, part of; ADR-0133 D11): exports the agent,
  then shows the vendor tool's own plan and publishes it only with `--yes`. A plan with changes exits
  `3`; `--plan` with `--yes` is a usage error; `--strict` still exits `5` before any vendor call.
  Claude Managed Agents runs `ant apply --dry-run .` then `ant apply --yes .`, Microsoft 365 runs
  `atk validate`, `package`, then `provision`. Credentials come from the vendor tool's own login and
  are never stored or printed. `aw platforms doctor` also warns when a vendor tool is missing or too
  old. Needs `@indx-workspace/cli`, loaded only through `packages/aw/src/cli-bridge.ts`.
- `aw platforms export` prints `/` in every path it shows on Windows too (issue #972).
- `@indx-workspace/cli/publish` (issue #975, part of; ADR-0133 D11): plan-first publish executors
  for `aw platforms publish`. They spawn the vendor's CLI (`ant`, `atk`) through the same runner as
  `agent-workspace deploy`, redact every printed line, and apply nothing without `--yes`.
- `aw platforms list|export|import|doctor` (issue #972, part of; ADR-0133): `export --platform <id>`
  compiles the project's agent (`agents/*.ts` or `agents/*.agent.md`) into a platform's files under
  `platforms/<id>/`, prints a per-field verdict table and always writes `PLATFORM_REPORT.md`;
  `--strict` exits `5` when any field is dropped. `import --from <id> <path>` turns a platform's
  agent files into `agents/<name>.agent.md`, `doctor` checks that each enabled platform compiles,
  and `list` shows every agent platform. A new exit code `5` means `--strict` found dropped fields.
- platforms: microsoft-foundry output uses the shared `prettyJson` and per-file JSON goldens (#963,
  part of): string-only arrays such as `allowed_tools` now print on one line, and the `full` and
  `no-tool-endpoint` goldens are byte-exact JSON files instead of `.txt` bundles. V1-V6 stay VERIFY.
- Subagent checks (issue #969, part of; ADR-0133 D14): saving or dry-running a version that names a
  subagent the workspace lacks or one with subagents of its own, or giving subagents to an agent
  that is already someone's subagent, is refused `422 agent_subagent_unusable`, checked in the same
  transaction as the save under a workspace lock so two concurrent saves cannot together build
  A→B→C. A portable knowledge file takes `access: read-write`, so a read-write grant round-trips
  through the converters. `aw push` saves subagents first and refuses a cycle locally as
  `subagent_cycle`. The Lean engine model still lacks `subagents` (a local follow-up).
- **Project tool sandboxes close on revoke** (issue #967, part of): revoking an `mcp-project` endpoint
  client, one of its endpoint API keys, or an OAuth grant (a token revoke or a replayed refresh token)
  now closes the client's tool sandbox through the runner manager's new
  `DELETE /tool-sandboxes/sessions/:clientId`, best effort with the idle timeout as the backstop
  (ADR-0134 part 2). The deploy guides say which drivers place tool sandboxes.
- platforms: aws-agentcore importer, vendor fixtures, region-derived partition (#964, part of): an
  AgentCore CLI project imports back into a portable project and round-trips through the compiler.
  Header values and `apiKeyArn` are never copied; only a token-vault reference becomes `auth`. ARNs
  take their partition (`aws`, `aws-cn`, `aws-us-gov`) from the region. The fixtures under
  `aws-agentcore/vendor-fixtures/` are hand-rendered, not vendor copies; V1-V5 stay VERIFY.
- platforms: aws-agentcore vendor fixtures are verbatim (#964, part of): the hand-rendered project
  is replaced by `examples/AgentCoreCliReviewer` from `aws/agentcore-cli@dd6304e` (Apache-2.0, blob
  SHAs in `SOURCE.md`), parsed by the harness subset schema and imported. The opus-4-7 row of V4 is
  confirmed by the fixture; V1-V3, `allowedTools: []`, the other V4 rows and V5 stay VERIFY (V2, V3
  and `allowedTools: []` have CLI-source evidence only, not AWS docs). Upstream requires `model`, so
  an agent without a model is a follow-up.
- `description`, `subagents` and `knowledge` on `defineAgent()` and the agent version body (issue
  #969, part of; ADR-0133 D2, D14): all optional, so an existing body is unchanged. Subagents are
  declared and validated but not run: every engine declares `subagents: false`, so a body naming
  one is refused `422 engine_capability_unsupported` until the runtime supports them.
- A **Platforms** tab on the agent page (issue #973, part of): for a saved version it shows what
  each platform can carry, the per-field verdicts of an export, a bundle download and the
  `aw platforms publish` command to copy, in English and Japanese. It reads the platform routes
  through the SDK; publishing still runs from the CLI.
- The `eject-claude-agent-sdk` platform target (issue #965, part of): `aw`'s platform compiler can
  now emit a standalone TypeScript project that runs an agent on the Claude Agent SDK. A real
  `tsc` run over the emitted project and a pins test keep it honest.
- The `eject-mastra` and `eject-openai-agents` platform targets (issue #965): the same
  standalone TypeScript project for Mastra and for the OpenAI Agents SDK, on the engines' pinned
  versions, each with a golden, a verdict table and a real `tsc` run. The Claude project now puts a
  subagent's MCP servers in its own `mcpServers`.

### Changed

- CI: a new `Terraform` workflow runs `fmt -check`, `validate` and `terraform test` for every `infra/terraform` root, `fast-checks` runs `infra/tests/contracts.test.mjs`, and that test now expects the pinned `azure/login` v3 (issue #1050, part of).
- `agent-workspace render` writes `AW_PUBLIC_URL` as its origin, so a trailing slash or path in `.env` no longer fails `terraform plan` (issue #1050, part of).
- The A2A card's `protocolVersion` is now `0.3.0` (the A2A v0.3.0 schema default) instead of `0.3`, in the served card and the `gemini-enterprise` registration (issue #966, part of).
- `platforms`: one shared JSON renderer for the targets (`gemini-enterprise`, `copilot-studio`, `aws-agentcore`), and the `gemini-enterprise` card is pinned to the A2A v0.3.0 spec fixture (issue #966, part of).
- `platforms`: a multi-agent `PLATFORM_REPORT.md` is grouped under one heading per agent, and the `gemini-enterprise` report shows a `mapped` row for a generated card description and a clearer `toolEndpoint` note (issue #966).
- `AW_PUBLIC_URL` now reaches every remaining generated deployment (issue #955): the
  azure-container-apps module takes a validated `public_url` variable (set on `web` only when
  non-empty), `agent-workspace render` writes `publicUrl` into the v1 Helm overlay, and a Cloudflare
  deploy hands the `.env` value to the control-plane Worker, now pinned by a test. Unset, the
  rendered output is unchanged.
- `AW_PUBLIC_URL` now reaches Cloud Run (new `public_url` Terraform variable, set on `web` only when
  non-empty) and Kubernetes (new Helm value `publicUrl`, set by `aw deploy`); unset, the rendered
  output is unchanged. A2A: a key not bound to the agent now answers `404 a2a_agent_not_found` like an
  unknown name, not `403 token_out_of_scope` (ADR-0135; issue #955, part of).
- The `m365-declarative-agent` platform target gains an importer and bundles OpenAPI documents at
  `appPackage/openapi/` (issue #962, part of; ADR-0133): the Agents Toolkit project round-trips
  through compile and import, colliding tool names are renamed instead of overwriting a plugin file
  or auth variable, and `m365agents.yml` follows the toolkit template (v1.12, `copilotAgent/publish`).
- The `claude-managed-agents` report records the original auth scheme when an `api-key` or `oauth2`
  secret is flattened to a `static_bearer` credential (issue #960, part of).
- `aw deploy` (single-vm, vercel, gcp-cloudrun) writes `AW_PUBLIC_URL` into the deployment `.env`
  from `environments.production.url`, and the Compose template forwards it to `web`, so a deployed
  control plane serves its A2A cards (issue #955, part of). `aw create` output is unchanged except
  for `compose.yaml`. Spec §34 now prints the two A2A routes. The A2A card's skill id and generated
  description always use the agent `name`; a display name only relabels the card and its skill.
- The `m365-declarative-agent`, `microsoft-foundry` and `aws-agentcore` platform targets no longer
  export an OpenAPI tool with more operations than its `allow` rules permit (issue #1012, part of;
  ADR-0133 amendment): M365 and Foundry emit a spec narrowed to the allowed operations, and a tool
  whose spec cannot be narrowed, or any `allow` tool on AgentCore, is dropped with
  `permissions_unsupported`, so `--strict` exits 5.
- A passing Test Runtime is now also stored per workspace in PostgreSQL (`runtime_verifications`), so
  runs no longer fail at the `runtime_profile` step on a serverless instance that did not run the test
  (#827). The log line of a failed run preparation is redacted of the secrets it could resolve instead
  of being withheld when one secret cannot be resolved.
- The engine catalogue (ADR-0136, #946) is the one place an engine is described: the stored policy,
  the SDK engine settings and the registry versions are built from it, with a compile-time guard that
  fails when an engine has no arm.

### Added

- Platform targets and stored-version exports over the API and the SDK (issue #968, part of;
  ADR-0133): `GET /api/platforms`, `POST /api/agents/:id/platform-exports` (JSON files plus the
  per-field verdict report) and `.../platform-archives` (the same files as a tar), surfaced as
  `aw.platforms.list`, `.export` and `.exportArchive`. Connectors and skills are resolved; a
  connector credential is only ever a `CONNECTOR_<NAME>` secret reference.
- Platform exports refuse what cannot be carried safely (issue #968, part of): a connector whose
  URL carries a credential, a `bearer` or `api-key` connector with no credential on file, and
  connectors whose `CONNECTOR_<NAME>` secret names collide are each a `dropped` verdict naming the
  connector (never its URL). A skill that is dropped no longer counts toward the export size cap.
- Stored-version exports are assembled by the SDK's `loadPortableProject` (issue #968, part of;
  ADR-0133): they now carry the version's subagents (each agent's `production` version, else its
  `local` one; a subagent the workspace cannot serve is `422 platform_agent_not_found`), the
  granted knowledge files, and the public MCP tool endpoint of the one live `mcp-project` client
  that publishes the agent (its key is the `TOOL_ENDPOINT_<CLIENT>` secret reference). An OpenAPI
  connector is reported as `dropped`, because only its document's digest is stored. In the SDK,
  `LoadPortableProjectInput.project` needs only `connectors` and `models`, and `codeTools` and
  `codeToolNames` may be left out to use each body's recorded `toolBundles`.
- `aw.endpointClients` in the SDK and `aw endpoint-clients …` in the CLI (issue #949, closes; ADR-0134):
  create endpoint clients and mint their endpoint-scoped keys, shown once. The scope matrix test now
  also covers every `API_ROUTES` entry, and `isPrincipal` is tested to refuse an API key with a
  `session` scope.
- `docs/platform-matrix.md` (issue #956, part of; ADR-0133): the capability table of every registered
  platform target, generated from the targets and the conformance kit, with a `--check` gate in
  `pnpm docs:check`. `@indx-workspace/platforms` joins the lock-step npm release set; the Owner
  hand-publishes its `0.0.0-bootstrap` placeholder before the next `packages-v*` tag
  (`docs/release/README.md`).
- The `claude-managed-agents` platform target (issue #960, part of; ADR-0133): a portable project
  compiles to the `ant apply` layout, with a per-field verdict report. Compile side only.
- The `claude-managed-agents` importer (issue #960, part of; ADR-0133): reads an `ant apply` layout
  back into a portable project with a per-field verdict report, refusing malformed files with a
  typed error that never quotes their content. `docs/platform-matrix.md` gains an Import row.
- The `copilot-studio` platform target (issue #961, part of; ADR-0133): a pure translator from the
  portable agent to a Copilot Studio `pac copilot` workspace plus one Power Platform custom
  connector per remote MCP server, with a verdict for every field it cannot carry. It also imports a
  cloned workspace back into a portable project.
- The `microsoft-foundry` platform translator in `@indx-workspace/platforms` (issue #963, part of;
  ADR-0133): portable agents compile to Foundry prompt-agent version bodies and a publish plan.
- The `microsoft-foundry` importer (issue #963, part of; ADR-0133): reads emitted agent versions, or
  a saved `GET .../versions/{v}` response, back into a portable project with a per-field verdict
  report, refusing malformed files with a typed error that never quotes their content. API-key and
  OAuth 2 MCP credentials are planned as project connections, over-long connection names are
  shortened deterministically, and the publish plan notes the vendor facts still unconfirmed.
- platforms: aws-agentcore translator (AgentCore harness project) (issue #964, part of; ADR-0133):
  `@indx-workspace/platforms/aws-agentcore` compiles a `PortableProject` into an AgentCore CLI
  project with one managed harness, and reports a verdict for every field. The importer follows
  separately.
- The `gemini-enterprise` platform target (issue #966, part of; ADR-0133, ADR-0135): a pure
  translator that emits the A2A v0.3 Agent Card and the Gemini Enterprise agent-registration request
  for the root agent, which keeps running on the deployment. Compile only; no importer.
- The `platforms:` block of `agent-workspace.yaml` (issue #959; ADR-0133): which agent platforms a
  project exports or publishes to, with their options; credentials only as `{ secret: NAME }`.
- The portable agent (issue #950, part of; ADR-0133 D2/D3): `PortableAgent` and `PortableProject`
  schemas and the platform id list in `@indx-workspace/contracts`, and a strict, round-tripping
  `.agent.md` parser and serialiser in `@indx-workspace/sdk/portable`.
- Agent definitions convert to and from the portable agent (issue #954, part of; ADR-0133 D5):
  `toPortableAgent`, `portableFromAgentVersionBody` and `defineAgentFromPortable` in
  `@indx-workspace/sdk/portable` return the converted value and a list of everything the target
  cannot carry, each with a path and a reason.
- `loadPortableProject` in `@indx-workspace/sdk/portable` assembles the `PortableProject` a platform
  translator takes (issue #954; ADR-0133 D5): the project's TS and `.agent.md` agents plus the skill,
  knowledge and OpenAPI bytes, read through an injected file source, with each agent holding only
  the code tools it lists. An OpenAPI spec path written `./openapi.json` is now carried instead of
  dropped, and a reordered Claude tool policy no longer counts as a drop.
- Added endpoint clients and endpoint-scoped API keys
  ([ADR-0134](docs/adr/0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md),
  issue #949, part 1): `/api/endpoint-clients` creates a client that names one MCP project or one
  agent, and mints a static key bound to it. The key is refused on every route outside its scope
  with `403 token_out_of_scope`. The SDK and CLI follow separately.
- Published agents speak A2A v0.3 over JSON-RPC
  ([ADR-0135](docs/adr/0135-published-agents-speak-a2a-v0-3-over-json-rpc.md), issue #955, part
  of): `POST /api/a2a/agents/:agentName` serves `message/send`, `message/stream`, `tasks/get` and
  `tasks/cancel` for the version the agent's `production` pointer names, and
  `GET /api/a2a/agents/:agentName/.well-known/agent-card.json` serves the agent card. Only an
  API key is accepted (a session or browser token gets `403 a2a_credential_not_accepted`), and the
  route is rate limited. The card needs the new `AW_PUBLIC_URL` setting.
- `POST /mcp/projects/:name` serves the code tools of an `mcp-project` endpoint client's agents
  (`initialize`, `ping`, `tools/list`, `tools/call`;
  [ADR-0134](docs/adr/0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md)
  part 2, issue #967). Only that client's endpoint-scoped API key is accepted, each call is audited
  as `endpoint-tool-called`, and the route is rate limited. The tools run in a sandbox only the
  gateway can reach, under a 60-second grant the control plane signs.
- Added an OAuth 2.1 authorization server for endpoint clients
  ([ADR-0134](docs/adr/0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md)
  part 3, issue #971): `/oauth/authorize`, `/oauth/token` and `/oauth/revoke` plus the RFC 8414 and
  RFC 9728 metadata documents, served from `AW_PUBLIC_URL`. Authorization code with PKCE S256,
  client credentials and rotating refresh tokens issue short-lived `awo_live_` tokens bound to one
  endpoint URL; `POST /api/endpoint-clients/:id/secret` shows a client secret once. Migration
  `0050_add_oauth_to_endpoint_clients.sql` adds the columns and the `oauth_tokens` table. The SDK and
  CLI follow separately.

- `packages/platforms` (issue #956, part of; ADR-0133 D6-D8): the `PlatformTarget` port, the
  per-field verdict model and a framework-free conformance kit that every platform target runs.
  No target ships yet, and the package is not yet published.
- The `m365-declarative-agent` target (issue #962, part of; ADR-0133): compiles a portable project
  to an Agents Toolkit project for a Microsoft 365 Copilot declarative agent (manifest v1.8, API
  plugin manifests v2.4), reporting a verdict for every field. The import direction follows
  separately.

### Fixed

- The `copilot-studio` platform target no longer maps an `api-key` or `oauth2` MCP tool, or tool
  endpoint, to a Bearer custom connector that cannot authenticate it: it is dropped with
  `field_unsupported` and a note naming the scheme (issue #961, part of).
- The `claude-managed-agents` target refuses a project whose MCP servers reach one URL with different
  `secretRef`s (a vault holds one credential per URL) instead of emitting a credential plan that
  cannot be applied (issue #960, part of).
- A run that fails preparation because its tool sandbox could not be opened now names the runner
  manager's `tool_sandbox_unavailable` reason in its stored error, redacted of the run's secrets and
  withheld when they are unknown; the runner's manifest, run-token and readiness failures name their
  cause and the last probe status (#827).
- The lightweight journey builds the E2B tool-host template from the checkout for each e2b lane, in
  parallel with the runtime template, instead of reading `E2B_TOOL_HOST_TEMPLATE` (#827).

### Documentation

- ADR-0133: portable agent definition and platform targets.

## 0.1.0 — release candidate

_Prepared 2026-09-09. The release is not tagged: D-10 blocks it until the residual risks in
[`docs/release/security-review-0.1.0.md`](docs/release/security-review-0.1.0.md) are signed._

- Added the spec-derived eleven-step E2E harness and an on-demand Docker Compose workflow. The live
  model path remains credential-bound and the full flow is not green.
- Published evidence-backed provider and runtime matrices. Their generated marks—not this changelog—
  are the capability claims for the candidate.
- Added the reproducible security review and the section 55 walkthrough instrument. The walkthrough
  has not been performed by a non-engineer.
- Added release/version consistency and exact Claude Agent SDK specifier gates.
- Carried the missing Wave 2c screens and the D-06 runnable-link conflict as explicit release
  blockers. No published container image is claimed under D-05.
