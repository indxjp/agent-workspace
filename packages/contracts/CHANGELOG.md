# Changelog — `@indx-workspace/contracts`

One heading per release, newest first. Each lists what was **added**, **deprecated** and
**removed**; a removal names the release that deprecated it. Removals and renames happen only in a
major release, no earlier than one minor after the deprecation. The full rule, the served range and
what the policy covers are on the developer site's
[Public surface and stability](../../docs/sdk/site/concepts/public-surface.mdx#versions-and-deprecation)
page. `@indx-workspace/contracts`, `@indx-workspace/sdk` and `@indx-workspace/aw` are released
in lock-step with one version.

## 0.6.12 — unreleased

### Added

- `RUN_START_PROBLEM_CODES` gains `agent_archived` (`409`): the agent is archived, so no run can
  start on it, and a hosted surface of an archived agent opens no session.
  `AgentChangedAuditDetailsSchema` is the `details` of an `agent-changed` audit row
  (`{ archived: true }`).
- `BUILTIN_AGENT_PROBLEM_CODES` gains `builder_name_reserved` (`403`): the name is one the
  deployment's `builder.allow` lists, which only a workspace Owner or Admin may give. The closed
  list's key type is exported as `BuiltinAgentProblemCode`.
- `@indx-workspace/contracts/files` names two new `429` problem codes for signed links:
  `too_many_pending_uploads`, when a workspace already holds `MAX_PENDING_UPLOADS_PER_WORKSPACE`
  (100) unfinished uploads, and `link_rate_limited`, when it has made more than
  `LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE` (60) upload or download link requests this minute on
  one server (with `Retry-After`). Both constants are exported.
- `@indx-workspace/contracts/features` exports `FEATURE_IDS`, `FeatureId`, `ROUTE_FEATURES` and `RouteFeature`. Every `ApiRoute` and every `API_ROUTE_EXCLUSIONS` entry now carries a required `feature`, and the OpenAPI document gains an `x-agent-workspace-feature` extension on each operation.
- `STORAGE_CONNECTION_SECRET_PREFIX` and `isStorageConnectionSecretName` in
  `@indx-workspace/contracts/secret-reference`: the one definition of the secret names reserved for
  storage connection credentials, which tool secrets, connector identities and the secrets routes
  refuse.
- A refused `resolveStorageSettings` result carries a `code` field, `storage_url_invalid` or `storage_endpoint_same_origin`, so a caller no longer reads the code from the start of `reason`. `code` is optional on `StorageSettings`, so a hand-built value still compiles.
- `@indx-workspace/contracts/features` exports `FeatureIdSchema`, `FEATURE_DEPENDENCIES`, `featuresMissingDependencies`, `dependentsOf`, `FeatureListSchema` (non-empty, unique, dependency-closed), `WorkspaceFeaturesSchema`, `UpdateWorkspaceFeaturesRequestSchema` and `FEATURE_PROBLEM_CODES` (`feature_disabled` 404, `feature_in_use` 409, `feature_not_installed` 409) (ADR-0160).
- `ProjectDocumentSchema` accepts an optional `features:` list of the features a deployment installs; absent means every feature. The schema is strict, so an `aw` or contracts release that predates this refuses a project file that carries `features:`: upgrade `aw` and `@indx-workspace/contracts` together.
- `SETUP_QUESTIONS` gains a thirteenth question, `admin.features` (flag `features`, choices `FEATURE_IDS`, recommended every feature). The answer is optional in `SetupAnswersSchema` and `CompleteSetupAnswersSchema`, so a caller that omits it still validates and gets every feature.
- `AUDIT_ACTIONS` gains `workspace-features-changed`, written when a workspace's feature switches change.
- The `workspaces.features.list` and `workspaces.features.set` routes join `ROUTES` (ADR-0160 D8).

### Changed

- `StorageConnectionResourceSchema` parses a connection's `url` again: a URL that is not a storage URL, names a secret, or is for another provider than `provider` fails with `storage_connection_url_invalid` or `storage_connection_url_has_secret`, so a reader never acts on an unchecked URL.
- A GCS storage connection's `serviceAccountJson` must give `service_account` as its `type`. A key with no `type` is now refused as `storage_connection_url_invalid`, like one with another `type`; a key downloaded from Google Cloud already carries it.
- `MeResponseSchema` gains a required `features` key: the `FeatureId`s switched on for the caller's
  workspace, in `FEATURE_IDS` order (ADR-0160 D8). An SDK or `aw` older than this release rejects
  `GET /api/me` from this server; upgrade clients and server together.

### Fixed

- The OpenAPI document describes the `multipart/form-data` request of `POST /api/skills` (a text
  `name` part, then one `file` part per skill file, `SKILL.md` first) and marks its JSON + base64
  body deprecated. The route catalogue gains a `multipart` body kind and a route's
  `deprecatedRequests`, so other routes can describe the same.

## 0.6.11 — unreleased

### Added

- `AgentResource` gains optional `createdByAgent` (`agentId`, `version`, `runId`) and `archivedAt`,
  and `ProjectPolicy` gains an optional `builder.allow` list of agent names. A missing `builder`
  allows no agent to build.
- `AuditEventSchema` gains the optional `builderRunId`, present only on `agent-created` rows written by a Builder save.
- `ENDPOINT_CLIENT_KINDS` gains `builder`, the OAuth client of the Builder's MCP door. A `builder` client names no agent, so `POST /api/endpoint-clients` takes `agentIds: []` for it and refuses `toolNames`; `mcp-project` and `a2a-agent` clients keep their agent counts.
- `BUILDER_REFUSAL_CODES` gains `read_only_client` (403), the refusal an outside MCP client gets for a Builder tool that writes or spends.
- A GCS storage-connection credential accepts `{ "provider": "gcs", "accessToken" }`, a short-lived OAuth access token; the URL must carry `?project=`. Like a key, it is write-only and never returned. A `serviceAccountJson` whose `type` is not `service_account` (for example `external_account`) is refused as `storage_connection_url_invalid`.
- An S3 storage-connection credential accepts an optional `sessionToken`, for temporary (STS) credentials. Like the key, it is write-only and never returned.

### Deprecated

- `@indx-workspace/contracts/storage-settings` keeps its 0.6.10 exports for the old storage settings as deprecated shims: each is removed in the next major release, and the server ignores the old storage settings.
- Constants: `FILE_STORAGE_ROOT_ENV`, `SKILL_STORAGE_ROOT_ENV`, `SESSION_STATE_STORAGE_ROOT_ENV`, `OBJECT_STORAGE_BUCKET_ENV` and `OBJECT_STORAGE_BACKEND_ENV`; removed in the next major release; the server ignores the old storage settings.
- Types: `ObjectStorageBackend`, `ResolvePath` and `LegacyLocalRoots`; removed in the next major release; the server ignores the old storage settings.
- Functions: `configuredObjectStorageBackend(env)`, `legacyStorageVariables(env)` (use `ignoredStorageVariables`) and `storageUrlReplacing(location, env)`; removed in the next major release; the server ignores the old storage settings.
- `resolveStorageSettings(env, resolve?)` still accepts `resolve` and ignores it; the parameter is removed in the next major release, and the server ignores the old storage settings.
- The `legacy` kind of `StorageSettings` stays in the type so a `case 'legacy'` still compiles; it is never produced, is removed in the next major release, and the server ignores the old storage settings.
- `ImportSkillInput`, the JSON + base64 body of `POST /api/skills`, is deprecated in favour of
  `multipart/form-data` (`SKILL_IMPORT_MULTIPART`). The server still accepts it and answers with a
  `Deprecation` header; it is removed in the next major release.

## 0.6.10 — unreleased

### Added

- Surface attachments (ADR-0146, #1308). `SurfacePartsSchema` accepts `attachments: boolean`;
  `POST /api/sessions/:engineSessionId/attachments` (`sessions.attachments.upload`) takes a raw
  body with the file name in `name` and answers `201` `SurfaceAttachmentResponseSchema`
  (`{ fileId, path, size }`). `SURFACE_ATTACHMENT_MAX_BYTES` (10 MiB), `SURFACE_ATTACHMENTS_MAX_FILES`
  (20), `SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES` (50 MiB) and `SURFACE_ATTACHMENT_PROBLEM_CODES`
  (`invalid_attachment_name`, `attachments_quota_exceeded`) describe it.
- Run attachments (ADR-0146). `StartRunRequest.attachments` names one to `MAX_RUN_ATTACHMENTS`
  (10) workspace files, as `{ fileId }`, that the run receives read-only. Refusals are `404`
  `file_not_found`, and `422` `run_attachments_unreadable`, `run_attachments_too_large` and
  `run_attachments_unsupported_runtime`.
- `RUN_WARNING_EVENT` (`run.warning`) and `RunWarningEventDataSchema` (`{ code, message? }`): a
  durable platform notice on a run's event stream, such as `attachments_removed_shell`.
  `PLATFORM_EVENT_NAMES` lists it with `run.status`.
- `needsApproval(rules, toolName)` and `canonicalCall(name, input)` in
  `@indx-workspace/contracts/agents`: the one decision of whether a tool call needs approval, and
  the RFC 8785 canonical JSON text of a call (it throws `TypeError` on a value that is not JSON).
  `RequireApprovalRuleSchema` is the rule a `requireApproval` list takes, and
  `conflictingApprovalRules` finds the rules that also match `autoApprove`.
- Structured run output (ADR-0143). `StartRunRequest.outputSchema` asks for the answer as a value
  of a JSON Schema (draft 2020-12, root `type: "object"`, local `#/$defs/` `$ref` only, at most 16
  levels deep and 32 KiB); a schema outside those limits is a `400` `invalid_body` whose message
  begins with the limit (`root_type`, `size`, `dialect`, `ref`, `depth`). `outputSchemaViolation`
  is the one function that judges it. `RunResource.output` (`{ text, structured }`, `null` until
  the run completes) and the optional `output` of the `agent.result` frame carry the answer. A run
  that cannot meet its schema fails with `output_schema_unsatisfied` (`parseRunFailure`).
- A run whose engine cannot be asked for structured output is refused with `422`
  `engine_capability_unsupported`.
- Evals check structured output. `EvalCase.outputSchema` is the JSON Schema the case's run answers
  with (the limits of `outputSchemaViolation`, and at most 4096 characters as JSON), and
  `EvalExpect.output` is a subset match on `RunResource.output.structured`, scored like
  `toolInput`; it needs the case's `outputSchema`. An older `aw` reads neither key from an
  `evals/<agent>.yaml` (the case schema is strict).
- `CreateAgentInputSchema` and `UpdateAgentPatchSchema` in `@indx-workspace/contracts/agents`: the
  bodies of `POST /api/agents` and `PATCH /api/agents/:id`, the rules the server applies, and
  `agentRequestIssueMessages(issues)`, the `details` lines it answers a refused body with.
  `CreateAgentInput` and `UpdateAgentPatch` are now derived from them; their shape is unchanged.
- The `agent.handoff` run frame (`AgentHandoffFrameSchema`, with an optional non-empty `reason` that only an operator's stream carries; a visitor's session-scoped stream omits it) ends a run that handed the conversation to a person, and the Claude policy arm accepts `handoff: true` to offer the `handoff_to_person` tool (ADR-0145 D4). An SDK or `aw` older than this release raises `ContractViolationError` on the new frame, so upgrade them before an agent opts in.
- `RUN_START_PROBLEM_CODES` gains `builder_model_unavailable` (503): a run of the built-in Builder is refused before a run exists when no model connection of the workspace serves the Builder's model.
- `AgentResource.builtin` marks a platform-managed agent (`'builder'`), and writes to one answer `403 builtin_agent_read_only` (`BUILTIN_AGENT_PROBLEM_CODES`).
- `AgentResourceSchema` is strict, so an older SDK or `aw` rejects a `GET /api/agents` listing that holds a Builder: clients must update to an SDK/`aw` that knows `builtin` before Builder provisioning is enabled.
- `RUN_IDEMPOTENCY_PROBLEM_CODES` declares the two refusals a run start's `Idempotency-Key` can
  draw: `400 invalid_idempotency_key` and `409 run_idempotency_conflict`.
- `@indx-workspace/contracts/storage-connections` exports the storage-connection wire shape (resource, list, create input, patch, provider-shaped credential, test outcome, browse response, problem codes) and `parseStorageGrantPath` for `storage://<connection>/<folder>` grants. An agent definition's `files[].path` that starts with `storage://` must parse.
- `parseStorageUrl` marks a refusal for credentials or an unknown query parameter with `secret: true`.
- `@indx-workspace/contracts/storage-settings` resolves `AW_STORAGE_URL` and the old storage variables the way the server does.
- `@indx-workspace/contracts/storage-url` exports `parseStorageUrl` and `formatStorageUrl`, the one parser for `AW_STORAGE_URL` (`file:`, `s3:`, `gcs:`, `azblob:`). It refuses credentials and any query parameter it does not list, and a refusal never repeats the URL.
- `EvalCaseSchema` accepts optional `tags` (labels such as `injection`). They are never scored; a gate over an evaluation report can read them. `BUILDER_EVAL_PASS_SCORE` (0.85) is the Builder's promotion bar.
- `EvalExpect.awaitsApproval: true` scores an evaluation case at an approval pause (ADR-0145): the run may end at `awaiting_approval`, `tool` and `toolInput` also match the paused call, and the text checks and `judge` read the answer so far. It is refused together with `output`. A case that sets it and completes without pausing fails `run_not_awaiting_approval`. The evaluation never approves: the runner cancels the paused run after scoring. A server older than this contract answers `400 invalid_body` to a file that uses it.
- `FILES_PROBLEM_CODES.upload_in_progress` (409): an upload, rename, folder creation or folder move that meets an upload still in flight at the path, or under the folder, is refused and nothing is written.
- `MoveFileRequestSchema` describes the body of `PATCH /api/files/:id`; `MoveFileInput` is now inferred from it, and the route catalogue names it as the request.
- Public run approval (ADR-0145). `RUN_STATUSES` gains `awaiting_approval`: a run that stopped
  before a tool call its agent requires approval for. It is not terminal (`isTerminalRunStatus`
  is `false`); `STOPPED_RUN_STATUSES` and `isStoppedRunStatus` name the statuses where nothing
  executes. `RunResource.pendingApproval` (`RunApprovalCall | null`) carries the call while the
  run is paused. The `agent.approval.requested` frame is appended to `AGENT_FRAME_NAMES`.
  `POST /api/runs/:id/approval` (`RunApprovalRequestSchema` `{ decision, comment? }`, `202` with
  `RunApprovalResponseSchema`) starts one continuation run in the same session; a second decision
  or a late one is `409` (`RUN_APPROVAL_PROBLEM_CODES`).
- `RunResource.agentVersion` is the number of the agent version the run executed, or `null` for a session that pins none. It is server-set and read-only.
- `RUN_START_PROBLEM_CODES` gains `run_storage_grant_unavailable` (`422`): a granted storage connection folder is gone or no longer allowed when the run starts.
- `PublishShareCommand.transcript` chooses which turns a session share publishes, as `{ runIds }` of that session's runs (`ShareTranscriptSelectionSchema`, at most `SHARE_TRANSCRIPT_MAX_RUNS`). The server copies each run's prompt and final answer; the command never carries transcript text.
- `AgentResourceAssignments` carries `storageGrants` (`{ connectionId, prefix, access }`, default `[]`), and the agent-version problem codes include `storage_connection_prefix_not_allowed` and `storage_connection_write_not_allowed`.
- `TriggerResource.outputSchema`, and an optional `outputSchema` on `CreateTriggerRequest` and
  `UpdateTriggerRequest` (`null` clears it): the JSON Schema every run the trigger starts answers in,
  under the same limits as `StartRunRequest.outputSchema` (ADR-0154).
- `TriggerResource.subject`, and an optional `subject` on `CreateTriggerRequest` and
  `UpdateTriggerRequest` (`null` clears it): the caller every run the trigger starts asserts to a
  connector that opts into caller identity, 1 to 256 characters (ADR-0156). New problem code
  `trigger_subject_not_allowed` (403): setting a subject, or editing a trigger that has one, takes
  the API-key-creation permission.

### Changed

- `RunResource` gains a required `output` key. A client parsing a run from an older server must
  tolerate its absence until both sides are on this release.
- `CreateUploadUrlRequestSchema.sizeBytes` is bounded by the new export `SIGNED_UPLOAD_HARD_MAX_BYTES` (5 GiB, the largest single S3 `PUT`) instead of `MAX_UPLOAD_BYTES` (64 MiB); a deployment may set a lower limit, and a mint above it answers `413 request_body_too_large`.
- The gateway runs an approved `openapi` write at most once (ADR-0145 D2.1, #1541). It consumes the
  approval before it reads the credential or dials the upstream, so a repeat of the same call, or
  a second parallel call, is refused. `TOOL_GATEWAY_PROBLEM_CODES` gains `approval_already_used`
  (`403`). A migration adds `runs.consumed_tool_calls`, an expand-only column that defaults to `[]`.
- An `openapi` tool connector may expose write operations (ADR-0113 SD4, amended by #1304).
  `allow` accepts `POST`, `PUT`, `PATCH` and `DELETE` rules beside `GET` and `HEAD`, and an
  `operationId:<id>` rule may name a write (`TOOL_OPERATION_METHODS`, `TOOL_WRITE_METHODS`). A
  method outside those six is `connector_spec_invalid`. `toolApprovalRules(serverKey, operations)`
  lists the `mcp__<key>__<operation>` rules that need approval, for the engine's `needsApproval`.
  `TOOL_GATEWAY_PROBLEM_CODES` gains `approval_required` (`403`): the gateway runs a write only for
  a call the run approved. **Removed:** `connector_write_unsupported` from
  `TOOL_CONNECTOR_PROBLEM_CODES` and `CONNECTORS_PROBLEM_CODES`. A write rule is no longer a
  `422`; `readOnly: false` on a PostgreSQL connector is a plain `400 invalid_body`. `openapiTool()`
  in `@indx-workspace/sdk/define` still refuses a write rule until a later release.
- `RunResource` gains a required `pendingApproval` key, and `RunResource.status`,
  `RunStatusEventData.status` and `MetricsRecentRun.status` gain `awaiting_approval`. A client
  parsing a run from an older server must tolerate the absence of the key, and an older client
  rejects a run in the new status.

### Fixed

- `outputSchemaViolation` (and so `StartRunRequestSchema`) now follows each local `#/$defs/<name>` reference when it measures depth: a recursive `$ref`, direct or through other definitions, is refused with the `ref` limit, and a definition counts toward the 16-level `depth` limit at the level that references it. A definition shared by several references is still accepted.

## 0.6.9 — 2026-10-14

### Added

- `EngineCatalogueEntry.sessionEntryKey` states each engine's session-entry idempotency key, with
  `SESSION_ENTRY_KEY_FIELDS` and `SessionEntryKeyField` in `@indx-workspace/contracts/engines`.
- `EngineCatalogueEntry.structuredOutput` states whether an engine can be asked for output shaped
  by a JSON Schema (ADR-0143): `true` for `claude-agent-sdk`, `false` for the others. It is not a
  key of `capabilities`, so `GET /api/engines` is unchanged.
- `approvalOverlapsGate(approved, required)` is the overlap `conflictingApprovalRules` reports, now
  also counting an `Edit` / `Edit(path)` auto-approval against a gate on `Write`, `MultiEdit`,
  `NotebookEdit` or `Edit` (Claude Code checks every file write against `Edit` rules).
- `EngineCatalogueEntry.approvals` states whether an engine can stop a run on a tool call that
  needs approval (ADR-0145 D5): `true` for `claude-agent-sdk`, `false` for the others. It is not a
  key of `capabilities`, so `GET /api/engines` is unchanged.
- Add the MCP server record schemas: `McpServerRecordSchema`, `McpServerConfigSchema`,
  `McpStdioServerConfigSchema`, `McpHttpServerConfigSchema`, `McpSseServerConfigSchema` and
  `McpToolPolicySchema`, with the `McpServerRecord` and `McpToolPolicy` types, exported from the
  package root. Core and the engine adapters parse an `mcpServers` entry with them instead of
  each restating it.
- `claudeReadOnlyGrantDenials`, `claudeRulePath` and `CLAUDE_GRANT_SHELL_DENIALS` in
  `@indx-workspace/contracts/agents`: the Claude denials a read-only file grant compiles to, now
  `Edit(//<absolute path>)` — the only rule shape Claude Code matches for a file write — instead
  of `Write(…)`/`Edit(…)`/`NotebookEdit(…)` rules over a path anchored at the settings source,
  which never matched.

### Changed

- `zod` is a peer dependency (`^4.0.0`) instead of an exact-pinned dependency, so a consumer on
  another zod 4 release gets one zod instance and can compose the exported schemas.
- `ConnectorUpdateRequestSchema.url` (and the new `ConnectorUrlSchema`) refuses a host-less URL
  and one that carries a credential (a user name or password, or a query parameter such as
  `api_key`); `POST /api/connectors` applies the same rule.

## 0.6.8 — 2026-10-14

### Added

- `RUN_START_PROBLEM_CODES` gains `runtime_not_verified` (422): a run whose runtime has no current
  Test Runtime pass fails with this code and the fix, where it used to fail as
  `run_preparation_failed`. A lapsed pass (24 hours, or a new runtime image) of a runtime that has
  passed before is re-verified by the run first. A client that switches on the code exhaustively
  needs the new case.
- `@indx-workspace/contracts/tool-connectors` exports `connectorServerKey`, which picks the
  model-visible server key of an MCP connector (its name when that is a usable slug, otherwise
  `connector-<id>`), with `CONNECTOR_SERVER_KEY_MAX_LENGTH` and `RESERVED_MCP_SERVER_KEYS`
  (#1109, #1119).
- `@indx-workspace/contracts/tool-connectors` exports `describeToolRule` and
  `toolRuleConnectorServer`, which label a rule stored as `mcp__connector-<id>__<tool>` with the
  connector's current key for display. `AgentPolicyResponse` gains an optional `connectorNames`
  (`connector-<id>` → current key) that is never read back; `policy` stays the stored value
  (#1121, #1125).

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

- `EXTERNAL_RUNTIME_PROVIDERS` and the `ExternalRuntimeProvider` type in
  `@indx-workspace/contracts/runtimes` (issue #827, part of): the sandbox providers the `external`
  driver reaches, so an `external` runtime profile can carry `provider: e2b`. Expand-only.

## 0.6.2 — 2026-10-12

### Added

- The engine catalogue (issue #946, part of; ADR-0136): `ENGINE_CATALOGUE` and its helpers
  `isWithholdingEngine`, `engineSettingsSchema`, `mcpToolName`, `DEFAULT_ENGINE_ID` and
  `isEngineId`, exported from `./engines`, plus `engineSettingsOf` from `./agents`. They describe
  each engine in one place; no wire shape changes.
- `RUN_PREPARATION_FAILED` (`'run_preparation_failed'`) in `@indx-workspace/contracts/runs`
  (issue #827, part of): the run-failure code of a run whose request could not be prepared; its
  stored `error` names the failing step and error name. `parseRunFailure` reads it as a coded
  failure. It is not a start refusal and is not in `RUN_START_PROBLEM_CODES`. Expand-only.
- `SETUP_QUESTIONS` gains a twelfth question, `admin.platforms` (flag `platform`, choices the six
  hosted platform ids and `none`, recommended `['none']`), and `SETUP_PLATFORM_CHOICES` is
  exported (issue #977, part of). `HOSTED_PLATFORM_IDS` and `HostedPlatformId` now live in
  `platform-ids.ts` and are still exported from `@indx-workspace/contracts/platforms`.
- `ENGINE_CATALOGUE['claude-agent-sdk'].capabilities.subagents` is now `true` (issue #974, part
  of; ADR-0133 D14): the Claude Agent SDK engine runs a version's subagents. So do `mastra` and
  `openai-agents` (same issue, second slice); only `pi` still declares `false` and refuses them.
- A portable `files` knowledge source takes an optional `access` (`read` or `read-write`; absent
  means `read`), so a read-write grant that is also a knowledge file survives a round trip (issue
  #969, part of; ADR-0133 D2). Existing files are unchanged.
- `AGENT_VERSION_PROBLEM_CODES` gains `network_policy_unsupported` (422): `aw push` and a pointer
  move are refused, naming each code tool (`tool:<name>`), when a tool declares `allowedDomains` and
  the deployment's tool sandbox cannot enforce them (E2B, or docker without the egress proxy). Such
  a version used to be accepted and then fail every run with `503 tool_sandbox_unavailable`
  (issue #1018).
- Problem code `agent_subagent_unusable` (422), a response value of the agent-version save and dry
  run: a subagent the workspace does not have, one that itself has subagents, or an agent that is
  already another agent's subagent declaring subagents (`details`: `subagent:<name>`, then
  `parent:<name>`; issue #969, part of; ADR-0133 D14). A client that switches on the code
  exhaustively needs the new case.
- `AgentVersionBody` gains optional `description`, `subagents` and `knowledge` (issue #969, part of;
  ADR-0133). `EngineCapabilities` gains a required `subagents` boolean and `ENGINE_CAPABILITY_KEYS`
  gains `'subagents'`: a response field, so a client built on an older minor whose strict schema
  does not list it refuses the new engine descriptor. Upgrade the SDK with the server.
- The A2A card's `protocolVersion` and bearer security scheme are now checked against a committed
  excerpt of the A2A v0.3.0 JSON schema (issue #955, part of); see Changed for the new
  `protocolVersion` value.
- `buildA2aAgentCard` accepts an optional `displayName`: it labels the card and its skill, while
  `skills[0].id` and the generated description keep the agent `name` (issue #955, part of).
- `agent-workspace.yaml` accepts an optional `platforms:` block (ADR-0133): one entry per platform
  id with `enabled`, `options` and per-environment overrides; credentials only as
  `{ secret: NAME }`. `PlatformOptionsSchema`, `ProjectPlatformBindingSchema` and
  `ProjectPlatformsSchema` are exported from `@indx-workspace/contracts/project-file` (issue #959).
- `@indx-workspace/contracts/portable-agent`: `PortableAgentSchema` and `PortableProjectSchema`, the
  interchange model for an agent as an external agent host describes it, with their constants and
  types (issue #950, part of; ADR-0133 D2). `@indx-workspace/contracts/platforms`: `PLATFORM_IDS`,
  `PlatformId` and `PlatformIdSchema`, the hosts an agent is exported or published to (ADR-0133 D1).
- `@indx-workspace/contracts/platforms`: the platform capability matrix schema, the per-field
  verdict (`native`, `mapped` or `dropped` with an ADR-0133 D8 drop code), the compiled-file and
  refusal schemas, and `HOSTED_PLATFORM_IDS` (issue #956, part of; ADR-0133 D6-D8). The platform id
  list moves to a leaf module and is re-exported unchanged.
- `ProjectHttpUrlSchema` is exported from `@indx-workspace/contracts/project-file`; its behaviour is
  unchanged.

### Changed

- `A2A_PROTOCOL_VERSION` (and so the served card and `A2aAgentCardSchema`) is now `0.3.0`, the A2A
  v0.3.0 schema default, instead of `0.3` (issue #966, part of). The schema is strict for what the
  control plane emits, so a consumer that parses a card from an older server with it refuses `0.3`.

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Added

- `runtime_connection_missing` and `runtime_connection_credential_unavailable` (both `422`) in
  `RUN_START_PROBLEM_CODES` (issue #827, part of; ADR-0120 LC6): a run on a provider sandbox driver
  whose runtime connection is absent or holds no usable credential. `parseRunFailure` reads them
  as coded problems.
- `PROJECT_DEPLOY_TARGETS` includes `vercel`, so `environments.production.target: vercel` is a valid
  project file (#830, part of; ADR-0126).
- Code tools end to end in a deployment (issue #847, ADR-0118 TS3): `GATEWAY_TOOL_SANDBOX_ROUTE`
  (`POST /v1/tool-sandbox/mcp`) and `TOOL_SANDBOX_CONNECTOR_URL`, the reserved URL `aw push`
  registers the `aw-dev-tools` connector at, in `@indx-workspace/contracts/tool-connectors`.

- `'vercel-sandbox'` joins `RUNTIME_DRIVERS` and the `RuntimeDriver` type (issue #828, ADR-0120). It
  is reserved: the control plane does not offer it yet.
- `cloudflare-sandbox` joins `RUNTIME_DRIVERS` (issue #829, ADR-0120). A runtime profile may name
  it; it is not yet verified against a real Cloudflare account.

- `stdio` MCP servers in the tool sandbox (issue #793, ADR-0118 TS6): the sandbox manifest takes
  `stdioServers` (each `name`, `command`, `args`, `timeoutMs`), and
  `tools` may be empty when a server is present. A server's command must be `npx`, then optionally
  `-y`, then `<package>@<exact version>`; a range, a tag or any other command is refused by the
  field's path. New problem code `stdio_connector_needs_tool_sandbox` (`422`): promoting, or
  pointing an environment other than `local` at, a version that lists a `stdio` connector.

- Hosted tool sandbox (issue #791, ADR-0118 TS1, TS4, TS5): a version's `toolBundles` entry also
  records the tool's declaration, all optional: `description`, `inputSchema`, `outputSchema`,
  `timeoutMs`, `secrets` (names only) and `allowedDomains`. The entry stays strict, so a client
  built before this release refuses a body that carries them; upgrade `aw` with the server. New
  exports `ToolSecretNamesSchema`, `ToolAllowedDomainsSchema`, `TOOL_SANDBOX_DECLARATION_MAX` and
  `TOOL_BUNDLE_TIMEOUT_MAX_MS` in `@indx-workspace/contracts/agent-versions`.

- Larger evaluations (issue #799, ADR-0121): `EVALUATION_RUN_CASE_LIMIT` (200) and an asynchronous
  evaluation run the client follows. `POST /api/agents/:id/evaluation-runs`
  (`agents.evaluationRuns.create`, `202`) stores a run of up to 200 cases and
  `POST /api/agents/:id/evaluation-advance` (`agents.evaluationRuns.advance`, body
  `{ evaluationId }`) runs the next cases until it is `completed`;
  `GET /api/agents/:id/evaluation-runs?evaluation=<id>` (`agents.evaluationRuns.get`) reads a run,
  the baseline `aw eval --baseline` diffs against. New exports in
  `@indx-workspace/contracts/evaluations`: `CreateEvaluationRunRequestSchema`,
  `AdvanceEvaluationRunRequestSchema`, `EvaluationRunResourceSchema`, `EVALUATION_RUN_STATUSES`, and
  the problem codes `evaluation_not_found` (404) and `evaluation_run_busy` (409).
  `EvalCaseFileSchema` takes up to 200 cases; `CreateEvaluationRequestSchema` (the synchronous
  route) stays at `EVALUATION_CASE_LIMIT` (20).
- `EvalExpect.toolInput` (issue #799): an optional object, with `tool`, that some call to the tool
  must match key by key (a subset match), at most `EVALUATION_TOOL_INPUT_MAX_LENGTH` characters as
  JSON. A client built before this release refuses a case file that carries it.
- Tool bundles (issue #790, ADR-0118 TS1): `AgentVersionBodySchema` takes an optional `toolBundles`
  (`{ tool, digest }[]`, one entry per tool): the SHA-256 of each code tool's bundled run file.
  `POST /api/tool-bundles` stores a bundle once by its digest, `GET /api/tool-bundles/:digest`
  says whether the workspace holds it, and a version that pins a digest the workspace does not
  hold is refused `422 tool_bundle_unknown` (`tool_bundles_not_configured` 503 where the deployment
  keeps no bundles). New exports in `@indx-workspace/contracts/agent-versions`:
  `TOOL_BUNDLE_MAX_BYTES`, `ToolBundleDigestSchema`, `TOOL_BUNDLE_PROBLEM_CODES`, the upload and get
  schemas, and `AgentVersionToolBundleSchema`. A client built before this release parses a body
  that carries `toolBundles` strictly and refuses it, so upgrade `aw` and the SDK with the server.
- `SETUP_SANDBOX_OFFERED_CHOICES` (`auto`, `local`) in `@indx-workspace/contracts/setup` (#818): the
  sandbox choices setup offers. The `admin.sandbox` question's `answer.choices` is this list.
- Scripted models (issue #798): `SCRIPTED_MODEL_PREFIX`, `SCRIPTED_MODEL_NAME_PATTERN` and
  `ScriptedModelScriptSchema` in `@indx-workspace/contracts/models` describe the file the gateway's
  test-only scripted model replays.
- `THEME_RECOMMENDATIONS[theme].summary`: a one-line description of each setup theme, shown beside
  the theme in the setup menu (UX-A, #760).
- `networkPolicyFloor` in `@indx-workspace/contracts/policy-ceiling` (issue #785, ADR-0119): the
  sandbox network policy a run gets. Without `unrestrictedNetwork` a profile's `open` is lowered to
  `restricted` with the run's remote connector hosts, or to `none` when it has none.
- `network_policy_unenforceable: 422` in `RUN_START_PROBLEM_CODES` (issue #785, ADR-0119): the run
  was lowered to `restricted` on a driver that cannot enforce it (Cloud Run, ACA, or Docker and
  Kubernetes without `AGENT_WORKSPACE_EGRESS_PROXY_IMAGE`). The run fails with this code; it never
  falls back to `open`.
- `run_deadline_exceeds_host: 422` in `RUN_START_PROBLEM_CODES` (issue #830, ADR-0120 LC7): the
  runtime profile's `timeoutSeconds` is longer than the longest run the control plane's host allows
  (the function's maximum duration on Vercel). The run fails with this code before the runtime is
  contacted.

### Deprecated

- `sandbox-runtime` in `SETUP_SANDBOX_CHOICES` and as an `admin.sandbox` answer (#818): the driver
  has no implementation. It is still accepted, no longer offered, and renders as the `local`
  runtime. It is removed from the accepted answers no earlier than the next major release. The
  runtime contract ids and the project file schema keep it.

## 0.5.0 — 2026-10-06

### Added

- Code tools (issue #693, ADR-0115): `AW_DEV_TOOLS_CONNECTOR` (`aw-dev-tools`) in
  `@indx-workspace/contracts/tool-connectors` names the local connector that serves `defineTool`
  tools, and `AGENT_VERSION_PROBLEM_CODES` gains `code_tool_needs_host` (422): a version that lists
  it cannot be pointed at an environment but `local`, nor promoted.
- `UnavailableModelConnection` in `@indx-workspace/contracts/models` gains optional `kind` and
  `status` (issue #690, #685 item 2): why a ready connection's discovery failed, so a client can
  tell a rejected key from an unreachable provider. `kind` is one of the new
  `UNAVAILABLE_MODEL_CONNECTION_KINDS`; an older server omits both.

## 0.4.0 — 2026-10-05

### Added

- The promotion gate (issue #619): `ProjectPolicySchema` gains an optional `promotion`
  (`ProjectPolicyPromotionSchema`, `{ minEvalScore }` from 0 to 1), which neither
  `policyWidenings` nor `meetPolicyCeiling` reads. `AGENT_VERSION_PROBLEM_CODES` gains
  `promotion_not_evaluated` (409) and `promotion_gate_failed` (409). A server older than this
  release refuses a policy that carries `promotion` at start-up.
- A provider that cannot be connected to (issue #661): `RUN_START_PROBLEM_CODES` gains
  `model_connection_failed` (422) — the connection was refused or its name did not resolve, so the
  fix is the base URL or the network, not the key. A server older than this release answers
  `model_connection_unresolved` for the same case. `LocalRuntimeEnvironmentSchema` gains an
  optional `modelSecrets`: the `credential.secret` names of the model connections the project's
  agents use, names only.
- `AgentPointerMoveResponseSchema` gains `bar`, the promotion bar the move passed, or `null`
  (issue #619). It defaults to `null`, so this release reads an older server's answer; a client
  that predates it refuses an answer that carries it, which the same 0.4.0 minor covers.
- `AgentVersionListResponseSchema` gains `evaluations`, the newest evaluation (`version`, `score`,
  `passed`, `total`) of every version that has one (issue #714), the score the promotion gate reads
  and the Versions tab shows. It defaults to `[]`, so this release reads an older server's listing;
  a 0.3 client's strict schema refuses a listing from a server that sends it, which the same 0.4.0
  minor covers.

- `StartRunRequestSchema` gains an optional `version`, a version number (1 to 2147483647), which
  runs a new session on that version of the agent instead of the one `local` names (issue #697,
  #725). `version` with a `sessionId` is refused. A 0.3.0 server rejects the key as unknown
  (`400 invalid_body`), so omit it against 0.3 servers.
- `SetupQuestion` gains `flag`, the command-line flag that answers the question without the dashes
  (`theme` is `--theme`; `provider`, `agent`, `engine`, `tools`, `openapi`, `permissions`, `title`,
  `color` and `sandbox` are the others), which `create` and `aw init` read (#708). Local to the
  setup module; no HTTP route carries it.

### Changed

- `isReservedSecretName` (issue #664) also refuses `GATEWAY_PORT`, `RUNNER_PORT` and
  `AW_DATABASE_PORT`, which the local runtime now derives from the web port.
- `EVALUATION_PROBLEM_CODES` loses `evaluation_version_not_local` (409), which 0.3.0 added
  (issue #618): each case now runs on a session pinned to the requested version (#612), so any
  version of the agent can be evaluated whatever `local` points at.

## 0.3.0 — 2026-10-04

### Added

- `@indx-workspace/contracts/project-file`, the `agent-workspace.yaml` project file (ADR-0103,
  issue #439): `ProjectDocumentSchema` (`apiVersion: agentworkspace.dev/v2`, `kind: Project`, a
  `name` and `environments.local`), the general `ProjectEnvironmentSchema` and the slice-1
  `LocalEnvironmentSchema`, the structural `DeploymentDocumentV1Schema`, and
  `readProjectDocument`, which reads either version without throwing and lifts a v1 `Deployment`
  into a v2 shape. Also `PROJECT_CLOUDS`, `NAME_KEY_PATTERN`, `DEFAULT_LOCAL_PORT`,
  `DEFAULT_BOOTSTRAP_ADMIN`, `BootstrapAdminSchema` (at most 320 characters, no control
  character — C0, DEL or C1 — so no client has to re-check before printing it, shared with the
  `start` message) and `IMPLEMENTED_RUNTIME_DRIVERS`, the drivers a project file may name.
- `@indx-workspace/contracts/setup`, the first-run setup questions (ADR-0107, issue #439):
  `SETUP_QUESTIONS` in asking order with their audience, recommended answer, the files each
  writes and the answer schema; `SetupAnswersSchema`, `CompleteSetupAnswersSchema`,
  `withRecommendedAnswers`, `SETUP_AUDIENCES` and `HEX_COLOUR_PATTERN`. No answer is a secret.
- `@indx-workspace/contracts/local-runtime`, the IPC messages between the CLI and the local
  runtime it starts (ADR-0109, issue #439): `start`, `ready`, `credential` and `failed`, the
  `LocalRuntimeMessageSchema` union, the per-direction `LocalRuntimeParentMessageSchema` and
  `LocalRuntimeChildMessageSchema`, and `LOCAL_RUNTIME_MESSAGE_TYPES`. The `credential` message's
  `token` is a workspace API key (`ak_live_…`, `API_KEY_PATTERN`) for the local workspace, not a
  CLI user token (ADR-0109 amendment, issue #500).
- `@indx-workspace/contracts/surfaces`, the declared chat surface of an agent, rungs 1 and 2
  (ADR-0108, issue #440): `SurfaceDefinitionSchema` (`name`, `agent`, `title`, `theme`, `layout`
  and `parts`), `SurfaceThemeSchema`, `SurfaceLogoSchema` and `SurfacePartsSchema`, with
  `SURFACE_LAYOUTS`, `SURFACE_THEME_MODES`, `SURFACE_DENSITIES`, `SURFACE_LOCALES`,
  `SURFACE_TOOL_TRACE_MODES`, `SURFACE_RADIUS_MAX` and `SURFACE_SUGGESTED_PROMPTS_MAX`. `title` is
  included so the first-run setup question `embedder.surfaceTitle` has a field to write; it is
  not in ADR-0108's slice-1 list. A logo URL is stored exactly as written: it must be a canonical
  `https://` URL with no user name or password, whitespace, control character, backslash, quote,
  backtick, angle bracket or parenthesis. Free text and the surface's `agent` must start and end
  with a visible character; free text admits ZWJ, ZWNJ and tag characters for emoji, and
  suggested prompts must be a non-empty list with no repeats.
- `@indx-workspace/contracts/agent-versions`, saved agent versions and environment pointers
  (ADR-0101, ADR-0108, issue #440): `AgentVersionBodySchema` (an agent definition plus up to 16
  surfaces, unique by name and naming that agent), `AgentVersionSummarySchema`,
  `AgentVersionDraftSchema`, `CreateAgentVersionRequestSchema` (with `dryRun: true`),
  `AgentVersionResourceSchema`, `AgentVersionCheckResponseSchema`, `AgentVersionPointerSchema`,
  `AgentVersionListResponseSchema`, `SetAgentPointerRequestSchema`,
  `SetAgentPointerResponseSchema`, `CreateAgentFromVersionRequestSchema` and
  `CreateAgentFromVersionResponseSchema`; `AGENT_VERSION_VIAS`, `AGENT_ENVIRONMENTS`,
  `AgentEnvironmentSchema`, `AGENT_VERSION_SURFACES_MAX`, `AGENT_VERSION_SUMMARY_MAX_LENGTH`,
  `AGENT_VERSION_NUMBER_MAX` (PostgreSQL's `integer` maximum, the bound of every version number),
  and the `AGENT_VERSION_PROBLEM_CODES` table, which reuses the agent policy and agent definition
  statuses and includes `invalid_agent_id` and `agent_policy_not_configured`. A list response
  holds at most one pointer per environment.
- The hosted surface page's local session contract in `@indx-workspace/contracts/surfaces`
  (ADR-0105 slice 1, issue #455): `SurfaceSessionResponseSchema` and `SurfaceSessionResponse`, the
  `201` of `POST /p/s/<name>/sessions` (a session-scoped browser token, its session id, the
  agent's id and its expiry); `SURFACE_SESSION_TTL_SECONDS` (3600, the browser-token ceiling);
  and the `SURFACE_SESSION_PROBLEM_CODES` table (`surface_sessions_unavailable` and
  `surface_not_found` 404, `invalid_body` 400, `surface_sessions_not_configured` 503, and the
  run-start codes: 422, and 403 for `policy_cannot_widen`). `API_ROUTE_EXCLUSIONS` lists
  `GET /p/s/:name` and `POST /p/s/:name/sessions`: both are pages outside `/api`, so no `/api`
  route changes.
- `API_ROUTE_EXCLUSIONS` lists `GET /p/s/:name/widget.js`, the one-tag surface widget loader, and
  `GET /p/s/:name/try`, the page that hosts it (ADR-0105, issue #456). Both are served outside
  `/api`, so no `/api` route changes.
- `AGENT_VERSION_PROBLEM_CODES` now publishes `agent_name_conflict: 409` (issue #480).
  Create-from-version, and a pointer move that would rename the agent onto a taken name, answer it
  under the same status and code as legacy `POST`/`PATCH /api/agents`, so an SDK consumer can
  branch on it from the contract alone.
- `@indx-workspace/contracts/secret-reference` (ADR-0102 SD6, issue #524, C10):
  `SecretReferenceSchema` and `SecretReference`, a secret named by `{ secret: NAME }` (the
  `secrets` name grammar). A string where a reference belongs is refused at its path, and the
  refusal never echoes the value. Also `SecretNameSchema` (the name inside a reference),
  `RESERVED_SECRET_NAMES`, `ReservedSecretName`, `RESERVED_SECRET_NAME_PREFIX` (`AW_`) and
  `isReservedSecretName` (ADR-0109 slice-2 amendment, issue #564): a reference to a name the local
  runtime uses (`PORT`, `PATH`, `DATABASE_URL`, any `AW_` name, in any case) is refused at its
  `secret` path. Its message ("PATH is a variable the local runtime uses; name the secret
  something else") is the one that names its input, and only as an upper-cased ASCII identifier.
- `@indx-workspace/contracts/policy-ceiling` (ADR-0102 SD6, issue #524, C12 to C14):
  `ProjectPolicySchema` (`permissions`, `limits`, `engines`, `models` and `tools`;
  `maxCostPerDayUsd`, `network` and `approval` are refused as not built yet, and `connections` is
  an unknown key), `ProjectPolicyPermissionsSchema`, `ProjectPolicyLimitsSchema`,
  `POLICY_CEILING_MODELS_MAX`, `POLICY_CEILING_TOOL_NAME_MAX_LENGTH`,
  `EffectivePolicyConfiguration`, `PolicyWidening`, `policyWidenings` (the widenings of an
  effective configuration over a ceiling, in C14 order) and `meetPolicyCeiling` (the
  configuration narrowed to the ceiling; an engine or model outside it is left for the caller to
  refuse).
- `ProjectDocumentSchema` in `@indx-workspace/contracts/project-file` accepts optional `engine`,
  `models` (named model connections: provider, credential reference and the provider's keys, no
  model id; C11), `connectors` (named HTTP or SSE MCP connectors with an optional credential
  reference) and `policy` (the ceiling) (issue #524). `environments.local.policy` is refused: a
  per-environment policy is not built yet. Adds `ProjectModelConnectionSchema`,
  `ProjectConnectorSchema`, `PROJECT_CONNECTOR_TRANSPORTS`, `PROJECT_CONNECTOR_AUTH_SCHEMES` and
  `PROJECT_RESOURCE_MAP_MAX_ENTRIES`. Every slice-1 project file parses unchanged. A `models` or
  `connectors` entry keyed `__proto__` is refused at its path rather than dropped; a connector
  `url` or model `baseUrl` with a user name, a password or a credential query parameter (`token`,
  `api_key` and the like) is refused, since a credential is only ever a secret reference; and a
  ceiling's `models` entry may not hold a control character, as `tools` may not.
- The local runtime `start` message's `environment` carries an optional `policy`, the project
  file's ceiling (C13, issue #524).
- The local runtime `start` message's `environment` carries an optional `withheld`, the names
  (never the values) of the secrets the project references, unique, not reserved and at most
  `LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES` (256) (ADR-0109 slice-2 amendment, issue #564). A runtime
  older than the key refuses it as unknown.
- `policy_cannot_widen: 403` in `AGENT_POLICY_PROBLEM_CODES`, `AGENT_VERSION_PROBLEM_CODES` and
  `RUN_START_PROBLEM_CODES` (and so in `SURFACE_SESSION_PROBLEM_CODES`) (issue #524, C14): a
  configuration wider than the project's ceiling, answered whatever the caller's role, with the
  widenings as `details`. `parseRunFailure` reads it back from a run's stored `error`.
- Agent tool rules accept a single `_` inside an MCP server name, such as `mcp__orders_2__*`, so
  an SD13 tool server key can be approved or denied (ADR-0113, issue #531). `__` and a leading or
  trailing `_` are still refused.
- `@indx-workspace/contracts/tool-connectors`, the tool connectors and the gateway tool route
  (ADR-0113 SD1, SD4, SD13, SD14, SD15, C15–C17, issue #526): `TOOL_CONNECTOR_KINDS`
  (`openapi`, `postgres`); the create bodies `CreateOpenApiConnectorRequestSchema` (the document
  as text up to `OPENAPI_DOCUMENT_MAX_BYTES`, 1 MiB in UTF-8; `baseUrl`; `allow` of 1–256
  `GET`/`HEAD` path globs or `operationId:` rules; `auth` `none`, `bearer` or `{ header }`; a
  write-only `credential`; `dryRun`), `CreatePostgresConnectorRequestSchema` (a write-only
  `postgres://` URL, 1–64 qualified `tables`, `readOnly: true`, `maxRows` at most 1000, default 100) and the discriminated `CreateToolConnectorRequestSchema`; the leaf schemas
  `ToolOperationNameSchema`, `ToolOperationSchema`, `OpenApiAllowRuleSchema`,
  `OpenApiAllowSchema`, `OpenApiAuthSchema` (with `OPENAPI_AUTH_HEADER_REFUSED_NAMES`),
  `PostgresTableNameSchema`, `PostgresTablesSchema` and `PostgresMaxRowsSchema`; the resource
  halves `OpenApiSpecSummarySchema`, `OpenApiToolConfigSchema` and `PostgresToolConfigSchema`;
  `selectAllowedOperations` (SD14 matching, shared with registration; a path rule that admits
  nothing is `connector_spec_invalid`); `toolServerKey` (SD13) and `toolServerKeys`, which keys a
  run's connectors uniquely even when a name spells another's `_<n>` suffix; a key never
  contains `__` or ends in `_` (issue #531);
  `TOOL_OPERATION_NAME_PATTERN` with the 41-character cap; `GATEWAY_TOOL_ROUTE`,
  `gatewayToolPath` and `parseGatewayToolPath`; `TOOL_CONNECTOR_PROBLEM_CODES`
  (`connector_spec_invalid` 422, `connector_write_unsupported` 422,
  `connector_tool_name_collision` 422, `connector_kind_unsupported` 400) with
  `problemCodeOfIssue`, and `TOOL_GATEWAY_PROBLEM_CODES` (`tool_run_not_active` 401,
  `tool_not_in_run` 403, `tool_upstream_failed` 502, `tool_upstream_timeout` 504). A `baseUrl`
  carries no credential (no user name, password or credential query parameter such as `api_key`,
  `token`), backslash or fragment; a header credential is visible ASCII with spaces or tabs only
  inside; a `postgres` URL names one host in its authority and carries only the query parameters
  in `POSTGRES_URL_QUERY_PARAMETERS` (`sslmode`, `connect_timeout`, `application_name`), so
  `?host=`, `?options=` and a host list are refused; `readOnly: false` and a write method in any
  case are `connector_write_unsupported`; a name holds no control or bidirectional formatting
  character; a table in a system schema (`pg_*`, `information_schema`) is refused. No message
  echoes a credential, a URL or the document.
- `CONNECTOR_KINDS`, `ConnectorKind`, `connectorKindOf`, `McpConnectorResource`,
  `isMcpConnectorResource`, `OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES` (twice the document cap
  plus 64 KiB, so an escaped 1 MiB document fits) and `CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND`
  in `@indx-workspace/contracts/connectors` (issue #526). `CONNECTOR_REQUEST_BODY_MAX_BYTES` stays
  64 KiB, the `mcp` cap. `CONNECTORS_PROBLEM_CODES` now includes the tool connector codes.
- `@indx-workspace/contracts/project-file` names the ports the local runtime keeps for itself
  (ADR-0109, issue #560): `LOCAL_RUNTIME_GATEWAY_PORT` (4000), `LOCAL_RUNTIME_RUNNER_PORT` (8080),
  `LOCAL_RUNTIME_RESERVED_PORTS` with the service each belongs to, and `LocalPortSchema`, which
  `LocalEnvironmentSchema.port` now uses. `environments.local.port: 4000` or `8080` is refused
  with one issue naming the service ("is reserved by the local runtime's gateway (4000); choose
  another port") instead of failing later as "already in use"; such a project could never start.
  `ProjectEnvironmentSchema.port` and the `start` message are unchanged.
- `RUNTIME_CAPACITY_EXHAUSTED` in `@indx-workspace/contracts/runs` (issue #557), and
  `RunFailure.code`/`parseRunFailure` recognise it. A run whose runtime stayed at its
  concurrent-run capacity for the server's whole bounded wait fails with a stored `error` of
  `runtime_capacity_exhausted: <message>`; nothing ran, so a client may offer to resend. It is a
  run-failure code, not a start refusal, so `RUN_START_PROBLEM_CODES` is unchanged.
- `@indx-workspace/contracts/feedback`, the body that rates one run (contract C19, issue #537):
  `RunFeedbackRequestSchema` (`rating` of `RUN_FEEDBACK_RATINGS`, `up` or `down`, and an optional
  non-blank `comment` of at most `RUN_FEEDBACK_COMMENT_MAX_LENGTH`, 1000, characters) and
  `RunFeedbackRequest`. The route and its problem codes come with the server unit (S2-05c).
- The surface session bootstrap request in `@indx-workspace/contracts/surfaces` (contract C18,
  issue #537): `SurfaceSessionRequestSchema` and `SurfaceSessionRequest` (an optional
  `resume: { sessionId, resumeKey }` and an optional offered `agent`), `SURFACE_RESUME_KEY_PATTERN`
  (the base64url of 32 bytes), an optional `resumeKey` on `SurfaceSessionResponseSchema`, and the
  `404` codes `surface_session_not_resumable` and `surface_agent_not_offered` in
  `SURFACE_SESSION_PROBLEM_CODES`. `resumeKey` is optional by decision: C18 carries it once, when
  a session opens, and the slice-1 server and clients parse the response strictly without it.
- Rung-2 surface constants and schemas in `@indx-workspace/contracts/surfaces` (ADR-0108 SD10,
  issue #537): `SURFACE_AGENT_SWITCHER_MAX`, `SURFACE_TOOL_RESULT_COMPONENTS`,
  `SurfaceToolResultComponentSchema`, `SurfaceToolResultComponent`, `SURFACE_TOOL_NAME_PATTERN`
  (a tool name as a run frame carries it, 1-64 characters), `SURFACE_TOOL_RESULTS_MAX_ENTRIES`
  and `SurfaceToolResultsSchema`.
- Setup themes and new questions in `@indx-workspace/contracts/setup` (ADR-0107 SD9, contract
  C20, issue #525): `SETUP_THEMES` and `THEME_RECOMMENDATIONS` (each theme's recommended answers
  and sample content: instructions, greeting, up to six prompts and a title; no theme recommends a
  tool or a permission), `setupQuestionApplies`, the `multi` answer format
  (`{ kind: 'multi', choices, max }`) and a question's optional `when`. Five questions:
  `setup.theme` (asked first, recommends `support`), `admin.modelProvider`,
  `content.internalTools` (multi over `openapi | postgres | none`, `none` alone),
  `content.openapiDocument` (a project-relative `.json`/`.yaml`/`.yml` path or an `https` URL
  without a credential, asked only when `openapi` is chosen) and `content.permissions` (multi over
  the agent permission keys). `SETUP_FILE_PATHS` gains `tools/<name>.ts`.
- The ratings of an agent's runs (issue #620): `RunFeedbackListQuerySchema` (`rating`, `since`,
  `runId`, all optional and strict), `RunFeedbackItemSchema` (`runId`, `rating`, `comment`,
  `input`, `answer`, `createdAt`), `RunFeedbackListResponseSchema`, `RUN_FEEDBACK_LIST_LIMIT` (50)
  and `RUN_FEEDBACK_LIST_PROBLEM_CODES` in `@indx-workspace/contracts/feedback`, with the route
  `GET /api/agents/:id/feedback` (`agents.listFeedback`). `EvalCaseSchema` takes an optional
  `fromRun` (a run id), kept on a case made from a rated run and never scored.
- `@indx-workspace/contracts/evaluations`, evaluation cases as data and the stored score (issue
  #618): `EvalCaseFileSchema` (the `evals/<agent>.yaml` file: 1 to `EVALUATION_CASE_LIMIT`, 20,
  uniquely named cases), `EvalCaseSchema`, `EvalExpectSchema` (`contains`, `notContains`, `tool`
  and `judge`, at least one), `CreateEvaluationRequestSchema` (`{ version, cases }`),
  `EvaluationCaseResultSchema`, `EvaluationResourceSchema` and `EVALUATION_PROBLEM_CODES`, with
  the route `POST /api/agents/:id/evaluations` (`agents.evaluate`). The server runs each case as an
  ordinary run, so case runs are metered as runs; a `judge` call is made in the web process
  through the gateway's provider adapter, not through the gateway, and is **not metered** in
  `run_usage_records` yet. `evaluation_version_not_local` (409) is answered while a case can only
  run the version `local` points at, and goes when sessions can be pinned to a version (#612).
- Embedding a surface on a customer's site (issue #622): `SurfaceDefinitionSchema` accepts
  `allowedOrigins` (`SurfaceAllowedOriginsSchema`: 1 to `SURFACE_ALLOWED_ORIGINS_MAX`, 20, unique
  canonical origins, `https://` or `http://` on `localhost`, `127.0.0.1` or `[::1]`, with no path,
  trailing slash or wildcard) and `limits` (`SurfaceLimitsSchema`: `turnsPerConversation`, 1 to
  `SURFACE_TURNS_PER_CONVERSATION_MAX`, 1000). `SURFACE_LIMIT_PROBLEM_CODES` adds
  `surface_rate_limited` and `surface_turn_limit_reached` (both 429), and
  `SURFACE_SESSION_PROBLEM_CODES` gains `surface_origin_not_allowed` (403) and
  `surface_rate_limited`. A control plane older than this release refuses a saved surface that
  carries either new key.
- Promote and roll back (issue #615): `PromoteAgentRequestSchema` (`{ version?, dryRun? }`, always
  into `production`), `RollbackAgentRequestSchema` (`{ environment?, dryRun? }`, `environment`
  defaulting to `production`), `AgentPointerMoveResponseSchema` (`{ environment, from, to, saved }`),
  `AgentPointerMoveSchema`, `AGENT_POINTER_MOVE_REASONS` (`set | promote | rollback`) and
  `AGENT_POINTER_MOVES_LISTED` (10), with the routes `POST /api/agents/:id/promote`
  (`agents.promote`) and `POST /api/agents/:id/rollback` (`agents.rollback`).
  `AGENT_VERSION_PROBLEM_CODES` gains `no_pointer` (409) and `nothing_to_roll_back` (409).

### Changed

- `@indx-workspace/contracts/setup` (issue #525): `SETUP_AUDIENCES` gains a leading `setup`, and
  `SETUP_QUESTIONS` asks ten questions in a new order. `SetupAnswersSchema` and
  `CompleteSetupAnswersSchema` are the partial and complete forms of one shape, and both refuse an
  answer to a conditional question that does not apply; the complete form requires one that does.
  `withRecommendedAnswers` applies the chosen theme's recommendations before each question's own,
  and now throws a `ZodError` on inconsistent answers. With no theme it keeps the slice-1 answers,
  so a rendered project is unchanged.

- `ConnectorResourceSchema` gains an optional `kind` (absent means `mcp`) and the optional
  `openapi` and `postgres` halves, and its `transport` and `authType` become nullable: both are
  `null` for a tool connector, as are `command`, `args` and `url`. Each kind's consistency is
  checked and refused at its own key, including `hasCredential` against the kind and `auth`
  (issue #526). `kind` is optional rather than defaulted to `mcp`, a recorded deviation from the
  plan's wording: a default would add `kind` to every re-serialised MCP resource, which a 0.2
  client's strict schema refuses. The server may omit `kind`, `openapi` and `postgres` for MCP
  connectors, so a 0.2 client keeps parsing every MCP-only list; a 0.2 client served by a 0.3
  server refuses a list that holds a tool connector with `ContractViolationError` rather than
  dropping the item, because the next minor still serves 0.2 (one minor back), so `426` does not
  apply. Whether the server filters tool connectors for older clients is S2-02c's decision.
- `SurfacePartsSchema` and `SurfaceDefinitionSchema` accept ADR-0108 rung 2 completed (SD10,
  issue #537): `parts.history`, `parts.feedback`, `parts.agentSwitcher` (1-6 unique agent names)
  and a top-level `toolResults` map, and `SURFACE_TOOL_TRACE_MODES` gains `full`. Attachments are
  still refused. A 0.2 client that reads a version body using them refuses it; this is the same
  served-shape widening the 0.3.0 minor below already covers.
- `AGENT_ENVIRONMENTS` gains `production` (issue #612), so `SetAgentPointerRequestSchema` accepts
  it and `AgentVersionPointerSchema` may carry it. `preview` is still refused. A 0.2 client refuses
  a version listing that holds a `production` pointer; the same 0.3.0 minor covers it.
- `AgentVersionListResponseSchema` gains `moves`, the agent's last 10 pointer moves, newest first
  (issue #615). It defaults to `[]`, so this release reads an older server's listing. A 0.2 client's
  strict schema refuses a listing from a server that sends it, which the same 0.3.0 minor covers.
- Version: this section's served-shape change (issue #526) means the release that ships it must be
  a lock-step **minor**, 0.3.0, with `CONTRACTS_VERSION` moved to match. This release makes that
  bump across every published package, the CLI and its release fixtures (issue #608). The other
  entries above are local-file, IPC and not-yet-served contracts.

## 0.2.1 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.2.1. No change to this package.

## 0.2.0 — unreleased

### Added

- `RUN_START_PROBLEM_CODES` in `@indx-workspace/contracts/runs`, the `422` problem codes a run
  start is refused with before any run is created (issue #393): `agent_runtime_profile_missing`,
  `model_connection_unresolved`, `model_unavailable` and `model_credential_rejected`, with the
  `RunStartProblemCode` type and `isRunStartProblemCode`.
- `parseRunFailure(error)` and `RunFailure`, which split a run's stored `error` of the form
  `<code>: <message>` into a recognised code (a run-start code or
  `engine_model_protocol_unsupported`, else `null`) and its message.

### Changed

- `CONTRACTS_VERSION` is `0.2.0`, a minor release for the additions above (ADR-0078 D7). The server
  serves the current and the previous minor, so 0.1.x clients are still served.

## 0.1.3 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.3, which pins platform images 0.1.2. No
  change to the contracts.

## 0.1.2 — unreleased

### Changed

- `CONTRACTS_VERSION` is `0.1.2`, the lock-step patch release that carries `@indx-workspace/cli`'s
  remote-daemon, port-conflict and sign-in fixes (issue #389). The wire is unchanged: a server
  compares versions on `major.minor`, so 0.1.0, 0.1.1 and 0.1.2 clients are served alike.

## 0.1.1 — unreleased

### Changed

- `CONTRACTS_VERSION` is `0.1.1`, the lock-step patch release that carries `@indx-workspace/cli`'s
  generated-project fixes (issue #377). The wire is unchanged: a server compares versions on
  `major.minor`, so a 0.1.0 and a 0.1.1 client are served alike.

## 0.1.0 — unreleased

### Added

- Published to npm as `@indx-workspace/contracts`, in lock-step with
  `@indx-workspace/sdk` and `@indx-workspace/aw` at `CONTRACTS_VERSION` (issue #246, ADR-0082). The
  tarball carries `dist/` and the manifests only. The `@agent-workspace` npm scope belongs to a
  third party; no release of this package is published there.
- `CONTRACTS_VERSION`, the API version a client is built against, exported from the package root,
  with the negotiation vocabulary: `CONTRACTS_VERSION_HEADER` (`x-agent-workspace-contracts`),
  `CONTRACTS_MINIMUM_VERSION_HEADER` (`x-agent-workspace-contracts-minimum`),
  `CONTRACTS_VERSION_PROBLEM_CODES` (`contracts_version_unsupported` `426`,
  `contracts_version_malformed` `400`), `parseContractsVersion` and `judgeContractsVersion`
  (issue #244, ADR-0078).
- The wire contracts of every `/api/**` resource family, one subpath each.

### Deprecated

- `detail` in the `ApiProblemSchema` envelope, a duplicate of `message` (ADR-0075). It is removed in
  the next major release, no earlier than one minor after this one.
