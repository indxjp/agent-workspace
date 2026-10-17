# ADR-0133 — One portable agent definition, exported to many agent platforms

Status: accepted
Date: 2026-10-11
Decided by: the Owner (programme "Platform targets", tracker #944, unit D0)
Scope: `packages/contracts/src/portable-agent.ts`, `packages/contracts/src/platforms.ts`, `packages/sdk/src/portable/`, `packages/platforms/`, `packages/cli/src/publish/`, `packages/aw/src/cli-bridge.ts`, the `platforms:` block of `agent-workspace.yaml`

## Context

Clients ask to run an Agent Workspace agent on Claude Managed Agents, Microsoft Copilot Studio,
Microsoft 365 declarative agents, Microsoft Foundry, Gemini Enterprise and AWS AgentCore, and to
move it between our own engines. Nothing in the repository can describe an agent in a form an
external host understands, and nothing reports what such a host would lose. This record is the one
decision that every later unit of the "Platform targets" programme cites, clause by clause. It
makes no code change.

- **Three agent shapes exist today, each for one job.**
  - `defineAgent` input is TypeScript authoring (`packages/sdk/src/define/agent.ts:123`).
  - `AgentDefinition` v1 is the name-keyed, stored and imported definition (ADR-0076;
    `packages/contracts/src/agents.ts:1103`). It is embedded in every agent version
    (`packages/contracts/src/agent-versions.ts:152`).
  - `PortableAgentConfig` is the private `/run` core that every engine honours
    (`packages/core/src/schemas.ts:402`; ADR-0065 D4).
- **External hosts.** Each has its own declarative artefact, its own model rules and its own tool
  model. The "Platform capability matrix" section lists them.
- **The rule we keep.** ADR-0065 D3 says "a requirement is honoured or it is named in a refusal".
  Export needs a third outcome, *dropped and reported*, because a customer may knowingly accept a
  narrower agent on a host that cannot do everything.
- **The words in use.** *Engine* (ADR-0065) and *deploy target* (`PROJECT_DEPLOY_TARGETS`,
  `packages/contracts/src/project-file.ts:251`) already have meanings. The new word must not
  overload either. `aws-agentcore` is already a runtime-driver id
  (`packages/contracts/src/runtimes.ts:17`).

## Decision

### D1 — Vocabulary

- **engine**: an agent loop we run in our own sandbox behind `AgentEngine`
  (`packages/engine/src/port.ts:397`). Its meaning does not change.
- **platform**: an external agent host we export or publish an agent *to*. The ids are fixed,
  lower-kebab, in this order (the wire order): `claude-managed-agents`, `copilot-studio`,
  `m365-declarative-agent`, `microsoft-foundry`, `gemini-enterprise`, `aws-agentcore`,
  `eject-claude-agent-sdk`, `eject-mastra`, `eject-openai-agents`. They live as `PLATFORM_IDS` in
  `packages/contracts/src/platforms.ts`. The `eject-*` ids are platforms whose output is a
  standalone TypeScript project.
- **deploy target**: where Agent Workspace itself runs. Its meaning does not change.
- The platform id `aws-agentcore` and the runtime driver id `aws-agentcore`
  (`packages/contracts/src/runtimes.ts:17`) are separate namespaces and never appear in the same
  field. Every doc page that names one names the other's meaning too.
- CLI flag: `--platform <id>`. `--target` stays deploy's. SDK and CLI names follow ADR-0114 S1:
  `aw.platforms.list()`, and `aw platforms list|export|publish|import|doctor`.

### D2 — The canonical model is `PortableAgent`

- It lives in `packages/contracts/src/portable-agent.ts`, a zod schema with types derived from it.
  `apiVersion: agentworkspace.dev/v1` (the group ADR-0076 D1 fixed), `kind: Agent`.
- Fields: `name` (lower-kebab, the `NAME_KEY_PATTERN` grammar), `description`, `instructions`,
  `model` (`{ provider?, id }`, a model id and never a credential), `engine` (the preferred engine
  id), `permissions` (the four booleans), `tools` (`mcp` | `code` | `openapi` | `builtin`),
  `skills`, `knowledge` (`files` | `url` | `connector`), `subagents` (names, one level deep),
  `limits`, and `extensions` (`engines?`, `platforms?`; opaque objects that each engine or platform
  validates itself).
- A `PortableProject` is the root agent's name, the agents (root plus its subagents), the resolved
  skill, knowledge-file and OpenAPI-spec bytes, and an optional public tool endpoint
  (`toolEndpoint`). It is the one input a platform target receives.
- It is an **interchange** shape, not a storage shape. `AgentDefinition` v1 and
  `AgentPolicySchema` keep their wire and DB shape unchanged. What versions need beyond them
  (`description`, `subagents`, `knowledge`) is added as optional top-level keys of the version
  body, the same way `toolBundles` was (`packages/contracts/src/agent-versions.ts:160`), so every
  existing body is byte-for-byte unchanged.
- Three names, three jobs; none may be reused for another: `PortableAgent` (interchange),
  `AgentDefinition` (stored), `PortableAgentConfig` (private `/run`).
- This amends ADR-0076 D1 as follows. The rule "no top-level `engine`" still holds for
  `kind: AgentDefinition`. `kind: Agent` carries `engine` as a *preference*, which the converter
  turns into `policy.engine` (D5), so there is still one place per kind.

### D3 — The interchange file is `agents/<name>.agent.md`

- YAML front matter holds every field except `instructions`, and the Markdown body *is*
  `instructions`. This is the convention Claude Managed Agents `ant apply` (`agents/*.md`) and
  Claude Code subagents (`.claude/agents/*.md`) use, so a file can be copied between them with
  little or no change.
- It is read with the project-file reader's closed YAML rules
  (`packages/sdk/src/project/reader.ts:216`, ADR-0089) and written with the canonical writer
  (`packages/sdk/src/project/writer.ts:178`).
- `defineAgent` (TS) stays the primary authoring API. The two forms may sit side by side in one
  project, and one agent name may be defined only once.

### D4 — Secrets are references only

Every credential in `PortableAgent`, `PortableProject`, platform options and emitted files is a
reference: a `secretRef: <SECRET_NAME>` with the `SecretNameSchema` grammar
(`packages/contracts/src/secret-reference.ts:99`), or the target platform's own vault or connection
reference. No value ever crosses these types, and translators never read the environment.

### D5 — Converters live in the SDK, and conversion reports what it drops

- `packages/sdk/src/portable/` (subpath `@indx-workspace/sdk/portable`) holds `parseAgentMarkdown`,
  `formatAgentMarkdown`, `toPortableAgent` (from `defineAgent` output),
  `portableFromAgentVersionBody`, `defineAgentFromPortable`, and `loadPortableProject`.
  `loadPortableProject` is isomorphic: the caller injects a file source.
- Every converter returns `{ value, dropped }`. Agent Workspace itself is treated like any other
  destination: a portable field Agent Workspace cannot hold (a `url` knowledge source, an `stdio`
  MCP server, a code tool without a run file) is listed in `dropped` with a reason, never discarded
  quietly.

### D6 — `packages/platforms` owns translation, and is pure

- A new published package, `@indx-workspace/platforms` (lock-step version like every
  `@indx-workspace/*` package).
- Workspace dependencies: `@indx-workspace/contracts` only. Third-party: `zod` and `yaml` at the
  pins `packages/sdk` already uses.
- Its production code imports no Node core module, no vendor SDK and no network client.
  `src/testing/` (the conformance kit) is the one place that may read files. Rules
  `platforms-depend-only-on-contracts` and `platforms-are-pure` in
  `dependency-cruiser.config.mjs` enforce this, like `engine-port-depends-only-on-contracts`
  (`dependency-cruiser.config.mjs:72`).
- Each target's translator is `src/targets/<platform-id>/` with a subpath export
  `@indx-workspace/platforms/<platform-id>`. The root entry exports the port, the verdict helpers
  and the `PLATFORM_TARGETS` registry.

### D7 — The `PlatformTarget` port and the verdict model

```ts
interface PlatformTarget<TOptions = unknown> {
  readonly id: PlatformId; readonly displayName: string; readonly docsUrl: string;
  readonly capabilities: PlatformCapabilities;   // per capability key: 'native' | 'mapped' | 'unsupported'
  readonly optionsSchema: z.ZodType<TOptions>;   // validates extensions.platforms[id] / project-file options
  compile(project: PortableProject, options: TOptions): PlatformCompileResult;   // pure
  import?(files: readonly PlatformFile[]): PlatformImportResult;                   // pure, optional (D12)
}
type PlatformCompileResult =
  | { ok: true; files: readonly PlatformFile[]; report: readonly FieldVerdict[] }
  | { ok: false; refusal: PlatformRefusal };
type FieldVerdict = { path: string; verdict: 'native' | 'mapped' | 'dropped'; code?: PlatformDropCode; note: string };
```

- `native` means the platform has the same concept. `mapped` means it is expressed differently and
  is equivalent. `dropped` means the field is not carried, and `code` and `note` say why.
- Every field path of the input appears in the report exactly once. The conformance kit asserts
  this for every target. One addition: a target that generates a value for an absent
  `<agent>.description` (A2A requires one) may report that path once, as `mapped`; the kit allows
  no other path that is absent from the project.
- The wire forms (`PlatformCapabilitiesSchema`, `FieldVerdictSchema`, `PlatformFileSchema`,
  `PlatformRefusalSchema`, the code lists) live in `packages/contracts/src/platforms.ts`, so the
  control plane can serve them (unit U5) without importing a translator.

### D8 — When to refuse and when to drop

- **Refuse** (`ok: false`) only when the agent cannot be represented at all. Refusal codes:
  `platform_model_unsupported`, `platform_limit_exceeded`, `platform_options_invalid`,
  `platform_agent_not_found`.
- **Drop** with a code in every other case: `code_tool_needs_public_mcp`, `stdio_mcp_unsupported`,
  `subagents_unsupported`, `skills_unsupported`, `knowledge_unsupported`, `builtin_unsupported`,
  `limits_unsupported`, `permissions_unsupported`, and the generic `field_unsupported`. On every
  hosted platform, `engine` and `extensions.engines` are always dropped with `field_unsupported`,
  because the host runs its own loop.
- New codes are added in this ADR's amendments, not ad hoc in a translator.
- This extends ADR-0065 D3 and does not weaken it. Inside our engines the rule is still "refuse,
  never drop". Export may drop, but only in the report, and D9's `--strict` turns any drop into a
  failure.

### D9 — Strictness UX

- Every export prints a verdict table (field · native/mapped/dropped · why), unless `--json` is
  given.
- Every export writes `PLATFORM_REPORT.md` next to the files. It is deterministic: no timestamp and
  no absolute path.
- Exit codes (`aw`, which already uses `2` = usage, `3` = contract violation / changes pending and
  `4` = transport, `packages/aw/src/output.ts:24-31`): `0` ok; `1` a platform refusal (a refused
  request; the stable `platform_*` code leads the message); `5` something was dropped while
  `--strict` is set (new `EXIT_CODE.dropped`, unit U2).

### D10 — Code tools reach hosted platforms through one public MCP endpoint

A `defineTool` code tool runs only in our tool host or sandbox (ADR-0115, ADR-0118, ADR-0132). A
hosted platform can reach it only through one authenticated MCP Streamable HTTP endpoint per project
deployment, which ADR-0134 (units T1a–T1c) specifies. That endpoint arrives as
`PortableProject.toolEndpoint` `{ url, auth: { scheme: 'bearer' | 'oauth2', secretRef } }`.

- When there is no endpoint, every code tool is dropped with `code_tool_needs_public_mcp`.
- An `stdio` MCP server is dropped with `stdio_mcp_unsupported` on every hosted platform.
- The `eject-*` targets keep both, because the ejected project runs them locally.

### D11 — Publishing talks to vendors outside `packages/platforms`

- Apply and publish executors live in `packages/cli/src/publish/`. They plan first (a dry run, then
  apply on confirmation or `--yes`, as ADR-0114 S2 requires) and wrap the vendor's own CLI or REST
  API:
  - `claude-managed-agents`: `ant apply`
  - `copilot-studio`: the cloned folder plus a `pac` solution pack
  - `m365-declarative-agent`: `atk`
  - `microsoft-foundry`: REST, with a token from `az account get-access-token`
  - `gemini-enterprise`: REST registration of our A2A endpoint, with a gcloud token (ADR-0135)
  - `aws-agentcore`: `agentcore deploy`
- Credentials come from the user's own vendor CLI login or from secret references. We never store
  them and never print them.
- `aw` reaches the executors only through **one** dynamic-`import()` bridge file,
  `packages/aw/src/cli-bridge.ts`, which also takes over `aw deploy`'s existing loader (ADR-0103
  amendment for #621). This ADR amends the rule `aw-reaches-cli-only-through-deploy`
  (`dependency-cruiser.config.mjs:149`), renamed `aw-reaches-cli-only-through-the-cli-bridge`, and
  the `docs/architecture.md` "aw imports only sdk and contracts" paragraph, to name that one file.
  Unit U3a makes the edit.
- `aw` may also import the pure translators in `packages/platforms` (no network, fs or vendor SDK);
  unit U2 adds that edge to the depcruise rule, `docs/architecture.md` and
  `docs/sdk/07-structure-map.md`.

### D12 — Import is pure and best effort

`PlatformTarget.import?(files)` turns another platform's files into a `PortableProject` plus a
report. Each importer lives in `src/targets/<id>/import.ts`.

- Importable: Managed Agents `ant` layout, Claude Code `.claude/agents/*.md` and
  `.claude/skills/`, a cloned Copilot Studio folder (best effort), and M365
  `declarativeAgent.json`.
- Not importable: Mastra and OpenAI Agents code. It is TypeScript, not data, and the docs say so.
- `aw platforms import --from <id> <path>` writes `agents/<name>.agent.md`.

### D13 — Proof: conformance kit, goldens, generated matrix

- `@indx-workspace/platforms/testing` holds the shared sample project, a golden-file harness
  (`UPDATE_GOLDEN=1` rewrites) and the verdict invariants:
  - every input path is reported exactly once;
  - a `dropped` verdict carries a code;
  - no verdict contradicts the declared capabilities;
  - emitted paths are relative, unique and never escape;
  - no emitted file contains a secret reference's resolved value (none is ever available).
- `docs/platform-matrix.md` is generated from each target's `capabilities` by
  `tests/platform-matrix/run.mjs` and gated by `tests/platform-matrix.test.ts`, the counterpart of
  `docs/engine-matrix.md` (ADR-0065 D2 item 6).

### D14 — Subagents are one level deep, and the engines declare whether they can run them

- `subagents` names other agents of the same project or workspace. An agent named as a subagent may
  not declare subagents itself. A subagent runs inside its parent's run: same sandbox, the parent's
  tools narrowed by the subagent's own permissions.
- `EngineCapabilitiesSchema` (`packages/contracts/src/engines.ts:59`) gains `subagents: boolean`,
  and `ENGINE_CAPABILITY_KEYS` (`:112`) gains `'subagents'`, so `engine_capability_unsupported` can
  name it at save and at compose (ADR-0065 D3).
- How each engine runs subagents:
  - `claude-agent-sdk`: its `agents` option.
  - `mastra`: Agent `agents`.
  - `openai-agents`: `Agent.asTool()`, not handoffs, because a handoff transfers the conversation
    and a subagent returns to its caller.
  - `pi`: refuses.
- Units D3a and D3b implement this.

### D15 — Project-file and create integration

- `agent-workspace.yaml` gains an optional top-level `platforms:` map
  (`<platformId>: { enabled, options, environments? }`) that holds only secret references (unit
  U1).
- `npm create @indx-workspace <dir> -- --platform <id>` writes the `platforms:` block and a README
  publish section, but no `.agent.md`: `agents/<name>.ts` stays the one definition and the portable
  form is produced on demand by `aw platforms export` (unit U4).

## Platform capability matrix

Facts are from the vendor docs of 2026-10-10. "VERIFY" means the target's unit confirms it against
the cited page and encodes it in a committed fixture (see Consequences).

| Platform id | Declarative artefact | Model | Instructions | Remote MCP | stdio MCP | Code tools | OpenAPI | Built-in tools | Skills | Knowledge | Subagents | Apply path | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-managed-agents` | `ant apply` layout: `agents/*.md` (front matter = request body, body = `system`), `skills/<n>/SKILL.md`, `environments/*.yaml` | Claude models only | `system` | ≤ 20 servers, URL (Streamable HTTP, SSE fallback), credentials via vaults | no | client-answered custom tools → via public MCP endpoint (D10) | via MCP | `agent_toolset_20260401`: bash, read, write, edit, glob, grep, web_fetch, web_search | custom `SKILL.md` bundles | none native | `multiagent_20261001`, ≤ 20 predefined, one level | `ant apply --dry-run` / `--yes` (CLI ≥ 1.30.0) | platform.claude.com/docs/en/managed-agents/overview; …/cli-sdks-libraries/cli/apply |
| `copilot-studio` | VS Code extension clone: `agent.mcs.yaml`, `settings.mcs.yml`, `topics/`, `actions/`, `knowledge/` (field names VERIFY) | platform-chosen; model hint VERIFY | yes (limit VERIFY) | Streamable HTTP only, OAuth2 or API key, needs generative orchestration | no | none (Power Automate/connectors/HTTP) → via MCP | connector actions | VERIFY | none | files, websites, connectors | VERIFY | VS Code extension apply; `pac` solution (VERIFY) | learn.microsoft.com/…/visual-studio-code-extension-overview; …/mcp-add-existing-server-to-agent |
| `m365-declarative-agent` | `declarativeAgent.json` v1.8 + app `manifest.json` + plugin manifest | none (no model field) | ≤ 8000 chars | plugin runtime `RemoteMCPServer` (preview), tools described statically | no | none → via MCP | API plugin actions (1–10) | WebSearch, CodeInterpreter, … | none | EmbeddedKnowledge (≤ 10 files, ≤ 1 MB), OneDriveAndSharePoint, GraphConnectors | `worker_agents` (preview) | `atk` (Microsoft 365 Agents Toolkit) | learn.microsoft.com/…/declarative-agent-manifest-1.8 |
| `microsoft-foundry` | prompt-agent definition via REST (exact schema VERIFY) | any model deployment | yes | yes | no | function tools are client-executed → via MCP | yes | web search, file search, code interpreter | none | file search | VERIFY | REST + `az account get-access-token` | learn.microsoft.com/azure/foundry/agents/overview |
| `gemini-enterprise` | registration of an A2A Agent Card (our agent keeps running in Agent Workspace) | ours (runs in our engine) | ours | ours | ours | ours | ours | ours | ours | ours | ours | REST registration + gcloud token (ADR-0135) | docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-adk-agent |
| `aws-agentcore` | harness: `harness.json` + `system-prompt.md` (field schema VERIFY) | any | `system-prompt.md` | MCP + Gateway targets | VERIFY | via MCP/Gateway | via Gateway | browser, code interpreter | from Git/S3 | memory (no file knowledge, VERIFY) | VERIFY | `agentcore deploy` | docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.md |
| `eject-claude-agent-sdk` | standalone TS project | any the SDK reaches | `systemPrompt` | `mcpServers` http/sse | yes | yes (local) | via MCP | Claude Code tools | `.claude/skills` | files in the project | `agents` option | none (the user runs it) | code.claude.com/docs/en/agent-sdk/typescript |
| `eject-mastra` | standalone TS project | `provider/model` | `instructions` | `MCPClient` url | yes | yes (local) | via MCP | workspace tools | workspace skills | files in the project | Agent `agents` | none | mastra.ai/reference/agents/agent |
| `eject-openai-agents` | standalone TS project | any | `instructions` | `mcpServers` | yes | yes (local) | via MCP | hosted tools | none | files in the project | `asTool()` | none | openai.github.io/openai-agents-js |

OpenAI Agent Builder is not a platform: it shuts down on 2026-11-30
(developers.openai.com/api/docs/deprecations).

## Consequences

- Contracts gain `portable-agent.ts` and `platforms.ts` subpaths. The version body gains three
  optional keys, a minor contracts bump per `docs/sdk/03-sdk-design.md:100`. `AgentDefinition` v1
  and `AgentPolicy` are unchanged.
- The engine catalogue response gains `capabilities.subagents`, also an additive minor bump.
- A new published package, `@indx-workspace/platforms`, joins `PUBLISHED_PACKAGES`
  (`scripts/release/pack-packages.mjs:80`), published after `contracts` and before `aw`.
- One more `aw`→`cli` dynamic import file (D11).
- Docs gain a "Run your agent on other platforms" chapter (unit Z1) and the generated matrix.
- Each vendor fact marked VERIFY is held by a committed fixture, never by memory.

## Alternatives rejected

1. **Make platforms engines.** An engine runs our loop in our sandbox and is held to "refuse, never
   drop" and the engine conformance kit. A platform runs *its* loop on *its* infrastructure, and we
   only hand it files. Folding them together would force `AgentEngine.start` onto hosts we never
   call, or weaken ADR-0065 D3 for every engine.
2. **Put the translators in `packages/sdk`.** The SDK is the typed client of the control plane,
   published for browsers and customer programs (ADR-0052). Nine translators and their golden files
   would ride into every consumer. The control plane also needs them (U5) without the SDK's client
   surface. A separate pure package is importable by `aw`, `apps/web` and customers alike.
3. **Put the translators in `packages/cli`.** The control plane could not use them: web may reach
   only published packages through declared exports, and the CLI carries Node-only deploy
   machinery. It would also mix pure translation with side-effecting publish, which D11 keeps
   apart.
4. **Store a second wire format** (persist `PortableAgent` as the version body, or add a `portable`
   column). That gives two sources of truth for one agent, a migration of every stored version, and
   drift between them. Interchange is computed from the stored version on demand, and only three
   optional keys are added to the body.
5. **A lowest-common-denominator schema that refuses non-portable fields at authoring time.** It
   would cripple agents that run on our engines in order to suit the weakest host. The verdict
   model lets one definition be rich and report per platform what drops.
6. **Depend on vendor SDKs inside the translators.** Their size and churn would land in every
   consumer, and the tests would need network and credentials. Vendor CLIs and REST belong only to
   the publish executors (D11).

## Amendment — OpenAPI `allow` rules on hosted platforms (issue #1012, 2026-10-11)

An OpenAPI tool's `allow` rules restrict which operations the agent may call. A target that cannot
carry them must not export the tool with more operations than they permit, so "mapped, with a note
that every operation is exposed" is no longer an allowed outcome. Per target:

- **The target bundles or inlines the spec** (`m365-declarative-agent`, `microsoft-foundry`):
  the translator emits the spec filtered to the allowed operations, from `PortableProject.openapiSpecs`,
  and the tool stays `mapped`. M365 bundles `appPackage/openapi.<tool>.json` and points the plugin at
  it; Foundry inlines the filtered document and plans no `openapiSpecs` entry to replace.
- **The target only references a spec it does not own** (`aws-agentcore`, whose gateway target
  defines the spec): the tool is `dropped` with `permissions_unsupported`, so `--strict` exits 5.

The filter uses `selectAllowedOperations` (ADR-0113), the matcher registration uses, so export and
run time agree on what `allow` means. The tool is dropped, never exported whole, when the spec is not
bundled or does not parse, a rule is refused (for example a write rule), or the rules admit no
operation. `components` is not pruned. No new drop code: `permissions_unsupported` already means a
permission restriction cannot be carried. Any future target that cannot express `allow` follows the
same rule.
