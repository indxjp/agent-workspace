# Changelog — `@indx-workspace/platforms`

One heading per release, newest first. Each lists what was **added**, **deprecated** and
**removed**; a removal names the release that deprecated it. Released in lock-step with
`@indx-workspace/contracts`, with the same version.

## 0.6.9 — 2026-10-14

No changes to this package. Released alongside the install-live harness fix (#1128) so the gallery use cases are verified live against the published packages.

## 0.6.8 — 2026-10-14

No changes; released in lock-step with the other packages.

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

- platforms: the `gemini-enterprise` report shows a `mapped` verdict for a root agent's generated
  description, with a note that quotes it and says it comes from the agent name, and a clearer
  `toolEndpoint` note (issue #966). `portableFieldPaths` takes `withGeneratedDescriptions`, and the
  conformance kit accepts such a path only as `mapped` (ADR-0133 D7).
- platforms: `formatPlatformReport` groups a multi-agent report under a `Project` heading and one
  heading per agent; a one-agent report is unchanged (issue #966).
- platforms: the microsoft-foundry options take an optional `projectEndpoint` (an https URL) that
  only `aw platforms publish` reads; the compiled bytes do not change (issue #976, part of).

## 0.6.2 — 2026-10-12

### Added

- platforms: microsoft-foundry output uses the shared `prettyJson` and per-file JSON goldens (#963,
  part of): the emitted files print string-only arrays on one line, and the goldens are byte-exact
  JSON files. V1-V6 stay VERIFY until a live Foundry project confirms them.
- platforms: aws-agentcore importer, vendor fixtures, region-derived partition (#964, part of): the
  `aws-agentcore` target gains `import`, which reads `agentcore/agentcore.json` and each
  `harness.json` and refuses with a typed `platform_*` code that never quotes the input. A
  token-vault ARN in `Authorization` or `x-api-key` becomes `auth`; plaintext headers and
  `apiKeyArn` are dropped uncopied. The ARN partition is now derived from the region.
- platforms: aws-agentcore vendor fixtures are verbatim copies of `aws/agentcore-cli@dd6304e`
  `examples/AgentCoreCliReviewer` (#964, part of), parsed by `harness-spec.subset.ts` (which now
  accepts the example's `dockerfile`, `tags` and empty resource arrays) and imported by
  `vendor-fixtures.test.ts`. Only the opus-4-7 row of V4 is confirmed; V1-V3,
  `allowedTools: []`, the other V4 rows and V5 stay VERIFY (CLI-source evidence is recorded in the
  fixture `SOURCE.md`).
- The `eject-claude-agent-sdk` target and the `@indx-workspace/platforms/eject-claude-agent-sdk`
  subpath (issue #965, part of): a portable project compiles to a standalone TypeScript project that
  runs the agent on the pinned Claude Agent SDK, with `src/agent.ts`, `src/main.ts`,
  `.claude/skills/`, a `package.json` and `tsconfig.json`, an `.env.example` that names the secrets
  and never holds one, and a loader for code tools. Knowledge and OpenAPI tools are `dropped`; every
  other field has a verdict.
- The `eject-mastra` and `eject-openai-agents` targets and their
  `@indx-workspace/platforms/eject-mastra` and `/eject-openai-agents` subpaths (issue #965): the
  same standalone project for Mastra (workspace tools per permission, skills, subagents,
  `defaultOptions.maxSteps`) and for the OpenAI Agents SDK (MCP servers, code tools, handoffs, hosted
  tools for an OpenAI model, Anthropic through the AI SDK adapter). `createAgent()` returns
  `{ agent, close }` in both.
- The `microsoft-foundry` importer (issue #963, part of): `importFoundry` reads the emitted
  `*.version.json` files, or a `GET .../versions/{v}` response saved as JSON, back into a portable
  project and a verdict report. A tool with no portable form (a vector store, an inline OpenAPI spec,
  the shared `aw-tools` server) is `dropped`; a file that is not valid refuses with a typed
  `PlatformRefusal` that names paths and never quotes content. Vendor-shaped fixtures with their
  source URLs sit in `__golden__/vendor-fixtures`.
- The `microsoft-foundry` publish plan carries `notes` for the vendor facts still unconfirmed (V5, a
  Claude deployment as a prompt-agent model; V6, the ARM connection category and authType), each with
  its source URL.

### Changed

- The `gemini-enterprise` card registers `protocolVersion` `0.3.0` (issue #966, part of).
- `platforms`: one shared JSON renderer for the targets (`gemini-enterprise`, `copilot-studio`, `aws-agentcore`), and the `gemini-enterprise` card is pinned to the A2A v0.3.0 spec fixture (issue #966, part of).
- The `microsoft-foundry` target plans an `api-key` or `oauth2` MCP credential (and the same tool
  endpoint credential) as a project connection with a neutral `{ type, secretRef }` auth, where it
  used to leave the connection to be created by hand; the publish step picks the ARM authType (V6).
- The `microsoft-foundry` target shortens a project-connection name over 63 characters to a prefix
  plus an 8-digit hash of the full name, deterministically, instead of refusing the body.
- The `m365-declarative-agent` target (issue #962, part of; ADR-0133): bundles each OpenAPI document
  at `appPackage/openapi/<plugin>.<ext>` so `spec.url` resolves (a narrowed spec as JSON, an
  unnarrowed one verbatim), and drops a relative `specRef` it cannot bundle with `field_unsupported`.
  Tool names that collide in the plugin file name, the namespace or the `MCP_<NAME>_AUTH_REFERENCE_ID`
  variable are renamed with a `-<n>` suffix, so no plugin file or variable is overwritten. The
  `m365agents.yml` follows the Agents Toolkit template (v1.12, `copilotAgent/publish`, `AGENT_SCOPE`,
  `SHARE_LINK`) and plugin files carry `$schema`.

- The `claude-managed-agents` report records the original auth scheme (`api-key`, `oauth2`) when a
  secret is flattened to a `static_bearer` credential (issue #960, part of).
- The `gemini-enterprise` card keeps the agent name as its skill id and in the generated description
  when `displayName` is set; the display name labels only the card and its skill (issue #955).
- `loadGoldenProject` reads `<goldenDir>/input.json`, not `project.json` (Nx treats the latter as a
  project definition). The conformance check compiles a deep, unfrozen copy of the project, so a
  target that mutates its input fails with `compile changed its input project` rather than a raw
  `TypeError`.
- The `m365-declarative-agent`, `microsoft-foundry` and `aws-agentcore` targets no longer report an
  OpenAPI tool with `allow` rules as `mapped` while exposing every operation (issue #1012, part of;
  ADR-0133 amendment). M365 bundles `openapi.<tool>.json` and Foundry inlines the spec, both narrowed
  to the allowed operations; when the spec is not bundled or `allow` admits nothing, and always on
  AgentCore, the tool is `dropped` with `permissions_unsupported`, so `--strict` exits 5.

### Added

- The package joins the lock-step release set (issue #956, part of): `@indx-workspace/platforms` is
  in `PUBLISHED_PACKAGES`, second after `contracts`.
- `docs/platform-matrix.md`, generated from each target's declaration and the conformance kit and
  gated by `pnpm docs:check` (issue #956, part of).
- The `claude-managed-agents` target (issue #960, part of; ADR-0133): compiles a portable project to
  the `ant apply` layout (agents, skills, environment, vault and a credential plan), exported as
  `@indx-workspace/platforms/claude-managed-agents` and registered in `PLATFORM_TARGETS`. Compile
  side only; the importer is a follow-up.
- The `claude-managed-agents` importer (issue #960, part of): `importClaudeManagedAgents` reads the
  layout back into a portable project and a verdict report, validated with zod and the project
  schema, and refuses with a typed `PlatformRefusal` that carries paths and never file content. The
  conformance kit round-trips it, and `docs/platform-matrix.md` gains an Import row.
- `@indx-workspace/platforms/aws-agentcore`: `awsAgentCoreTarget`, which compiles a `PortableProject`
  into an AgentCore CLI project (`agentcore/*.json`, `app/<name>/harness.json`, `system-prompt.md`,
  skills), registered in `PLATFORM_TARGETS` (issue #964, part of). `runPlatformConformance` now takes
  the options to compile with, for a target whose options have required keys.
- The `PlatformTarget` port, `compileForPlatform`, `portableFieldPaths`, `capabilityOfPath`, the
  verdict builders and the (still empty) `PLATFORM_TARGETS` registry (issue #956, part of;
  ADR-0133 D6-D8).
- `@indx-workspace/platforms/m365-declarative-agent`: the `m365-declarative-agent` target, which
  compiles to an Agents Toolkit project (declarative agent v1.8, plugin manifests v2.4, app manifest
  1.24) and is registered in `PLATFORM_TARGETS` (issue #962, part of; ADR-0133). The importer reads
  the agent, its instructions, `WebSearch`, `CodeInterpreter`, RemoteMCPServer and OpenApi plugins
  and the options back (`platform_agent_not_found` when no agent can be read), and is tested against
  Microsoft's Learn examples and an Agents Toolkit project.
- The `microsoft-foundry` target (issue #963, part of): compiles a portable project to Foundry
  prompt-agent version bodies, A2A endpoint patches and a neutral `project.plan.json`; exported as
  `@indx-workspace/platforms/microsoft-foundry` and registered in `PLATFORM_TARGETS`.
- `@indx-workspace/platforms/testing`: the shared `SAMPLE_PORTABLE_PROJECT`, `assertVerdictInvariants`,
  `runPlatformConformance` and the golden-file helpers every platform translator is tested with.
- `@indx-workspace/platforms/copilot-studio`: the `copilot-studio` target, which compiles a
  `PortableProject` into a `pac copilot` workspace (`agent/**.mcs.yml`) and one custom-connector
  definition per remote MCP server (issue #961, part of; ADR-0133). The tenant-verified shapes are a
  follow-up.
- The `copilot-studio` target imports a cloned `pac copilot` workspace (files at the root or under
  `agent/`): the agent, its child agents, URL knowledge sources, knowledge files and topics become a
  `PortableProject`; actions, workflows and triggers are reported `dropped` (issue #961, part of).
- `@indx-workspace/platforms/gemini-enterprise`: the `gemini-enterprise` target, which compiles a
  `PortableProject` into the A2A v0.3 `agent-card.json` and the `register-agent.request.json` for
  Gemini Enterprise (issue #966, part of; ADR-0133). Compile only; there is no importer.

### Fixed

- The `copilot-studio` target no longer maps a remote MCP tool, or the project tool endpoint, with an
  `api-key` or `oauth2` auth scheme to its Bearer custom connector, which cannot authenticate it. Such
  a tool is `dropped` with `field_unsupported` and a note naming the scheme (issue #961, part of).
- The `claude-managed-agents` target refuses a project whose MCP servers reach one URL with different
  `secretRef`s instead of emitting a credential plan that cannot be applied (issue #960, part of).
