# Inventory of formalisable surface

> Written by the read-only Phase-0 inventory survey of `main @ f3c9dec` in the worktree
> `<repo>-formal`, as `docs/formal/00-orchestrator-prompt.md` §2 requires.
> Paths are repo-relative. `Lnn` is the declaration line at that commit. All counts were measured,
> not estimated. Appendix A's seed facts are re-checked in the final section. **Code is today's
> truth.** An entry marked ⚠ is a *finding candidate* for `docs/formal/findings.md`. It is not a
> ruling.

---

## 0. Headline numbers

| Fact | Value | Where |
|---|---|---|
| `@indx-workspace/contracts` export entries | **19**: root `.` plus **18** subpaths | `packages/contracts/package.json` |
| Contract modules (non-test `.ts`) | 20 (18 subpaths, plus `identifiers.ts` and `problem.ts` re-exported from root `index.ts`) | `packages/contracts/src/` |
| Exported `*Schema` constants | **111** | same |
| `*_PROBLEM_CODES` maps | **5**: `COMMON`, `AGENT_POLICY`, `FILES`, `SHARES`, `SKILLS` | same |
| RBAC `RESOURCES` | **25** | `apps/web/server/rbac/resources.ts` L2 |
| Classified sub-resource pairs | **17**: 3 from §34 plus 14 from 11 declaration files | `rbac/permissions.ts` L77, `rbac/declarations/*.ts` |
| DB tables | **33** (30 tenant-scoped, 3 exempt) | `packages/core/src/db/schema/*.ts` |
| Migrations | `0000…0027`; latest snapshot is `migrations/meta/0027_snapshot.json` at the **repo root** | `migrations/` |
| Declared routes | **101** entries in 29 files (100 `landed: true`, 1 `landed: false`: `GET /p/:token`) | `tests/route-declarations/*.ts` |
| Route handler files | 61 `route.ts` under `apps/web/app/api/**` | — |
| `aw` commands | **88** | `packages/aw/src/commands/*.ts` |
| SDK resource clients | 16 top-level members on `AgentWorkspaceClient` (`me` plus 15 families) | `packages/sdk/src/index.ts` L106 |
| Latest numbered ADR | **0059**; `0040` is used twice | `docs/adr/` |
| Lean / TLA+ / Alloy / Coq / Dafny | none tracked | `git ls-files` |
| `fast-check` | absent from `pnpm-lock.yaml`. The only textual hits are the CI job name `fast-checks` | — |
| `it.each` occurrences | 138 (143 counting `test.each`/`describe.each`) in 57 files | — |

---

## 1. Contracts (`packages/contracts/src`)

Conventions: **S** means `.strict()`, **R** means `.readonly()`, **opt** means `.optional()` (the key may be absent), **null** means `.nullable()` (the key is present and the value may be `null`), and **opt+null** means both. Every object schema is `.strict()` except `RelayedEventDataSchema`, which is a `z.looseObject`. **Not** `.readonly()`: all four invitation schemas, `ProjectResourceSchema`, `ProjectListResponseSchema`, and every team schema (`MeResponse`, `Membership*`, `User*`, `CreatedUser*`). The only dependency is `zod` 4.6.4.

### 1.1 Root `.` (`index.ts`): `identifiers.ts` and `problem.ts`

| Symbol | L | Kind | Content |
|---|---|---|---|
| `UUID_PATTERN` | id L8 | regex | `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` |
| `isUuid` | id L10 | fn | `typeof string && UUID_PATTERN.test` |
| `UuidSchema` | id L15 | schema | `z.string().regex(UUID_PATTERN)` |
| `IsoDateTimeSchema` | id L21 | schema | `z.iso.datetime()` |
| `ApiProblemSchema` | pr L11 | S R | `{ error: S R { code: string.min1, message: string, details?: string[] (opt) } }` |
| `ApiProblemDetailSchema` | pr L37 | S R | `{ error: S R { code: min1, detail: string } }`. This is the RBAC and team-route spelling |
| `ApiProblemBareCodeSchema` | pr L56 | S R | `{ error: string.min1, message?: string (opt) }`. Used by `POST /api/runtimes/test` and `GET /api/audit-events` |
| `COMMON_PROBLEM_CODES` | pr L70 | code→status | `unauthenticated 401, forbidden 403, authorisation_undecidable 500, malformed_body 400, invalid_body 400, unsupported_media_type 415, request_body_too_large 413, internal_error 500, service_unavailable 503, upstream_failure 502` |

### 1.2 `./agents` (`agents.ts`)

| Symbol | L | Kind / literal values |
|---|---|---|
| `AGENT_PERMISSION_KEYS` | 10 | `readFiles, writeFiles, runCommands, unrestrictedNetwork` |
| `AgentPermissionsSchema` | 17 | S R. The 4 keys above, all `boolean` |
| `AGENT_NAME_MAX_LENGTH` / `_INSTRUCTIONS_` / `_MODEL_` | 32–34 | 200 / 100 000 / 200 |
| `AGENT_MUTABLE_FIELDS` | 37 | `name, instructions, modelConnectionId, model, runtimeProfileId, permissions` |
| `AgentResourceSchema` | 51 | S R. `id, workspaceId, name` min1; `instructions` string; `modelConnectionId, model, runtimeProfileId` null; `permissions`; `createdBy` min1 null; `ownerPrincipalId` min1; `createdAt, updatedAt` ISO |
| `CreateAgentInput` / `UpdateAgentPatch` | 73/83 | interfaces. `runtimeProfileId?` is opt+null |
| `AgentResourceAssignmentsSchema` | 93 | S R. `files: {fileId, access: enum['read','read-write']}[]`, `skillIds[]`, `connectorIds[]` |
| `AgentGrantsSchema` | 115 | S R. `principalIds: Uuid→lowercase[]`, with a superRefine that requires them to be unique |
| `AgentListResponseSchema` | 140 | `{agents[]}` |
| `AgentResourceAssignmentsResponseSchema` | 147 | `{assignments}` |
| private `parseAgentToolRule` | 174 | Tool-rule grammar. Result kinds: `bare / scoped / mcp-glob / wildcard / invalid`. Regexes: `TOOL_RULE_GLOB_CHARS /[*?]/`, `TOOL_RULE_TOOL_NAME /^[A-Za-z][A-Za-z0-9_]*$/`, `TOOL_RULE_MCP_SERVER_NAME /^[A-Za-z0-9][A-Za-z0-9-]*$/`, prefix `mcp__` |
| `GrantingToolRuleSchema` | 260 | Rejects `invalid` **and** `wildcard` |
| `DenyingToolRuleSchema` | 275 | Rejects `invalid` only |
| `AGENT_TOOL_PERMISSION_MODES` | 281 | `default, acceptEdits, bypassPermissions, plan, dontAsk, auto` |
| `AgentToolPermissionModeSchema` | 290 | enum |
| `AgentToolPolicySchema` | 301 | S R. `base: 'claude_code_preset' \| GrantingRule[]`, `autoApprove: Granting[]`, `deny: Denying[]`, `permissionMode`, `allowDangerouslySkipPermissions: bool .default(false)`. Cross-field rule: `bypassPermissions ⇔ allowDangerouslySkipPermissions` |
| `AgentSkillPolicySchema` | 343 | **DU on `mode`**: `{mode:'all'}` \| `{mode:'allowlist', names: SKILL_NAME_PATTERN[]}` |
| `AgentPolicyLimitsSchema` | 359 | `maxTurns: int>0 null`, `maxBudgetUsd: >0 finite null` |
| `AgentPolicySchema` | 390 | **DU on `provider`**, one arm: `'claude-agent-sdk'` with `{tools, skills, limits}` |
| `AgentPolicyResponseSchema` | 404 | `{policy}` |
| `AGENT_POLICY_PROBLEM_CODES` | 411 | `invalid_policy 400, unsupported_policy_provider 400, dangerous_permission_mode_refused 400, agent_not_found 404, skill_not_assigned 409, agent_policy_not_configured 503` |
| `CreateAgentWithAssignmentsResponseSchema` | 434 | `{agent, assignments}` |

⚠ The Zod `AgentToolPolicySchema` **accepts** `bypassPermissions` when the flag is set. The refusal (`dangerous_permission_mode_refused`) lives in the route, not in the schema. This is a good T1/T3 split.

### 1.3 `./api-keys` (`api-keys.ts`)

| Symbol | L | Content |
|---|---|---|
| `API_KEY_NAME_MAX_LENGTH` | 7 | 120 |
| `API_KEY_PREFIX` | 10 | `'ak_live_'` |
| `API_KEY_ID_LENGTH` / `_SECRET_LENGTH` | 13/14 | 22 / 43 |
| `API_KEY_DISPLAY_PREFIX_PATTERN` | 20 | `/^ak_live_[A-Za-z0-9_-]{22}$/u` |
| `API_KEY_PATTERN` | 29 | `/^ak_live_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u` |
| `ApiKeyResourceSchema` | 44 | S R. `id, name` min1; `role: MEMBERSHIP_ROLES`; `keyPrefix` (display pattern); `lastUsedAt, expiresAt, revokedAt` ISO null; `createdAt`. There is no secret or hash field, and no `workspaceId` or `principalId` |
| `ApiKeyListResponseSchema` / `ApiKeyResponseSchema` | 61/72 | `{apiKeys[]}` / `{apiKey}` |
| `MintedApiKeyResponseSchema` | 82 | `{apiKey, key: API_KEY_PATTERN, warning: min1}` |
| `CreateApiKeyInput` | 100 | `{name, role, expiresAt?: string\|null}` |

### 1.4 `./connectors` (`connectors.ts`)

| Symbol | L | Content |
|---|---|---|
| `CONNECTOR_TRANSPORTS` | 9 | `stdio, http, sse` |
| `CONNECTOR_AUTH_TYPES` | 13 | `none, api-key, bearer, oauth` |
| `CONNECTOR_NAME_MAX_LENGTH` | 22 | 200 code points (the route matches `/^.{1,200}$/u`) |
| `CONNECTOR_REQUEST_BODY_MAX_BYTES` | 28 | 65 536 |
| `ConnectorResourceSchema` | 39 | S R. `id, workspaceId, name`; `transport`; `command` null; `args: string[] null`; `url` null; `authType`; `hasCredential, enabled: bool`; `createdBy` null; `ownerPrincipalId`; timestamps |
| `ConnectorListResponseSchema` | 64 | `{connectors[]}` |
| `TEST_CONNECTION_FAILURE_KINDS` | 76 | `auth-required, credential-rejected, credential-insufficient-scope, unreachable, endpoint-not-mcp, tls-error, command-not-found, process-died, timeout, protocol-version-unsupported, server-error, rate-limited, http-error, server-refused, sse-stream-failed, unknown-failure, stdio-probe-unavailable` (17) |
| `TestConnectionOutcomeSchema` | 103 | **DU on `ok`**: `true` → `{kind:'ok', message, serverName null, serverVersion null, toolCount int≥0}`; `false` → `{kind: failure enum, message}` |
| `CreateStdioConnectorInput` / `CreateRemoteConnectorInput` / `CreateConnectorInput` | 138/146/158 | Discriminated by `transport` at type level only |
| `RotateConnectorCredentialInput` | 165 | `{credential}` |

### 1.5 `./files` (`files.ts`)

| Symbol | L | Content |
|---|---|---|
| `RESOURCE_PATH_ENCODING_HEADER` / `_PERCENT_UTF8` | 5/6 | `'x-resource-path-encoding'` / `'percent-utf8'` |
| `resourcePathHeaders(name, path)` | 18 | `{[name]: encodeURIComponent(path), [ENC]: 'percent-utf8'}` |
| `decodeResourcePathHeader(value, encoding)` | 29 | `encoding null` → raw passthrough (legacy); other encoding → `unsupported_path_encoding`; `decodeURIComponent` throws → `invalid_path_encoding` |
| `fileRouteId(path)` | 55 | UTF-8 → base64url with no padding, hand-rolled (alphabet L45) |
| `FILE_KINDS` | 71 | `file, folder` |
| `MAX_UPLOAD_BYTES` / `MAX_SUBTREE_OBJECTS` | 78/84 | 64 MiB / 500 |
| `FILES_PROBLEM_CODES` | 91 | `invalid_path 400, reserved_path 400, missing_file_path 400, unsupported_path_encoding 400, invalid_path_encoding 400, file_not_found 404, name_conflict 409, self_descendant 409, folder_not_empty 409, subtree_too_large 413, store_inconsistent 500, rename_inconsistent 500, files_runtime_not_configured 503` |
| `FileResourceSchema` | 119 | S R. `id, path` min1; `kind`; `sizeBytes` int≥0 null; `contentType` null; `lastModified` ISO null |
| `FileResponseSchema` / `FileListResponseSchema` | 138/143 | `{file}` / `{files[]}` |
| `SubtreeMoveOutcomeSchema` | 161 | **DU on `status`**: `ok{moved}` \| `partial{moved,total,remaining?: opt}` |
| `MoveFileResponseSchema` | 182 | plain `z.union([FileResponse, SubtreeMoveOutcome])` |
| `SubtreeDeleteOutcomeSchema` | 192 | **DU on `status`**: `ok{deleted[]}` \| `partial{deleted[], remaining[]}` |
| `RemoveFileResponseSchema` | 212 | `SubtreeDeleteOutcome.nullable()` (`null` ⇔ 204) |

### 1.6 `./invitations` (`invitations.ts`). Not readonly.

| Symbol | L | Content |
|---|---|---|
| `INVITATION_TOKEN_MAX_LENGTH` | 7 | 4096 |
| `InvitationResourceSchema` | 22 | S. `id, email` min1; `role`; `invitedBy` min1 null; `expiresAt` ISO; `acceptedAt, revokedAt` ISO null; `createdAt`. No state field and no token or hash. The state is *derived* |
| `InvitationListResponseSchema` / `InvitationResponseSchema` | 38/49 | `{invitations[]}` / `{invitation}` |
| `IssuedInvitationResponseSchema` | 62 | `{invitation, token, link, warning}` (all min1) |
| `AcceptedInvitationResponseSchema` | 79 | `{workspaceId, membership: MembershipResource}` |

### 1.7 `./models` (`models.ts`)

| Symbol | L | Content |
|---|---|---|
| `MODEL_CONNECTION_CONFIG_FIELDS` | 7 | `baseUrl, deployment, apiVersion` |
| `MODEL_PROVIDER_CONFIG_RULES` | 23 | `anthropic`, `anthropic-compatible`, `openai`: allowed `[baseUrl]`, required `[]`. `openai-compatible`: allowed and required `[baseUrl]`. `azure-openai`: allowed and required `[baseUrl, apiVersion, deployment]` |
| `ModelConnectionConfigSchema` | 36 | S R. `baseUrl?: z.url()`, `deployment?`, `apiVersion?` (all opt) |
| `ModelConnectionResourceSchema` | 56 | S R. `id, name, provider, config, hasCredential, ready, createdAt, updatedAt`. **No `workspaceId`** |
| `ModelConnectionListResponseSchema` | 77 | `{models[]}`. The wire key is `models` |
| `DeleteModelConnectionResponseSchema` | 89 | `{deleted: literal true, referencedBy: {agentId, agentName}[]}` |
| `ModelConnectionTestOutcomeSchema` | 121 | **DU on `ok`**: `true` → `status: int`; `false` → `status: int null`; both carry `latencyMs, message` |
| `DISCOVERED_MODEL_CAPABILITY_KEYS` | 135 | `streaming, toolUse, thinking, promptCaching, structuredOutput, contextManagement, webSearch, tokenCounting` |
| `DiscoveredModelCapabilitiesSchema` / `DiscoveredModelSchema` / `UnavailableModelConnectionSchema` / `DiscoveredModelsResponseSchema` | 146/166/180/195 | `unavailable?` is opt |

### 1.8 `./observability` (`observability.ts`)

| Symbol | L | Content |
|---|---|---|
| `RunTelemetrySchema` | 16 | S R. `runId, workspaceId, agentId, status: RUN_STATUSES, durationMs int≥0 null, costUsd: number null`. This is the only money field carried as a JSON number |
| `RunTelemetryListResponseSchema` | 31 | `{runs[]}` |
| `AUDIT_ACTIONS` | 43 | `user-created, user-deleted, agent-changed, provider-credential-changed, api-key-created, api-key-revoked, connector-changed, permission-changed, runtime-profile-changed, project-created, project-deleted, project-archived, project-restored, session-published, public-link-revoked, runnable-link-stopped, public-sharing-policy-changed, invitation-created, invitation-resent, invitation-revoked, invitation-accepted` (21) |
| `AuditEventSchema` | 78 | `actorUserId, actorPrincipalId, subjectId` null; `actorLabel, subjectLabel` min1 |
| `AuditEventListResponseSchema` | 96 | `{events[], nextCursor: min1 null}` (S-5) |
| `AUDIT_LIST_DEFAULT_LIMIT` / `_MAX_LIMIT` | 108/109 | 100 / 500. `cursor` pages by `(created_at, id)` (S-5, ADR-0079) |

### 1.9 `./projects` (`projects.ts`). Resource and list are not readonly.

| Symbol | L | Content |
|---|---|---|
| `PROJECT_VISIBILITIES` | 5 | `private, workspace, public` |
| `ProjectResourceSchema` | 13 | S. `instructions, defaultAgentId, defaultModelConnectionId, defaultModel` null; `visibility`; `createdBy` null; `ownerPrincipalId`; `archivedAt` ISO null; `fileIds, mcpServerIds: string[]` |
| `PROJECT_LIST_FILTERS` | 63 | `active, archived, all` (default `active`) |
| `ProjectListResponseSchema` | 67 | `{projects[]}` |
| `ProjectSessionResponseSchema` / `ProjectSessionMoveResponseSchema` | 77/93 | `{id, projectId, agentId}` / `{projectId, sessionId}` |

### 1.10 `./run-events` (`run-events.ts`)

| Symbol | L | Content |
|---|---|---|
| `CONTROL_FRAME_NAMES` | 27 | `done, run-failed, stream-reset` ⚠ The server's list also contains `error` (see §6.1) |
| `RUN_STATUS_EVENT` | 31 | `'run.status'` |
| `RELAYED_EVENT_NAMES` | 38 | `system, system-unknown, result, result-unknown, sdk-event, unknown, malformed` |
| `EVENT_NAME_PATTERN` | 50 | `/^[A-Za-z][A-Za-z0-9._-]{0,63}$/` |
| `RunStatusEventDataSchema` | 53 | `{status: RUN_STATUSES, error: string null}` |
| `RunFailedFrameDataSchema` | 69 | `{status: RUN_STATUSES \| 'unknown', message}` |
| `StreamResetFrameDataSchema` | 80 | `{reason, resumedAfter: string null}` |
| `RelayedEventDataSchema` | 96 | `z.looseObject({kind: min1}).readonly()`. This is the only loose object |

### 1.11 `./runs` (`runs.ts`)

| Symbol | L | Content |
|---|---|---|
| `RUN_STATUSES` | 9 | `queued, running, completed, failed, cancelled` |
| `TERMINAL_RUN_STATUSES` / `isTerminalRunStatus` | 12/15 | `completed, failed, cancelled` |
| `MODEL_PROVIDERS` | 20 | `anthropic, anthropic-compatible, openai, azure-openai, openai-compatible` |
| `ACCOUNTING_STATES` | 30 | `pending, complete, partial, failed, unavailable` |
| `MAX_PROMPT_CHARS` | 40 | 100 000 |
| `RunUsageSchema` | 42 | 6 int≥0 counters: `input, output, cacheRead, cacheCreation, totalTokens` (derived as the sum of the four), `toolCalls` |
| `RunCostSchema` | 57 | `amount` (decimal string), `currency`, `priceTableVersion` null |
| `RunResourceSchema` | 74 | S R. `projectId, initiatingUserId, startedAt, endedAt, durationMs, model, provider, modelConnectionId, error, accountingError` null; `status`; `usage`; `cost`; `accountingState` |
| `StartRunRequestSchema` | 111 | S R. `prompt` (≤100 000, trim non-empty); `sessionId, modelConnectionId: Uuid opt+null`; `model: min1 opt+null`. Refine: `(connection≠null) ⇔ (model≠null)` |
| `StartRunResponseSchema` | 135 | `{run, events: min1}` (202) |
| `RunResponseSchema` / `InterruptRunResponseSchema` | 147/154 | `{run}` |
| `RevokeRunTokensResponseSchema` | 165 | `{revoked int≥0, outcome: enum['revoked','already-revoked','not-found']}` |
| `RUN_LIST_DEFAULT_LIMIT` / `_MAX_LIMIT` | 176/177 | 20 / 200 |
| `RunListResponseSchema` | 180 | `{runs[], nextCursor: min1 null}`. Cursor-paged, as are the session and audit lists since S-5 |
| `RunListQuery` / `runListSearchParams` | 196/210 | 10 optional filters, which omit absent keys |

### 1.12 `./runtimes` (`runtimes.ts`)

| Symbol | L | Content |
|---|---|---|
| `RUNTIME_DRIVERS` | 10 | `local, sandbox-runtime, docker, kubernetes, gke-agent-sandbox, aca-sessions, aws-agentcore, aws-ecs, cloud-run-sandbox, cloud-run-service, external` |
| `RUNTIME_NETWORK_POLICIES` | 30 | `none, restricted, open` |
| `RUNTIME_FILESYSTEM_MODES` | 34 | `read-only, read-write` |
| `RUNTIME_PROFILE_BOUNDS` | 43 | `cpu > 0`; `memoryMb, diskMb, timeoutSeconds, idleTimeoutSeconds` ∈ [1, MAX_SAFE_INTEGER] |
| `RuntimeProfileResourceSchema` | 64 | S R. Every sizing field null; `allowedDomains, persistPaths` null; `driverConfig: record null` |
| `RuntimeProfileListResponseSchema` | 91 | `{runtimeProfiles[]}` |
| `RuntimeConnectionResourceSchema` / `…ListResponseSchema` | 144/157 | `{id, name, driver, createdAt}`. The endpoint and credential are write-only |

### 1.13 `./secrets` (`secrets.ts`)

| Symbol | L | Content |
|---|---|---|
| `SECRET_NAME_PATTERN` | 10 | `/^[A-Z][A-Z0-9_]{0,127}$/` |
| `SECRET_NAME_MAX_LENGTH` / `SECRET_VALUE_MAX_LENGTH` | 11/17 | 128 / 65 536 |
| `SecretResourceSchema` | 28 | `{id, name (pattern), algorithm, masterKeyId, createdAt, updatedAt}`. There is no value field |
| `SecretListResponseSchema` | 43 | `{secrets[]}` |

### 1.14 `./sessions` (`sessions.ts`)

| Symbol | L | Content |
|---|---|---|
| `SESSION_STATUSES` | 5 | `active, archived` |
| `SessionResourceSchema` | 16 | `userId, projectId, claudeSessionId, title` null; `status`; `resumable: bool` (derived) |
| `SessionResponseSchema` / `SessionListResponseSchema` | 38/47 | `{session}` / `{sessions[], projectKey: min1, nextCursor: min1 null}` (S-5) |
| `PROJECT_KEY_PATTERN` | 71 | `/^[A-Za-z0-9_-]{1,64}$/` |
| `TRANSCRIPT_SUBPATH_PATTERN` / `_MAX_LENGTH` | 78/80 | `/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/`, 128 |
| `TranscriptEntrySchema` | 93 | `z.unknown()` |
| `TranscriptResponseSchema` / `TranscriptSubkeysResponseSchema` | 102/114 | `{entries[]}` / `{subkeys: subkey[]}` |
| `transcriptSearchParams` | 132 | `projectKey?`, `subpath?` |

### 1.15 `./shares` (`shares.ts`)

| Symbol | L | Content |
|---|---|---|
| `SHARE_SUBJECT_TYPES` | 6 | `agent, session, project, skill` |
| `SHARE_VISIBILITIES` | 13 | `private, workspace, public` |
| `SHARE_MODES` | 21 | `definition, runnable` (the server refuses `runnable` today) |
| `SHARE_EXPIRIES` | 25 | `'24 h', '7 days', '30 days', 'never'` |
| `SHARE_PASSPHRASE_MAX_LENGTH` | 29 | 1024 |
| `SHARES_PROBLEM_CODES` | 35 | `invalid_share 400, share_not_found 404, shares_runtime_not_configured 503` |
| `ShareIncludeSchema` | 51 | `{technicalDetails?, outputFiles?}` (opt) |
| `ShareResourceSchema` / `ShareListItemSchema` | 99/108 | `mode` null; `snapshot: unknown`; `budgetCapUsd` decimal null; `spentUsd`; `stopped`; `expiresAt, revokedAt, suspendedAt` null; `url?: startsWith('/p/')` (opt). **Refine `PUBLIC_URL_INVARIANT`: `url` is present ⇔ `visibility === 'public'`**. The list item adds `viewCount` |
| `ShareListResponseSchema` | 120 | `{shares[]}` |
| `PublishShareCommand` | 138 | interface |

### 1.16 `./skills` (`skills.ts`)

| Symbol | L | Content |
|---|---|---|
| `SKILL_NAME_PATTERN` / `_MAX_LENGTH` | 12/13 | `/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`, 64 |
| `SKILL_MD_FILENAME` | 16 | `'SKILL.md'` |
| `SKILL_FILE_PATH_MAX_BYTES` / `MAX_SKILL_REQUEST_BODY_BYTES` | 24/31 | 4096 / 16 MiB |
| `SKILL_FILE_BASE64_PATTERN` | 39 | `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==\|[A-Za-z0-9+/]{3}=)?$/` |
| `SKILLS_PROBLEM_CODES` | 47 | `missing_name, invalid_name, missing_files, malformed_file_entry, inadmissible_path, duplicate_path, missing_skill_md, malformed_content, invalid_path, empty_patch, cannot_remove_skill_md` → 400; `skill_not_found 404`; `skill_already_exists, colliding_paths, skill_md_removal_rejected` → 409; `store_inconsistent 500`; `skills_runtime_not_configured 503` |
| `SkillSummarySchema` / `SkillFileStatSchema` / `SkillDetailSchema` / `SkillFileSchema` / `SkillListResponseSchema` / `SkillResponseSchema` / `SkillExportSchema` / `SkillExportResponseSchema` | 113–195 | In the detail, `source, instructions, allowedTools` are null |

### 1.17 `./team` (`team.ts`). Not readonly.

| Symbol | L | Content |
|---|---|---|
| `MEMBERSHIP_ROLES` | 13 | `owner, admin, builder, viewer` |
| `USER_EMAIL_MAX_LENGTH` / `USER_NAME_MAX_LENGTH` | 19/20 | 320 / 200 |
| `PRINCIPAL_KINDS` | 33 | `membership, api-key`. ⚠ The server spells the second one `api_key` (§4) |
| `MeResponseSchema` | 50 | `{principalId, kind, role, workspaceId, userId: min1 null, label}` |
| `MembershipResourceSchema` | 73 | `{id, principalId: Uuid, userId, email, name, role, createdAt}` |
| `MembershipListResponseSchema` / `MembershipResponseSchema` / `UserResourceSchema` / `UserListResponseSchema` / `CreatedUserResponseSchema` | 88–123 | — |

### 1.18 `./tokens` (`tokens.ts`)

| Symbol | L | Content |
|---|---|---|
| `BROWSER_TOKEN_PREFIX` | 11 | `'awt_live_'` |
| `BROWSER_TOKEN_ID_LENGTH` / `_SECRET_LENGTH` | 14/15 | 22 / 43 |
| `BROWSER_TOKEN_PATTERN` | 21 | `/^awt_live_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u` |
| `TOKEN_SCOPE_KINDS` | 27 | `run, session` |
| `TokenScopeSchema` | 37 | `{kind, id: Uuid}` |
| `BROWSER_TOKEN_MIN/MAX/DEFAULT_TTL_SECONDS` | 48–50 | 60 / 3600 / 300 |
| `MintTokenRequestSchema` | 53 | `{scope, ttlSeconds?: int in [60,3600]}` (opt) |
| `MintTokenResponseSchema` | 73 | `{token (pattern), scope, expiresAt, warning}` |

### 1.19 `./workspaces` (`workspaces.ts`)

| Symbol | L | Content |
|---|---|---|
| `WorkspaceResourceSchema` | 18 | `{id, slug, name, publicSharingEnabled, archivedAt null, createdAt, updatedAt}` |
| `WorkspaceMembershipViewSchema` | 26 | The resource plus `role` |
| `WorkspaceListResponseSchema` / `WorkspaceMembershipResponseSchema` / `WorkspaceResponseSchema` | 34/42/48 | — |
| `WORKSPACE_NAME_MAX_LENGTH` / `_SLUG_MAX_LENGTH` | 54/55 | 200 / 64 |
| `WorkspaceSwitchRequestSchema` / `WorkspaceSwitchResponseSchema` | 74/86 | `{workspace: min1}` / `{workspace: view}` |
| `SharingPolicySchema` | 99 | `{publicSharing: bool}` |
| `UpdateWorkspacePatch` | 64 | `{name?, archived?}` |

### 1.20 Discriminated unions (complete list)

`AgentSkillPolicySchema` (mode), `AgentPolicySchema` (provider), `TestConnectionOutcomeSchema` (ok), `ModelConnectionTestOutcomeSchema` (ok), `SubtreeMoveOutcomeSchema` (status), `SubtreeDeleteOutcomeSchema` (status). The following are plain unions: `MoveFileResponseSchema`, `RunFailedFrameData.status`, `AgentToolPolicy.base`.

---

## 2. State machines

| Machine | States | Transitions and guards | Source |
|---|---|---|---|
| **Run status** | `queued, running, completed, failed, cancelled`; terminal = last 3 | **create** → `queued` (`CreateRunOutcome`: `created \| duplicate-id \| unknown-session`). **markRunning**: `queued → running` only, stamps `started_at`; otherwise `no-op` or `not-found` (`RunTransitionOutcome` `moved\|no-op\|not-found`). **finish(s)**: throws if `s` is not terminal; allowed from any non-terminal status (`notInArray(status, terminal)`). "First call wins": an already-terminal run gives `no-op`. It stamps `ended_at`, sets `started_at = coalesce(started_at, now())`, and **revokes every `run_tokens` row in the same transaction** under `pg_advisory_xact_lock(hash(runId))` | `packages/core/src/db/repositories/runs.ts` L677 (`markRunning`), L696 (`finish`), L139 |
| Run status (port) | same | `RunStore.markRunning` returns `boolean` ("did *this* call move it"), and `finish` returns `void`. `InMemoryRunStore` mirrors this at L604/L612 | `apps/web/server/runs/store.ts` L272–L290 |
| Run status DB invariant | — | `runs_ended_at_iff_terminal`: `(status ∈ terminal) = (ended_at IS NOT NULL)`. `runs_ended_after_started` | `packages/core/src/db/schema/runs.ts` |
| Interrupt | non-terminal → `cancelled` | Route `POST /api/runs/:id/interrupt`: non-UUID → 400 `invalid_run_id`; not visible → **404 `run_not_found`**; `decide` with `run`, own/other; already terminal → **409 `run_not_interruptible`**. Otherwise `appendPlatformEvent(run.status)`, `finish(cancelled)`, revoke run tokens **and** browser tokens *before* the best-effort runtime signal; the response re-reads the run | `apps/web/server/runs/api.ts` L849; `composition/register.ts` ~L812–850; `runs/interrupt.ts`; ADR `SDK-03-RUN-235-*` |
| Run event log | append-only per run, `sequence` 1,2,… | `append` takes the same advisory lock and **refuses once the run is terminal** (returns `null`). The next sequence is `max+1`. Retention deletes `sequence ≤ next − maxEvents` (`DEFAULT_MAX_EVENTS_PER_RUN = 50 000`). The relay path (`append`) refuses reserved names; `appendPlatformEvent` accepts only `run.status` | `repositories/runs.ts` L314–L380; `runs/store.ts` L300–L334 |
| Accounting | `pending, complete, partial, failed, unavailable` | `recordUsage` recomputes the state from the ledger (`recorded \| duplicate \| not-found \| price-version-conflict`). `markAccountingFailed` applies **only while `pending`**. DB checks: `runs_price_version_matches_accounting_state` (`complete\|partial ⇔ price_table_version NOT NULL`) and `runs_unpriced_cost_zero` | `repositories/runs.ts` L144–L165, L765, L973 |
| **Invitation** | derived: `revoked > accepted > expired > pending` (precedence) | create gives `created \| already-invited` (partial unique index on pending `(workspace,email)`). resend: `resent \| no-such-invitation \| already-accepted \| revoked`. revoke: `revoked \| already-revoked \| no-such-invitation \| already-accepted`. accept: one query matches id+hash+email+`workspace.archived_at IS NULL`; no row → `invalid`; then `revoked`, then `already-accepted`, then `expiresAt ≤ now` → `expired`; else `accepted \| already-member`. DB: `invitations_not_accepted_and_revoked`, `*_after_created`, `expires_after_created` | `packages/core/src/db/repositories/directory.ts` L150–L180, L928; `apps/web/server/rbac/directory.ts` L209–L257; `packages/core/src/db/schema/invitations.ts` L80–L115; **UI-only state function** `invitationStateOf` in `apps/web/components/team/invitations-model.ts` L79; ADR `W9-TEAM-121-invitation-lifecycle-is-a-durable-state-machine.md`. ⚠ There is no server-side state function |
| **Principal** | `active` (`revoked_at IS NULL`) → `revoked` | Created with a membership (`kind='membership'`) or an API key (`kind='api_key'`). `workspace_principals_source_xor`. `revoked_at ≥ activated_at`. Revoking an API key sets `api_keys.revoked_at` **and** `workspace_principals.revoked_at` in one transaction (the principal update must hit exactly one row, or it throws). Deleting a membership **cascades** its principal row away (it is deleted, not revoked). `deleteMembership`: `last-owner` guard (advisory lock plus a count); FK `projects_owner_principal_workspace_fk` → `membership-in-use` (`projects`); FK `workspace_principals_acts_for_workspace_fk` → `membership-in-use` (`local-runtime-keys`, issue #509) | `schema/workspace-principals.ts`; `repositories/directory.ts` L505–L630 |
| **Membership role** | 4 roles | `changeMembershipRole` → `changed \| no-such-membership \| last-owner`. Every role written must be a `ConferredRole` (branded) from `conferRole` | `rbac/directory.ts` L130; `rbac/conferral.ts` |
| **API key** | `active` → `revoked`; expiry is time-based | create → `created \| name-taken \| expiry-in-the-past`. revoke → `revoked \| no-such-key \| already-revoked` (idempotent 200, never 204). DB checks: `api_keys_expires_after_created`, `api_keys_revoked_after_created`; `api_keys_key_hash_key` is globally unique | `rbac/directory.ts` L159–L168; `schema/api-keys.ts` |
| **Browser token** | `active` → `revoked`/`expired` | Minted by a session or API-key principal (a browser token cannot mint: `tokens` is in no scope grammar). Scope is `run` xor `session` (`browser_tokens_scope_xor`). TTL 60–3600 s. `revokeForRun`/`revokeForSession`; `findActiveByHash(now)`. The minter is **re-resolved on every request** (`Principal.fromBrowserToken`) | `packages/core/src/db/repositories/browser-tokens.ts` L25–L130; `schema/browser-tokens.ts`; `rbac/browser-token.ts`; `rbac/principal.ts` L270 |
| Run (gateway) token | active → revoked/expired | HMAC claims `{version:1, tokenId, runId, sessionId, workspaceId, agentId, modelConnectionId, issuedAt, expiresAt>issuedAt}`, default TTL 300 s. The DB `run_tokens` row supports revoke/isActive. `finish` revokes all | `packages/gateway/src/tokens/run-token.ts` L5–L80; `repositories/run-tokens.ts` |
| **Project archive** | `active` (`archived_at` null) ⇄ `archived` | `archive`: `archived_at = coalesce(archived_at, now())` (idempotent, keeps the first stamp). `restore`: `archived_at = null`. Both are routes under `projects/:id/{archive,restore}` (write) | `repositories/projects.ts` L98–L108, L267–L290 |
| **Workspace archive** | same | `archive`/`restore` are idempotent (L226/L236). `isWorkspaceArchived` L248. Archive is via `PATCH /api/workspaces/:id {archived}` | `repositories/workspaces.ts` |
| Archive gates | — | `isWorkspaceUsableForRuns(ws) = ws≠null ∧ archivedAt=null`; `guardSessionCreation` → `unknown-principal`. `isProjectUsableForNewWork`; `ProjectRunGate.isUsableForNewWork(null)=true`; `guardProjectSessionCreation`. Invitation acceptance filters archived workspaces into `invalid` | `apps/web/server/workspaces/run-gate.ts` L42–L95; `apps/web/server/projects/archive-gate.ts` L33–L86 |
| **Share** | `live`, `revoked`, `suspended`, `stopped`, `expired` (derived) | `revoke(id)`: sets `revoked_at` where it is null. `setSuspended(b)` and `setPublicSharingEnabled(false)` stamp `suspended_at` on **every non-revoked share** of the workspace, and `true` clears it. `stop(id)` sets `stopped` once. `reserveVisitorMessage` → `reserved \| rate-limited \| budget-exhausted{stoppedNow} \| unavailable` (unavailable if revoked, suspended, stopped or no budget). `linkRun` → `linked \| existing \| unavailable`. DB checks: `shares_agent_mode_only`, `shares_budget_nonnegative`, `shares_spend_nonnegative` | `packages/core/src/db/repositories/shares.ts` L30–L300; `schema/shares.ts` |
| **Session status** | `active` ⇄ `archived` | `archive` and `restore` are unconditional updates. `resumable` is derived (active and `claudeSessionId` known). `ensure` is wrapped by both archive gates. Moving a session into a project is refused once it has runs (`409 project_session_has_runs`) | `repositories/runs.ts` L1146–L1230; `contracts/sessions.ts` |
| SSE stream (per connection) | replay → live → end | Frames end with `done` (success), with `run-failed{status,message}` **followed by** `done` (terminal failure), or with `run-failed{status:'unknown'}` and **no** `done` (the producer threw). `classifyRunOutcome` maps `completed` → succeeded, `failed`/`cancelled` → failed, `queued`/`running`/`null` → indeterminate | `apps/web/server/runs/api.ts` L880–L930; `runs/sse.ts` L90–L110 |

---

## 3. Decision tables

### 3.1 RBAC core (`apps/web/server/rbac/`)

**`RESOURCES` (verbatim, `resources.ts` L2, 25 entries, re-exported by `permissions.ts` L38):**
`agents, api-keys, audit-events, connectors, files, invitations, me, memberships, metrics, model-connections, models, projects, runs, runtime-connections, runtime-profiles, runtimes, secrets, sessions, shares, sharing-policies, skills, setup, tokens, users, workspaces`

**`SUB_RESOURCES`** is `composeSubResources(SPEC_34_SUB_RESOURCES, DECLARED_SUB_RESOURCES)` (`permissions.ts` L127, `declared-sub-resources.ts` L122). A duplicate pair **throws**.

| Resource | Sub-segments (composed) | Source |
|---|---|---|
| agents | `runs` (§34), `policy`, `grants`, `resources` | permissions L80; SDK-02-AGENT-POLICY-234; SDK-05-AUTH-237; W1-CP-05 |
| runs | `events` (§34), `interrupt`, `revoke-tokens` | L101; SDK-03-RUN-CONTROL-235 |
| sessions | `messages` (§34), `transcript`, `subkeys` | L108; W2-CP-07 |
| connectors | `test-connection` | W2-CP-05 |
| model-connections | `test`, `credential` | W4-CP-08; W9-PROV-126 |
| projects | `sessions`, `archive`, `restore` | W5-CP-02; W9-PROJ-183 |
| invitations | `resend`. `accept` is deliberately **not** declared | W9-TEAM-121 |
| all 18 others | `[]` | — |

**Grant values** (`Grant`, L149): `none | own | permitted | any`. **Operation** (L146): `read | write | run`.
**Ownership** (`decide.ts` L74, `OWNERSHIPS` L77): `own, other, unknown, not-applicable, permitted`.
**Methods** (`METHODS` L80): `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`.

**Path grammar** (`parsePath` L146, private): split on `/`, then `['', 'api', <resource>, ...rest]`.
- The first test is `classifyPath` (`apps/web/server/auth/paths.ts` L109, `Surface = 'api'|'public'|'page'`). `public` (`/p/…`) → **allow** with `facts: null`. `page` → **refuse**.
- A resource outside `RESOURCES` → refuse. `rest.length`: 0 means the collection, 1 means `:id`, 2 means `:id/<sub>` and requires `sub ∈ SUB_RESOURCES[resource]` (else refuse). A length above 2 → refuse.

**Method→operation** (`parseOperation` L205, private): `POST` with sub ∈ {`runs`,`messages`,`interrupt`} → `run`. `GET`/`HEAD` → `read`. `POST`/`PUT`/`PATCH`/`DELETE` → `write`. `OPTIONS` → refuse. Any other string → refuse.

**`applyGrant`** (L246, private):

| grant \ ownership | own | other | unknown | not-applicable | permitted |
|---|---|---|---|---|---|
| any | allow | allow | allow | allow | allow |
| own | allow | deny | deny | **allow** | deny |
| permitted | deny | deny | deny | deny | **allow** |
| none | deny | deny | deny | deny | deny |

**`decide(query)`** (L390): `parseRole` (null → refuse) → `classifyPath` → `parsePath` → `parseOperation` → *if `scope≠null`*, `checkTokenScope` → `grantsFor(role,resource)[op]` → `applyGrant`. `Decision = allow{because,facts} | deny{because,facts,code?} | refuse{because}` (L119). Refuse is rendered as `500 authorisation_undecidable`. Deny defaults to `forbidden`.

**`TOKEN_SCOPE_GRAMMAR`** (L317): `run → [(runs, read)]`; `session → [(runs, read), (agents, run)]`. `checkTokenScope` (L337) returns **deny with `code: 'token_out_of_scope'`** (not refuse) when the (resource, op) cell is not in the grammar, or for `runs`+`read` with no `:id` (the list), or when a `run` scope's `:id ≠ scope.id`. Otherwise it returns `null`, and the role table still applies (narrowing only). The session-scope row identity is checked in `runs/api.ts`, not here.

**Role table** (`POLICY` L216; `grantsFor` L371; `everyGrant` L385). Each cell is `read/write/run`, and a dash means `none/none/none`. Named bundles: `EVERYTHING = any/any/any`, `MANAGE = any/any/none`, `OWN_WRITES = any/own/own`, `OWN_ONLY = own/own/none`, `OWN_READS = own/none/none`, `READ_ONLY = any/none/none`, `WORKSPACE_MEMBER_SCOPED = own/own/none`.

| resource | owner (fallback EVERYTHING) | admin | builder | viewer |
|---|---|---|---|---|
| agents | any/any/any | any/any/any | any/own/own | any/none/**permitted** |
| api-keys | any/any/any | any/any/none | – | – |
| audit-events | any/any/any | – | – | – |
| connectors | any/any/any | any/any/none | any/own/own | – |
| files | any/any/any | any/any/any (ADR-0116) | any/own/own | – |
| invitations | any/any/any | any/any/none | – | – |
| me | any/any/any | any/none/none | any/none/none | any/none/none |
| memberships | any/any/any | any/any/none | – | – |
| metrics | any/any/any | any/none/none | any/none/none | any/none/none |
| model-connections | any/any/any | any/any/none | – | – |
| models | any/any/any | any/any/none | – | – |
| projects | any/any/any | **–** | own/own/none | – |
| runs | any/any/any | any/none/any | own/none/own | own/none/own |
| runtime-connections | any/any/any | any/any/none | – | – |
| runtime-profiles | any/any/any | any/any/none | – | – |
| runtimes | any/any/any | any/any/none | – | – |
| secrets | any/any/any | – | – | – |
| sessions | any/any/any | own/own/none | own/own/none | own/none/none |
| setup | any/any/any | – | – | – |
| shares | any/any/any | any/any/none | own/own/none | own/own/none |
| sharing-policies | any/any/any | any/none/none | any/none/none | any/none/none |
| skills | any/any/any | any/any/any (ADR-0116) | any/own/own | – |
| tokens | any/any/any | none/any/none | none/own/none | – |
| users | any/any/any | any/any/none | – | – |
| workspaces | **own/own/none** (override) | own/own/none | own/own/none | own/own/none |

⚠ Non-monotone (T5 target): Admin has `none` on `projects` and no `run` on `connectors` while Builder has grants there (ADR-0116 closed `files` and `skills`). ⚠ `POST /api/runs/:id/revoke-tokens` parses as a `write` on `runs`, which only Owner holds, while the route comment says Admin revokes via its own role check in `runs/api.ts`. Reconcile in Phase 3. ⚠ Admin `sessions` is `own` in the table, but `composition/session-rbac.ts#canAccessSession` admits any Admin (see the comment in `permissions.ts` L272–L279).

**Roles** (`roles.ts`): `ROLES` L31 = `owner, admin, builder, viewer`; `parseRole` L41 returns `Role|null` and never downgrades; `requireRole` L48 throws.

**Conferral** (`conferral.ts`): `Domination = 'dominates'|'does-not'|'undecidable'` (L75). `dominates(held, conferred)` (L83) applies these rules in order:

1. `held=any` → dominates.
2. `conferred=none` → dominates.
3. `held=conferred` → dominates.
4. Either side is `permitted` → undecidable.
5. `held ∈ {none, own}` → does-not.

`conferRole(caller, requested)` (L134) walks `RESOURCES × [read,write,run]` in order and stops at the first cell that does not dominate: `does-not` → **deny** with a witness, `undecidable` → **refuse** with a witness. An unparseable role on either side → refuse with a null witness. `ConferredRole` is branded (L66). The other exports are `conferredBy` L216 and `conferralMatrix` L231.

The conferral matrix below was derived by reading the code; `conferral.test.ts` asserts Admin↛Owner and Admin↛Builder:

| caller→ | owner | admin | builder | viewer |
|---|---|---|---|---|
| owner | allow | allow | allow | allow |
| admin | deny | allow | deny (`connectors` run or `projects`) | allow |
| builder | deny | deny | allow | **refuse** (`agents.run` own vs permitted) |
| viewer | deny | deny | deny | allow |

**Principal** (`principal.ts`): `Via = 'session'|'api-key'|'browser-token'` (L69); `PRINCIPAL_KINDS = ['membership','api_key']` (L84); `class Principal` (L102) is frozen, with `#provenance` making it nominal. Its factories are `fromSession` (the workspace slug must equal the claims' `ws`), `fromApiKey`, `fromDirectoryRecord` and `fromBrowserToken(minter, scope)`. The invariants: `scope≠null ⇔ via='browser-token'` and `apiKeyId≠null ⇔ via='api-key'`.

**API key and browser token codecs** (`api-key.ts`, `browser-token.ts`):

| Function | Behaviour |
|---|---|
| `mintApiKey` / `mintBrowserToken` | 16-byte id and 32-byte secret, base64url |
| `hashApiKeySecret` | SHA-256 hex |
| `parsePresentedKey` / `parsePresentedBrowserToken` | Match the patterns above |
| `readBearerApiKeyAttempt` / `readBearerBrowserTokenAttempt` | `absent \| invalid \| presented`, using the regex `/^Bearer[ ]([^ ]+)$/iu` on the trimmed header |
| `hashesEqual` | Constant-time comparison |
| `hashBrowserTokenSecret`, `browserTokenHashesEqual` | Aliases of the two functions above |

**`token-scope.ts`**: `TOKEN_SCOPE_KINDS`, `TokenScope {kind, id}`.

**`ownership.ts`**: `resolveMemberUserId`, `resolveSessionActorUserId`, `resolveSessionActorUserIdForWorkspace`. These are compatibility helpers and never invent a user.

### 3.2 Capability tables derived from `decide` (ADR `W9-UI-184`)

| File | Function | Queries passed to `decide` (scope: null) |
|---|---|---|
| `apps/web/server/projects/archive-capability.ts` | `archiveGrantsForRole` L60, `archiveCapabilityFor` L98, `NO_ARCHIVE_CAPABILITY` L45 | `POST /api/projects/:id/archive` × {own, other} |
| `apps/web/server/team/membership-capability.ts` | `membershipGrantsForRole` L74, `conferrableRolesFor` L95 (= `ROLES.filter(conferRole allow)`) | `GET /api/memberships` n-a; `PATCH`/`DELETE /api/memberships/:id` unknown |
| `apps/web/server/team/invitation-capability.ts` | `invitationGrantsForRole` L73 | `GET`/`POST /api/invitations` n-a; `POST …/:id/resend`, `DELETE …/:id` unknown |
| `apps/web/server/team/team-capability.ts` | `teamCapabilityFor` L45, `NO_TEAM_CAPABILITY` L34 | combines the two above |

### 3.3 Narrowing and permission caps

| Rule | Source | Statement |
|---|---|---|
| File-grant cap | `packages/core/src/db/repositories/agent-resources.ts` ~L76–L95 | `writeFiles=false` → every `read-write` file grant reads back as `read` (applied on read and on `replace`). ADRs `W9-UI-133-permission-cap-narrows-at-read-and-write.md`, `…-at-save-not-at-compose.md` |
| Base policy | `apps/web/server/agents/policy.ts`: `compiledPolicyFor` L54, `policyFor` L74 (stored ?? compiled), `parsePolicyBody` L140, `firstUnassignedSkillName` L177 | `skills` allowlist = assigned enabled skills; limits null/null |
| Run composition | `apps/web/server/compose/run-request.ts`: `toolPolicyFor` L260, `agentConfigFor` L309, `applyFileGrantPolicy` L386, `sandboxFor` L417, `resolveModelForRun` L347 (`ModelResolutionLayer = run\|agent\|project\|workspace\|deployment`; `deployment` is the last layer, the agent's connection plus `AW_DEPLOYMENT_DEFAULT_MODELS[provider]`, issue #506) | Read-only files add `Write(…)`, `Edit(…)`, `NotebookEdit(…)`, `Bash`, `BashOutput` and `KillShell` to `deny`, so deny only grows. ADR `W1-COMP-01-permissions-map-onto-deny-not-allow.md` |
| SDK options compiler | `packages/core/src/config.ts` `compileRunRequest` L124 | Re-parses `RunRequest`; `ANTHROPIC_API_KEY` must never appear in the output env (L110) |
| Runnable share | `apps/web/server/shares/runnable/service.ts` `publicPermissions` L7 | `{...p, runCommands:false, writeFiles:false}` |
| Project resources | ADR `W9-PROJ-125-project-resources-narrow-never-widen.md` | — |
| Network policy | `apps/web/server/runtimes/network-policy.ts`: `networkPolicyIds` L43, `networkPolicyMapping` L105 (a driver × {none,restricted,open} cell table with `divergence`), `NONE_MEANING` L81 = `'the gateway and nothing else'`, `networkPolicyCellFor` L217 | — |
| Egress | `packages/core/src/net/egress-policy.ts` `checkEgress` L202 | Refuses: unparseable URL; userinfo; DNS fail or no addresses; any address in a blocked category (`unspecified, loopback, private, link-local, unique-local`, …) unless the host is in `allowHosts` or it is loopback in non-production; non-`https:` unless non-production and all addresses are loopback. `guardedFetch` L280 uses `redirect:'error'` and pins the address for http |
| Model config | `apps/web/server/models/contract.ts` `requiredConfigFields` L65, `isModelConnectionConfigComplete` L72, both read from `MODEL_PROVIDER_CONFIG_RULES` (imported at L4) | Same table as contracts `MODEL_PROVIDER_CONFIG_RULES` (a T4 equality) |

---

## 4. Tenant-isolation predicates

| Predicate | Source | Statement |
|---|---|---|
| `WorkspaceScope` (nominal, frozen, `#workspaceIdFromLookup`) | `packages/core/src/db/repositories/scope.ts` L111 | Only minted by a resolver after a row lookup (`databaseResolver`, `inMemoryResolver`) |
| `isWorkspaceScope` | scope.ts ~L140 | `#` brand ∧ frozen ∧ `workspaceId === #workspaceIdFromLookup` |
| `requireWorkspaceScope(v, repo)` | L242 | Returns the scope or throws `ForgedWorkspaceScopeError`. It is called by every `forScope` |
| `createScopedObjectStore(backend, wsId)` | `packages/core/src/storage/object-store.ts` L186 | Prefix `workspaces/${wsId}`; every key goes through `toObjectKey` and every prefix through `toObjectPrefix`; list output is stripped. ⚠ `wsId` is only checked to be a **non-empty trimmed string**, with no `/` or `..` check. This is a T3 target |
| `validateTenantSessionScope` | `packages/run-protocol/src/schemas.ts` L530 (`TenantSessionScope` L575) | `configDir` a non-blank string; `projectKey` matches `/^[A-Za-z0-9_-]{1,64}$/` and is not a Windows device name |
| `requireResourceAccess(request, ownership)` | `apps/web/server/resources/authorise.ts` L16 | Wraps `rbac/http.ts#authorise`; returns `{ok, principal}` or a response |
| `workspaceNotFound` / `apiKeyRefusal` / `memberOwnershipResolver` / `ownerOwnershipResolver` | `apps/web/server/workspaces/access.ts` L59/75/118/134 | Non-UUID id, non-member or vanished membership → the identical 404 `workspace_not_found`; `via==='api-key'` → 403 `api_key_not_permitted`; owner-only write gives `own` or `other` |
| Cross-tenant run read | `runs/api.ts` `findRunForPrincipal` | A run outside the workspace → 404 `run_not_found` |
| Schema tenancy rule | `packages/core/src/db/schema/tenancy.test.ts` L1329 | Every non-exempt table has a non-null `workspace_id` with exactly one single-column FK to `workspaces.id` and a leading index. `TENANT_EXEMPT` (L54) = `workspaces, users, user_identities` |
| Cross-tenant FK rule | tenancy.test.ts L1420 | Every FK is tenant-paired `(x_id, workspace_id) → (id, workspace_id)` or provably cannot be. Every `*_id` column is an FK or a declared non-reference (L1544). `REQUIRED_REFERENCES` (L394): `sessions_member_workspace_fk (workspace_id,user_id)→memberships` |
| Closed sets in the DB | `schema/one-of.ts` `oneOf` L68, `renderValueList` L41 (`SAFE_VALUE /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`, ≤64, no duplicates, non-empty) | — |
| Principal source xor | `schema/workspace-principals.ts` L135–L144 | — |
| Composite unique targets | `agents_id_workspace_key`, `files_id_workspace_key`, `mcp_servers_id_workspace_key`, `model_connections_id_workspace_key`, `projects_id_workspace_key`, `runs_id_workspace_unique` (unique **index**), `runtime_profiles_id_workspace_key`, `secrets_id_workspace_key`, `sessions_id_workspace_key`, `shares_id_workspace_key`, `skills_id_workspace_key`, `memberships_workspace_id_key`, `api_keys_workspace_id_key`, `workspace_principals_workspace_id_key` | — |
| Rows from other tenants never cross the SDK | contracts | `ModelConnectionResource`, `SecretResource`, `ApiKeyResource` and `InvitationResource` carry no `workspaceId` |

---

## 5. DB tables (`packages/core/src/db/schema/*.ts`, 33 tables)

> ENG-06 (#305) brought the catalogue to **36** tables — `session_state_streams`,
> `session_state_entries` and `session_state_blobs`. The heading keeps `33` because it is the
> GitHub anchor 55 `@[aw_spec]` citations resolve against; renaming it is a cross-cutting change
> of its own. `Er.Core.catalogue` and `docs/formal/catalogue.md` carry the live list.
>
> S1-04 (#442, migration 0033) brought it to **39** — `agent_versions` (an agent's immutable,
> numbered definitions) and `agent_version_pointers` (the version live per agent and environment,
> keyed `(agent_id, environment)`).

Every PK is `id uuid defaultRandom` unless stated otherwise. **T** means `workspace_id NOT NULL → workspaces(id) ON DELETE CASCADE`. Composite FKs are tenant-paired `(col, workspace_id)` unless stated otherwise.

| Table (module) | Tenancy | PK | Notable FKs | Unique / check |
|---|---|---|---|---|
| workspaces | **exempt** (is the tenant) | id | `workspaces_default_model_connection_workspace_fk (default_model_connection_id, id)` | `workspaces_slug_key`; checks `slug_format`, `name_not_blank`, `default_model_pair`; `archived_at` |
| users | **exempt** | id | — | `users_email_key`; `email_lowercase`, `email_shape`, `name_not_blank` |
| user_identities | **exempt** | id | user_id→users | `issuer_subject_key`; `issuer_not_blank`, `subject_not_blank` |
| memberships | T | id | user_id→users cascade | `memberships_workspace_user_key`, `memberships_workspace_id_key`; `oneOf role_valid` |
| workspace_principals | T | id | `membership_workspace_fk`, `api_key_workspace_fk` (cascade) | `(ws,id)`, `(ws,membership)`, `(ws,api_key)`; `kind_valid`, **`source_xor`**, `revoked_after_activation` |
| api_keys | T | id | — | `(ws,id)`, `(ws,name)`, **`key_hash_key` global**; `role_valid`; `name`, `key_prefix` and `key_hash` not blank; `expires_after_created`, `revoked_after_created` |
| invitations | T | id | invited_by→users set null | **partial unique `(ws,email) WHERE accepted_at IS NULL AND revoked_at IS NULL`**; `role_valid`, `email_lowercase`, `email_shape`, `token_hash_not_blank`, `expires_after_created`, `accepted_after_created`, `revoked_after_created`, **`not_accepted_and_revoked`** |
| browser_tokens | T | id | `run_workspace_fk`, `session_workspace_fk`, `minter_workspace_fk (ws, minted_by_principal_id)` | `hash_key`; `scope_kind_valid`, **`scope_xor`**, `expiry_after_created`, `revoked_after_created` |
| agents | T | id | `model_connection_workspace_fk`, `runtime_profile_workspace_fk`, `created_by_workspace_fk (ws,created_by)`, `owner_principal_workspace_fk (ws, owner_principal_id)` | `(ws,name)`, `(id,ws)`; `name_not_blank` |
| agent_files | T | id | `agent_workspace_fk`, `file_workspace_fk` | `(ws,agent,file)`; `oneOf access_valid` (`read`,`read-write`) |
| agent_grants | T | id | `agent_workspace_fk`, `member_workspace_fk (ws,user_id)` | `(ws,agent,user)`. ⚠ Keyed by `user_id`, while the wire `AgentGrantsSchema` carries `principalIds` |
| agent_mcp_servers | T | id | `agent_workspace_fk`, `server_workspace_fk` | `(ws,agent,server)` |
| agent_skills | T | id | `agent_workspace_fk`, `skill_workspace_fk` | `(ws,agent,skill)` |
| files | T | id | `created_by_workspace_fk`, `owner_principal_workspace_fk` | `(ws,path)`, `(id,ws)`; `kind_valid`, `path_shape` `^[^/[:cntrl:]]+(/[^/[:cntrl:]]+)*$`, `path_no_dot_segments`, `storage_key_iff_file`, `storage_key_not_blank`, `folder_has_no_content`, `size_non_negative` |
| mcp_servers (connectors) | T | id | `created_by_workspace_fk`, `credential_secret_workspace_fk`, `owner_principal_workspace_fk` | `(ws,name)`, `(id,ws)`; `transport_valid`, `auth_type_valid`, `url_shape ^https?://`, `stdio_has_command`, `remote_has_url`, `args_are_stdio_only`, `command_not_blank`, `credential_required`, `name_not_blank` |
| model_connections | T | id | — | `(ws,name)`, `(id,ws)`; `provider_valid` |
| runtime_profiles | T | id | `runtime_connection_workspace_fk` → **secrets** (runtime connections are secrets rows) | `(ws,name)`, `(id,ws)`, `(ws,workspace_default)` (at most one default per workspace, #504); `driver_valid`, `filesystem_valid`, `network_policy_valid`, `name_not_blank`, `workspace_default_true_or_null` |
| secrets | T | id | — | `(ws,name)`, `(id,ws)`; `name_shape`, `master_key_id_not_blank`, `algorithm_valid` (`aes-256-gcm`), `ciphertext_not_empty`, `wrapped_data_key_size`, `nonce_sizes`, `tag_sizes` |
| projects | T | id | `default_agent_workspace_fk`, `default_model_connection_workspace_fk`, `owner_principal_workspace_fk`; created_by→users restrict | `(id,ws)`, `(ws,name)`; `visibility_valid`, `name_not_blank`, `default_model_pair`; `archived_at` |
| project_files | T | **(project_id, file_id)** | `project_workspace_fk`, `file_workspace_fk` | — |
| project_mcp_servers | T | **(project_id, mcp_server_id)** | `project_workspace_fk`, `server_workspace_fk` | — |
| sessions | T | id | `agent_workspace_fk`, `project_workspace_fk`, **`member_workspace_fk (ws,user_id)→memberships`**, `owner_principal_workspace_fk` | `(ws, claude_session_id)`, `(id,ws)`; `status_valid` |
| session_transcripts | T | **(workspace_id, project_key, session_id, subpath)** | `session_workspace_fk` | `subpath ''` = the main transcript |
| session_messages | T | **(ws, project_key, session_id, subpath, sequence)** | `transcript_fk` (4-column) cascade | `position` retained across redelivery |
| runs | T | id | **`runs_session_workspace_fk`** cascade, `model_connection_workspace_fk` | `runs_id_workspace_unique`; `status_valid`, `provider_valid`, `accounting_state_valid`, **`ended_at_iff_terminal`**, `ended_after_started`, `counters_non_negative`, `cost_currency_usd`, `price_version_matches_accounting_state`, `unpriced_cost_zero`. There is no `agent_id` column (derived via the session) |
| run_events | T | **(run_id, sequence)** `run_events_pkey` | `run_workspace_fk` | — |
| run_tokens | T | id | `run_workspace_fk` | `hash_key`; `expiry_after_created`, `revoked_after_created` |
| run_usage_records | T | id | `run_workspace_fk` | `response_unique`; `currency_usd`, `counters_non_negative` |
| skills | T | id | `created_by_workspace_fk`, `owner_principal_workspace_fk` | `(ws,name)`, `(id,ws)`; `name_shape`, `skill_md_not_blank` |
| shares | T | id | `creator_workspace_fk`, `publisher_principal_workspace_fk` | `(id,ws)`, **`token_key`**; `subject_type_valid`, `visibility_valid`, `mode_valid`, **`agent_mode_only`**, `budget_nonnegative`, `spend_nonnegative`, `subject_id_not_blank` |
| share_views | T | id | `share_workspace_fk` | — |
| share_run_charges | T | **run_id** | `share_workspace_fk`, `run_workspace_fk` | `nonnegative` |
| audit_events | T | id | `actor_principal_workspace_fk`; actor_user_id→users set null | `action_valid`, `actor_label_not_blank`, `subject_label_not_blank`, `subject_id_shape` |

Owner columns: `owner_principal_id NOT NULL` on agents, files, mcp_servers, projects, sessions and skills. The equivalents are `publisher_principal_id` on shares, `minted_by_principal_id` on browser_tokens and `actor_principal_id` (nullable) on audit_events. The legacy human columns are `created_by`, `sessions.user_id` and `agent_grants.user_id`.

Enums duplicated in the schema (a T4 equality against contracts): `membershipRoles`, `runStatuses`/`terminalRunStatuses`, `fileKinds`, `fileAccessModes`, `mcpTransports`/`remoteMcpTransports`/`mcpAuthTypes`/`credentialedMcpAuthTypes`, `projectVisibilities`, `runtimeProfileNetworkPolicies`/`Filesystems`, `secretAlgorithms`, `sessionStatuses`, `shareSubjectTypes`/`Visibilities`/`Modes`, `browserTokenScopeKinds`, `workspacePrincipalKinds = ['membership','api_key']`.

---

## 6. Parsers and encoders

### 6.1 SSE

| Side | Symbol | Source | Behaviour |
|---|---|---|---|
| server | `SSE_HEADERS` L46, `DEFAULT_KEEPALIVE_MS` 15 000 L74, **`DEFAULT_RETRY_MS` 3 000** L77, **`MAX_EVENT_ID` = 2⁶³−1** L86 | `apps/web/server/runs/sse.ts` | — |
| server | `CONTROL_FRAME_NAMES = ['done','run-failed','stream-reset','error']` L110, `PLATFORM_EVENT_NAMES=['run.status']` L128, `RESERVED_EVENT_NAMES` L137 | sse.ts | ⚠ This list has 4 names and the contract has 3. `error` is reserved and never emitted. `sdk-conformance.test.ts` "reserves the same names as the server, minus the one it never emits" gates the difference |
| server | `classifyEventName` L175 (`ok\|reserved\|rejected`), `classifyPlatformEventName` L209, `classifyStoredEventName` L238, `renderEventData` L271 | sse.ts | Never throw |
| server | `sseFrame(e)` L316 → `event: N\nid: <bigint>\ndata: <JSON>\n\n` (throws on a bad name or data); `sseControlFrame` L331 → `event: N\ndata: J\n\n` (no id); `sseRetryFrame` → `retry: ms\n\n`; `sseComment` → `: text\n\n` with CR/LF → space | sse.ts | — |
| relay | `SseLineSplitter.push/rest` L64 | `apps/web/server/runs/relay.ts` | Splits on CR, LF or CRLF, including a CRLF that straddles chunks. The unterminated tail is discarded |
| relay | `SseMessageAssembler.line` L108 | relay.ts | HTML §9.2: a blank line dispatches when data≠null; `:` is a comment; `data` lines join with `\n`; an `id` containing NUL is ignored; `retry` and unknown fields are ignored; an empty `event` becomes null |
| relay | `parseSseStream` L155, `classifyRunnerResponse` L232 (200 ∧ `text/event-stream` ∧ body), `RUNNER_TERMINAL_FRAMES = run-done, run-error, run-interrupted` L216, `RelayOutcome completed\|cancelled\|failed` L195 | relay.ts | — |
| resume | `readResumeCursor(header, query)` L89 → `absent \| after{id,source} \| invalid{source,reason}` | `apps/web/server/runs/cursor.ts` | The header wins. `EVENT_ID_DIGITS /^\d{1,19}$/` after `trim()`, and ≤ MAX_EVENT_ID. Invalid never degrades to absent |
| SDK | `parseSseFrame(raw)` L33 | `packages/sdk/src/events/sse.ts` | Splits lines on `\n`; skips blank and `:` lines; the last `event`/`id` wins; data joins with `\n`; no `event` → `null`; empty data → `null`; JSON parse falls back to the raw string. ⚠ It does not ignore an `id` with NUL (the relay does) |
| SDK | `splitSseFrames(buf)` L74 | SDK sse.ts | Normalises `\r\n` only. ⚠ It does not handle a lone CR, while the server splitter does. The server never emits CR because JSON escapes it |
| SDK | `readSseFrames(body, signal)` L88 | SDK sse.ts | Cancels the reader on abort or early exit |
| SDK | `classifyRunEventFrame` | `packages/sdk/src/events/run-events.ts` | `done` / `run-failed` / `stream-reset` / `run.status` are validated against the contract (a mismatch is a `ContractViolationError` with status 200); anything else is `runtime{name,id,data}` |
| SDK | `toAgentEvent`, `assistantResponseFromAgentEvent` | `packages/sdk/src/events/agent-event.ts` | ENG-03 (#302): an `AgentEvent` **is** a validated `agent.*` frame, so this module is a parser and holds no engine vocabulary. Only `runtime` frames parse (`null` for a platform frame); a payload that fails `AgentFrameSchema` is a `ContractViolationError`. The mapping that produces the frames is `packages/core`'s `toAgentFrames` |

### 6.2 Paths, ids and names

| Symbol | Source | Grammar and behaviour |
|---|---|---|
| `fileRouteId` | `packages/contracts/src/files.ts` L55 | Hand-rolled base64url with no padding |
| `encodeFileId` / `decodeFileId` | `apps/web/server/files/file-id.ts` | `Buffer…toString('base64url')`. Decode requires `/^[A-Za-z0-9_-]+$/`, a round-trip equality check and a **fatal** UTF-8 decode, else `null`. T0: `decode∘encode = id` and injective. T4: `fileRouteId ≡ encodeFileId` (already asserted in sdk-conformance "mints the same route id") |
| SDK file path | `packages/sdk/src/resources/files.ts` `#path` → `/api/files/${segment(fileRouteId(path))}`; upload and mkdir use `resourcePathHeaders('x-file-path'\|'x-folder-path', path)` | `segment = encodeURIComponent` (`http.ts` L343) is used for every path id in the SDK |
| `evaluateRelativePath(raw, allowRoot)` L265, `toObjectKey` L353, `toObjectPrefix` L362 | `packages/core/src/storage/key-safety.ts` | Decode once (malformed → `malformed-encoding`); a control char in raw or decoded (0–31, 127) → `control-character`; `\` → `backslash`; leading `/` or a drive letter → `absolute`; empty → `empty-key` (unless `allowRoot`); an empty segment → `empty-segment`; `.`/`..` → `dot-segment`; a segment containing `__objectstore_meta__` in any case fold → `reserved-name`; **`decoded ≠ raw` → `non-canonical`**. Rules are listed in `ObjectKeyRejectionRule` L152 (9). `UnsafeObjectKeyError` L202 |
| `isValidSkillName` L84, `isAdmissibleRelativePath` L158 | `apps/web/server/skills/keys.ts` | Non-empty; ≤4096 UTF-8 bytes; every segment ∉ {`.`,`..`}; no segment ends in `.` or a space; every segment matches `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` |
| `createCaseFoldGuard(existing)` L229 | skills/keys.ts | `check(p)` returns the prior spelling when `lower(p)` collides with a *different* spelling. `add(p)` records it. ADR `W9-FILES-131-case-only-renames-are-refused.md` |
| `skillFileKey` / `skillFilesPrefix` / `skillMetaKey` / `skillNameFromMetaKey` | skills/keys.ts L250–L273 | Prefixes `skills` and `skill-meta` |
| `parseProjectKey` L194, `parseSessionId` L219, `parseSubpath` L238, `parseTranscriptKey` L271, `parseTranscriptEntry` L302, `parseTranscriptEntries` L329, `mergeTranscriptEntries` L361, `transcriptKeyId` L424 | `apps/web/server/sessions/transcript.ts` | Patterns: `PROJECT_KEY_PATTERN` L164, `WINDOWS_DEVICE_NAME_PATTERN /^(?:con\|prn\|aux\|nul\|com[0-9]\|lpt[0-9])$/i` L167, `SESSION_ID_PATTERN` L170, `SUBPATH_PATTERN` L181 (the contract's `TRANSCRIPT_SUBPATH_PATTERN`), `MAX_SUBPATH_LENGTH 128`, `MAX_BATCH_ENTRIES 5000`. `parseSubpath`: null or undefined → main transcript; `''` → reject |
| `normalizeArchivePath(v)` | `packages/runtime/src/transfer.ts` | Up to **3** rounds of `decodeURIComponent` (a malformed one throws); `\`→`/`; refuses empty (before and after decoding), NUL (before and after decoding), a leading `/`, a drive letter, and a `..` segment; `posix.normalize` must not escape, then `./` and a trailing `/` are stripped. The runner uses it for `/files` and for run resources; `safeWorkspacePath` no longer exists. ⚠ A 4th encoding level passes through literally. This is an adversarial target |
| `normalizeArchivePath` L111, `encodeUstar` L201, `decodeUstar` L262, `encodeUstarStream` L352, `extractUstarStream` L780, `readUstarStream` L876, `extractUstar` L920, `archiveWorkspacePaths` L990 (re-measured after the all-or-nothing hydrate, #1749; not at `f3c9dec`) | `packages/runtime/src/transfer.ts` | The same guard; the one codec and confinement implementation, with the runner as a thin adapter. 512-byte blocks and a 2-block zero trailer. The streaming codec enforces the payload-byte and member-count caps (`RUN_FILES_MAX_BYTES`, `RUN_FILES_MAX_MEMBERS`) before a member is written, and a refused hydrate leaves the workspace as it was (staging directory, then a commit that undoes itself) |
| `oneOf` / `renderValueList` | `schema/one-of.ts` | DDL literal safety |

### 6.3 Cursors and pagination

| Item | Source | Behaviour |
|---|---|---|
| Run list cursor | `apps/web/server/runs/api.ts` `encodeRunListCursor` L381, `decodeRunListCursor` L544, `isRunListCursorTimestamp` L451 | base64url(JSON `{createdAt, id}`). `createdAt` is the exact PostgreSQL text `YYYY-MM-DDTHH:MM:SS.ffffffZ` (1–6 fraction digits accepted) and `id` is a UUID. Any failure → `400 invalid_cursor`, never a restart. Keyset `(created_at, id)` descending, `MAX_RUN_LIST_LIMIT 200` (`store.ts` L210) |
| Resume cursor | `cursor.ts` | See §6.1 |
| Other lists | — | Unpaginated. The audit list has `limit` only |

### 6.4 Error envelopes and redaction

- **Three spellings** (§1.1). The SDK's `readProblem` (`packages/sdk/src/http.ts` L144) tries them in order (standard → detail → bare) and maps them to `{code, message, details?}`.
- A non-envelope body becomes the code `unrecognised_error_body`.
- The server-side RBAC renderer is `rbac/http.ts` `problem(status, code, detail)` L47, with `MAX_REQUEST_BODY_BYTES = 16 KiB` L42.
- `publicRunFailure(cause, ctx)` (`apps/web/server/runs/failures.ts` L14) returns the `publicMessage` of a `DomainError`; otherwise it logs the cause and returns `ctx.publicMessage`. There is no separate redaction function.

---

## 7. SDK rules (`packages/sdk/src`)

| Rule | Source | Statement |
|---|---|---|
| Auth | `http.ts` L23 `ClientAuth` | `api-key` and `browser-token` send `Authorization: Bearer`; `session` sends `credentials: 'include'`. `ClientOptions.workspace` is valid only with `session` (the constructor throws otherwise). The workspace switch `POST /api/auth/workspace` is memoised; a rejection clears the memo |
| Timeout | `headersDeadline` L98 | Covers **response headers only**. It is disarmed once `fetch` resolves, so a stream body can outlive it. The abort reason is `DOMException TimeoutError` |
| Abort | `combinedSignal` L117 | `AbortSignal.any([caller, deadline])`, or the single signal, or none |
| Retry-After | `retryAfterSeconds` L131 | Numeric seconds ≥ 0 only (the HTTP-date form becomes `null`). Carried on `ApiProblemError.retryAfterSeconds` |
| No retry | `send` L280 | Exactly one `fetch` per call |
| Classification | `send`/`json` L280–L339 | `fetch` throws → **`TransportError`** (`aborted` = caller or deadline aborted). Status ∉ `expect` → **`ApiProblemError`**, even for a 2xx that is not expected. Expected status with a non-JSON body or a schema failure → **`ContractViolationError`**. A 204 parses `null` |
| Error classes | `errors.ts` | `AgentWorkspaceError` is abstract, with `kind ∈ problem\|contract\|transport`. `ApiProblemError{status, code, details, retryAfterSeconds}` L18. `ContractViolationError{status, issues}` L43. `TransportError{aborted}` L62 |
| `runs.events` | `resources/runs.ts` L174 | `GET …/events` with `accept: text/event-stream`, plus `last-event-id` when `after` is set. A wrong content type or no body → `ContractViolationError`. Returns `{lastEventId}` on `done`. The body ends without `done`, or a mid-stream error → `TransportError`. A `ContractViolationError` is rethrown as-is |
| **`runs.follow`** | L242 | Reconnects on `TransportError` unless the **caller's** signal aborted (a deadline abort does reconnect). **`maxReconnects` defaults to 5**, and the counter is never reset. `reconnectDelayMs` defaults to 3000, and an abort during the wait → `TransportError(aborted)`. Resumes from the last durable id (`run-status`/`runtime` frames with an id). `stream-reset` is yielded as-is |
| **`runs.waitForOutcome`** | L285 | Drains `follow`, then `get`. A non-terminal status → `ContractViolationError` (operation `runs.waitForOutcome`) |
| Pagination | contracts | `runs.list`, `sessions.list` and `observability.audit.list` are cursor-paged (`nextCursor`); `sessions.listAll` and `observability.audit.listAll` walk every page (S-5, ADR-0079) |
| Testing seam | `testing.ts` | `fetchDouble` L21, `jsonResponse` L41, `eventStreamResponse` L57, `droppedEventStreamResponse` L65, `openEventStreamResponse` L85, `drain` L105 |

**Method list** (`createClient`, `index.ts` L134):

| Client | Methods (HTTP) |
|---|---|
| `me()` | GET /api/me |
| `workspaces` | list, get, create, update (PATCH), select (POST /api/auth/workspace); `.sharingPolicy` get, set (PATCH /api/sharing-policies) |
| `agents` | list, get, create (×3 overloads, one with assignments), update, remove, getResourceAssignments, replaceResourceAssignments (PUT), getGrants, replaceGrants (PUT), getPolicy, replacePolicy (PUT) |
| `runs` | start (202), get, interrupt, revokeTokens, list, events, follow, waitForOutcome |
| `sessions` | list, get, update (PATCH); `.transcript` read, subkeys |
| `projects` | list, get, create, update, archive, restore, startSession, adoptSession (both POST …/sessions) |
| `secrets` | list, create, replace (PUT) |
| `runtimes.profiles` | list, get, create, update, remove |
| `runtimes.connections` | list, create |
| `models` | discover (GET /api/models); `.connections` list, get, create, update, remove, rotateCredential (POST …/credential), test |
| `files` | list, upload, createFolder, download (file or folder arm), move (PATCH), remove (DELETE, `?recursive=true`) |
| `skills` | list, import (POST), get, export (GET `?export=true`), update (PATCH) |
| `connectors` | list, get, create, remove, rotateCredential (PATCH), test, testDraft (POST /api/connectors dry run) |
| `team` | `.members` list, add, setRole, remove; `.users` list, create; `.invitations` list, create, resend, revoke, accept; `.apiKeys` list, create, revoke |
| `shares` | list, publish, revoke |
| `observability` | `.metrics.recentRuns`, `.audit.list` |
| `tokens` | mint (POST /api/tokens) |

---

## 8. CLI rules (`packages/aw/src`)

| Rule | Source | Statement |
|---|---|---|
| Flag tables | `args.ts` | `VALUE_FLAGS` L8: url, profile, timeout, file, name, role, email, prompt, prompt-file, session, model, limit, cursor, path, status, archived, agent, project, after, project-key, subpath, scope, id, ttl. `SWITCH_FLAGS` L39: api-key-stdin, value-stdin, json, jsonl, raw, quiet, help, recursive, wait, follow, interrupt-on-cancel, all. `REPEATABLE_VALUE_FLAGS` L59: skill, connector, grant-file. The tables are asserted disjoint at load time. `command.ts` `assertSupportedFlags` then refuses (exit 2) any flag outside the global set and the command's own usage line |
| Grammar | `parseArguments` L118 | `--` ends flags (the rest are positional). `-h` means help. A non-`--` token is positional. `--name=value` and `--name value` both work, but the value may not start with `--`. `--api-key` → UsageError(`API_KEY_FLAG_REFUSED`). A switch with `=` → error. An unknown flag → error. A repeated value flag → error. A missing value → error |
| Config precedence | `config.ts` `resolveConfig` | **URL** = `--url` > named `--profile`.url > `AGENT_WORKSPACE_URL` > `default` profile.url. **Key** = if `--api-key-stdin`, then stdin (a blank value is an error and does not fall through); else named-profile `env[apiKeyRef]` > `AGENT_WORKSPACE_API_KEY` > default-profile `env[apiKeyRef]`. A named profile that is missing → UsageError. `--timeout` must be a positive integer of ms and comes from the flag only. Profiles live in `~/.config/agent-workspace/profiles.json`, a strict `{name:{url, apiKeyRef}}` |
| stdin | `io.ts` `stdinOnce` | A second read → UsageError |
| Output modes | `output.ts` `outputMode` L30 | `{json, jsonl, raw, quiet}`. `writeResult` L101 applies these in order: jsonl with an array gives one line per item; jsonl otherwise gives one line; json gives pretty JSON; otherwise `renderHuman` (table, record or scalar; `(none)` for an empty array). `notice` goes to stderr unless `quiet` |
| **`EXIT_CODE`** | L7 | ok 0, problem 1, usage 2, contract 3, transport 4, interrupted 130 |
| `reportFailure` | L138 | The checks run in this order: SIGINT (the controller aborted) → 130; `UsageError` → 2; `ApiProblemError` → 1; `ContractViolationError` → 3; `TransportError` → 4; anything else → 1 (`unexpected`). A timeout is a transport failure, not an interrupt |
| main | `main.ts` | A bare `aw` prints help to **stderr** and exits 2. `--help` prints to stdout and exits 0. An unknown command → UsageError. The client always uses `auth: api-key` |
| Stream rendering | `stream.ts` `renderFrame` L62, `printStream` | `--raw` prints the classified frame as JSON. `--json`/`--jsonl` print AgentEvents as JSON, platform frames as themselves, and nothing for `done`. The default is human lines |
| Command resolution | `commands/index.ts` `COMMANDS`, `resolveCommand` (longest-prefix match), `commandsUnder` | — |

**The 88 commands** (`command(path,…)` in `commands/*.ts`):

| Family | Commands |
|---|---|
| me | `me` |
| workspaces | `sharing-policy get`, `sharing-policy set` |
| team | `members list/add/set-role/remove`, `users list/create`, `api-keys list/create/revoke` |
| models | `connections list/get/create/update/remove/rotate-credential/test`, `discover` |
| runtimes | `profiles list/get/create/update/remove`, `connections list/create` |
| secrets | `list`, `create`, `replace` |
| files | `list`, `upload`, `mkdir`, `download`, `move`, `remove` |
| skills | `list`, `get`, `import`, `export`, `update`, `enable`, `disable` |
| connectors | `list`, `get`, `create`, `remove`, `rotate-credential`, `test`, `test-draft` |
| agents | `list`, `get`, `create`, `update`, `remove`, `assignments get/set`, `grants get/set`, `policy get/set` |
| projects | `list`, `get`, `create`, `update`, `archive`, `restore`, `start-session`, `adopt-session` |
| sessions | `list`, `get`, `rename`, `archive`, `restore`, `transcript`, `subkeys` |
| runs | `start` (`--wait`/`--follow`), `get`, `list`, `events`, `follow`, `interrupt`, `wait` |
| observability | `metrics recent-runs`, `audit list` |
| shares | `list`, `revoke` |
| tokens | `mint` |

These are absent from the CLI (a coverage fact for T5): workspaces list/get/create/update, team invitations, shares publish, runs revoke-tokens.

---

## 9. Other pure candidates

| Symbol | Source | Statement |
|---|---|---|
| `calculateUsageCost(price, usage)` | `packages/gateway/src/pricing.ts` L44 | Integer micro-dollars. Rates match `/^(0\|[1-9]\d{0,7})(?:\.(\d{1,6}))?$/u`. Cache rates default to the input rate. Output is `(Σ tokens·rateMicros + 500 000)/1 000 000` in micro-USD, formatted `D.dddddd` (rounded half up). `parsePricingCatalog` L93 and `priceFor` L127 go with it |
| `createRunTokenCodec` | `packages/gateway/src/tokens/run-token.ts` L79 | HMAC codec over `RunTokenClaimsSchema` (strict, `expiresAt > issuedAt`). `verify` → `ok \| invalid \| expired` |
| `authenticateGatewayRequest` | `packages/gateway/src/auth.ts` L75 | No bearer → 401 `token_missing`. Expired → 401 `token_expired`. Invalid → 401 `token_invalid`. Wrong run → 403 `token_run_mismatch`. Revoked → 401 `token_revoked`. Deleted → **410** `run_deleted`. Missing → 404 `run_not_found`. Otherwise ok |
| `translate/openai.ts`, `translate/openai-stream.ts` | `packages/gateway/src/translate/` | Wire translation |
| `checkEgress` | §3.3 | — |
| `publicRunFailure` | §6.4 | — |
| `requiredConfigFields` | `apps/web/server/models/contract.ts` L65 | — |
| `compileRunRequest` | `packages/core/src/config.ts` L124 | — |
| `classifyRunOutcome` | `apps/web/server/runs/api.ts` ~L886 | Total over status |
| `invitationStateOf` | `apps/web/components/team/invitations-model.ts` L79 | Pure with an explicit `nowMs`; `≤` means expired |

---

## 10. Existing oracles

| Test | Lines | What it asserts |
|---|---|---|
| `apps/web/server/rbac/authorisation-matrix.test.ts` | 632 | Derives routes from `tests/route-declarations/**` and excludes 5 `PUBLIC_ROUTES` (`GET /api/setup/runtime-detect`, `GET /api/auth/login`, `POST /api/auth/callback`, `GET`/`POST /api/auth/workspace`) and 1 `IDENTITY_ONLY_ROUTES` (`POST /api/invitations/:id/accept`). The remaining routes are crossed with 4 roles × every ownership, and **every cell must be allow or deny, never refuse**, with an explanation. Named §21 cells: Owner gets everything except the `/api/workspaces*` `other` cells; Admin's user, API-key, invitation and run-read rows; Builder's own-writes; Viewer refused runs without a grant. Fail-closed counter-examples: an unknown resource, an unknown method, an over-deep path, a bad role, a page path, an unclassified sub. A scope block: run and session grammar, narrowing only, `scope:null` is unchanged |
| `apps/web/server/rbac/token-scope-matrix.test.ts` | 174 | Over the live route union × both scope kinds: a matching id → allowed by grammar, `token_out_of_scope`, or unaffected; a non-matching id on the run scope's own resource → `token_out_of_scope` |
| `apps/web/server/rbac/conferral.test.ts`, `permissions.test.ts`, `roles.test.ts`, `declared-sub-resources.test.ts`, `tests/permission-declarations.test.ts` | — | The conferral matrix (Admin↛Owner and Admin↛Builder by name); the table matches §21; `ROLES` equals the schema's `membershipRoles`; the declaration union equals the tracked files |
| `apps/web/server/sdk-conformance.test.ts` | 2755 | The server renderers produce bodies the contract schemas accept, per family (runs, run events including reserved names and every server frame parsing to the SDK classification, agents and projects and policy, problems including the detail envelope and no infrastructure leak, models including the provider/config rule equality, runtimes, secrets with no value in any body, files where `fileRouteId` equals the server id, …) and the `PrincipalKind` ↔ `PRINCIPAL_KINDS` correspondence |
| `tests/route-inventory.test.ts` | 1655 | The route inventory equals the declared subset of spec §34. Each declaration is read and unique; every served route is declared and landed; shape rule `/api/<resource>[/:id[/<sub>]]` or a cited `mandate` section that exists in `docs/spec.md`; all route handlers run on Node and none prerender; the partition fails closed |
| `packages/core/src/db/schema/tenancy.test.ts` | ~1650 | The §27 table inventory is derived from migrations (one module per table); §25 tenant scoping for every non-exempt table; every FK tenant-paired or provably safe; every `*_id` an FK or declared; `REQUIRED_REFERENCES`; plus self-tests of its own SQL readers |
| `packages/core/src/db/repositories/scope-forgery.test.ts` | 647 | Compile time: forged `WorkspaceScope` fixtures (FORBIDDEN, PERMITTED and DECLARED tags) and an unscoped-DB fixture. Run time: every repository provider derived from the tree refuses a forged scope |
| `packages/core/src/db/repositories/refactoring-characterization.test.ts` | — | The RF-001 characterisation register |
| `apps/web/components/team/invitations-model.test.ts` | — | `invitationStateOf` precedence and the `≤` boundary |

---

## 11. Route inventory

- **Lives in** `tests/route-declarations/*.ts`: 29 files named by task id, each exporting `routes: RouteDeclaration[]` (type in `tests/inventory-support.ts`).
- **Count**: **101** entries, of which 100 are `landed: true` and one, `GET /p/:token`, is `landed: false`. They are served by 61 `route.ts` files under `apps/web/app/api/**` plus `/p/**`.
- **Readers**: `tests/route-inventory.test.ts` (shape and landed) and `authorisation-matrix.test.ts` (roles).
- `docs/sdk/07-structure-map.md` holds the resource ↔ contract ↔ route ↔ SDK ↔ CLI table.

---

## 12. Suggested unit decomposition

**Ownership convention.** Each unit owns `formal/AgentWorkspace/<Area>/<Unit>.lean` (or a `<Unit>/**` directory), `formal/Vectors/<family>/**`, `formal/vectors/<family>/**` and `tests/formal/<family>.test.ts`. Shared aggregators (`AgentWorkspace.lean`, `Er/Current.lean`, `docs/formal/concepts.md`, the catalogue) belong to the **orchestrator or synthesis agent only**. Cluster agents write `Er/Current/<Cluster>.lean` and `docs/formal/concepts/<cluster>.md` fragments.

⚠ §5 of the prompt names a single `Er/Current.lean`. That file must become an aggregator, or it breaks disjointness.

### Phase 0 slice
- `Prelude/*`, `Lifecycle/RunStatus.lean`, `Trace/*`, `Tools/*`
- Sources: contracts `runs.ts` L9–L17; `repositories/runs.ts` L677–L745; `runs/store.ts` L604–L630
- Oracle: `schema/runs.ts` `runs_ended_at_iff_terminal`

### Phase 1: concepts and the ER model (5 units plus synthesis)

| Unit | Owns | Sources |
|---|---|---|
| P1-identity | `Concepts/{User,Membership,Principal,ApiKey,Invitation,BrowserToken}.lean`, `Er/Current/Identity.lean` | schema: `users`, `user-identities`, `memberships`, `workspace-principals`, `api-keys`, `invitations`, `browser-tokens`, `workspaces`; `rbac/principal.ts`; `rbac/directory.ts`; `repositories/directory.ts`; `contracts/team.ts`, `api-keys.ts`, `invitations.ts`, `tokens.ts` |
| P1-catalog | `Concepts/{Agent,Skill,File,Connector}.lean`, `Er/Current/Catalog.lean` | schema: `agents`, `agent-files`, `agent-grants`, `agent-mcp-servers`, `agent-skills`, `skills`, `files`, `mcp-servers`, `project-files`, `project-mcp-servers`; `repositories/agent-resources.ts`, `agent-grants.ts`, `resource-catalogs.ts` |
| P1-configuration | `Concepts/{ModelConnection,RuntimeProfile,Secret}.lean`, `Er/Current/Configuration.lean` | schema: `model-connections`, `runtime-profiles` (connection = secret), `secrets`; `contracts/models.ts`, `runtimes.ts`, `secrets.ts` |
| P1-work | `Concepts/{Project,Session,Run}.lean`, `Er/Current/Work.lean` | schema: `projects`, `sessions`, `session-transcripts`, `session-messages`, `runs`, `run-events`, `run-tokens`, `run-usage-records`, `audit-events` |
| P1-publication | `Concepts/Share.lean`, `Er/Current/Publication.lean` | schema: `shares`, `share-views`, `share-run-charges`; `repositories/shares.ts` |
| P1-synthesis (after the five) | `Er/Target.lean`, `Er/Refinement.lean`, `Er/Current.lean`, `Concepts/Workspace.lean`, `docs/formal/concepts.md` | Glossary conflation candidates: user vs principal (`agent_grants.user_id` vs `principalIds`); connector = `mcp_servers`; runtime connection = `secrets` row; owner vs `created_by` vs publisher; session vs `claudeSessionId` vs transcript `projectKey` |

### Phase 2: contracts (20 units; two waves of at most 10)
- **p2a**: `identifiers`, `problem`, `runs`, `run-events`, `agents`, `api-keys`, `connectors`, `files`, `invitations`, `models`
- **p2b**: `observability`, `projects`, `runtimes`, `secrets`, `sessions`, `shares`, `skills`, `team`, `tokens`, `workspaces`

Each unit owns `Contracts/<Module>.lean`, `formal/vectors/contracts-<module>/**` and `tests/formal/contracts-<module>.test.ts`. Its sources are `packages/contracts/src/<module>.ts` plus `<module>.test.ts`. Cross-module imports (`team`→`api-keys`/`invitations`/`workspaces`; `runs`→`run-events`/`observability`/`models`; `skills`→`agents`) are **read-only imports** of earlier modules. Put `team`, `runs`, `skills` and `identifiers` first in p2a, or pre-seed their enum types in Phase 0.

### Phase 3: authorisation and behaviour (at most 10 per wave)

| Unit | Owns | Sources |
|---|---|---|
| P3-roletable | `Authz/{Roles,Resources,Permissions,Decide}.lean` | `rbac/roles.ts`, `resources.ts`, `permissions.ts`, `declared-sub-resources.ts`, `declarations/*.ts`, `decide.ts`, `auth/paths.ts`; oracle `authorisation-matrix.test.ts` |
| P3-conferral | `Authz/{Conferral,Ownership}.lean` | `conferral.ts`, `ownership.ts`, `team/*-capability.ts`, `projects/archive-capability.ts` |
| P3-tokenscope | `Authz/{TokenScope,BrowserToken,Credentials}.lean` | `token-scope.ts`, `decide.ts` L297–L381, `browser-token.ts`, `api-key.ts`, `principal.ts`, `gateway/src/auth.ts`, `gateway/src/tokens/run-token.ts`; oracle `token-scope-matrix.test.ts` |
| P3-tenancy | `Authz/Tenancy.lean` | `repositories/scope.ts`, `storage/object-store.ts`, `schemas.ts` L500–L582, `resources/authorise.ts`, `workspaces/access.ts`, `rbac/http.ts`; oracles `tenancy.test.ts`, `scope-forgery.test.ts` |
| P3-beh-identity | `Behaviour/Team.lean` | `rbac/handlers.ts`, `rbac/directory.ts`, `invitations/*`, `tokens/handlers.ts` |
| P3-beh-catalog | `Behaviour/{Agents,Skills,Files,Connectors}.lean` | `agents/*` (incl. `policy.ts`), `skills/*`, `files/*`, `connectors/*` |
| P3-beh-config | `Behaviour/{Models,Runtimes,Secrets}.lean` | `models/*`, `runtimes/*`, `secrets/*` |
| P3-beh-work | `Behaviour/{Projects,Sessions,Runs}.lean` | `projects/*`, `sessions/*`, `runs/api.ts`, `compose/run-request.ts`, `core/config.ts` |
| P3-beh-publication | `Behaviour/{Shares,Workspaces}.lean` | `shares/**`, `workspaces/*` |

### Phase 4: lifecycles, events, SDK and CLI

| Unit | Owns | Sources |
|---|---|---|
| P4-lifecycle-run | `Lifecycle/{RunAccounting,RunEvents,Interrupt}.lean` | `repositories/runs.ts`, `runs/store.ts`, `runs/interrupt.ts`, `runs/api.ts` L849 |
| P4-lifecycle-identity | `Lifecycle/{Invitation,Principal,ApiKey,BrowserTokenLife}.lean` | `repositories/directory.ts`, `browser-tokens.ts`, `run-tokens.ts`, `invitations-model.ts` |
| P4-lifecycle-archive-share | `Lifecycle/{Archive,Share,SessionStatus}.lean` | `repositories/projects.ts`, `workspaces.ts`, `shares.ts`; `run-gate.ts`, `archive-gate.ts` |
| P4-events-sse | `Events/{SseServer,SseClient,Resume}.lean` | `runs/sse.ts`, `relay.ts`, `cursor.ts`, `sdk/events/sse.ts`, `run-events.ts` (the round-trip theorem) |
| P4-events-agent | `Events/AgentFrames.lean` | `contracts/run-events.ts`, `core/schemas.ts`, `web/server/runs/agent-frames.ts`, `sdk/events/agent-event.ts` |
| P4-sdk | `Sdk/{Http,Errors,Follow,Pagination,Files}.lean` | `sdk/src/http.ts`, `errors.ts`, `resources/*.ts`, `testing.ts` |
| P4-cli | `Cli/{Args,Config,Output,Exit,Stream,Commands}.lean` | `aw/src/*.ts`, `commands/*.ts` |
| P4-pure | `Behaviour/{Pricing,Egress,NetworkPolicy}.lean` | `gateway/src/pricing.ts`, `core/net/egress-policy.ts`, `runtimes/network-policy.ts` |

### Phase 5: adversarial red/blue families (one pair per row)

| Family | Targets |
|---|---|
| A1 cross-tenant | scope, object-store `wsId`, 404 concealment (`workspace_not_found`, `run_not_found`), composite FKs |
| A2 privilege escalation | conferral, API-key minting, invitations, grants (`permitted`), shares, the Viewer cap |
| A3 token confusion | browser token scope (run R vs R′, session), run-token run mismatch, revoked or expired, a token minting a token |
| A4 path escape | `key-safety`, `file-id`, `skills/keys` plus case fold, `transcript` subpath, `normalizeArchivePath`/ustar (triple decode; the runner uses it too, `safeWorkspacePath` no longer exists) |
| A5 parser robustness | SSE split or injected frames, event-name injection, CR handling mismatch, cursor codecs, `decodeResourcePathHeader` |
| A6 error hygiene | `publicRunFailure`, egress `host`-only reason, `readProblem` normalisation |
| A7 credential exposure | response schemas with no secret, hash or credential fields (`ApiKeyResource`, `Invitation*`, `Connector`, `ModelConnection`, `RuntimeConnection`, `Secret`), `ANTHROPIC_API_KEY` never in the compiled env |
| P5-meta | role-table monotonicity counterexample, problem-code reachability, route ↔ operation coverage |

---

## 13. Programme context

- **ADRs.** The latest numbered ADR is `0059-google-secret-manager-holds-the-master-key-under-cloud-kms.md`, so **the next free number is 0060**. `0040` is used twice (`0040-a-test-run-artefact-is-not-committed.md`, `0040-sub-resource-classification-is-partitioned-…`). There are about 225 task-scoped `<TASK-ID>-kebab.md` records. The header is `# ADR-00NN — <sentence>`, then `Status:`, `Date:`, `Decided by:`, `Scope:`, then sections `## Context`, `## Decision`, then `## Consequences` and `## Alternatives considered` in **either order**. Extra sections, such as `## Rotation`, occur. There is no template file in `docs/adr/`. The index is regenerated by `docs/adr/regenerate-index.sh` into `docs/adr/README.md`.
- **Formal tooling today.** There is no Lean, TLA+, Alloy, Coq or Dafny. There is no property-based testing and no `fast-check`.
- **CI** (`.github/workflows/ci.yml`). Triggers: `pull_request` (opened, synchronize, reopened, edited), `push` to `main`, `workflow_dispatch`. Top-level `permissions: contents: read`. Jobs:
  - `fast-checks` (blacksmith-8vcpu): workflow policy, ownership, suppressions, wave plans, generated blocks, format, `docs:check`, the Nx build/typecheck/lint graph, architecture, deadcode, duplication, licences.
  - `heavy-checks` (blacksmith-16vcpu, PostgreSQL 18 and SeaweedFS services): build, artefact exports, `nx … test`, "No test in the run was skipped".
  - `formal` (blacksmith-8vcpu): the formal gates, path-filtered in a step. Added after this survey.
  - `image-scan` (blacksmith-16vcpu): builds and scans every image of the release plan. Added after this survey.
  - `generated-project-e2e` (blacksmith-16vcpu; `timeout-minutes: 45`): the generated project end to end against the change's own packages and images (#398), path-filtered in a step and always run on `main`. Added after this survey.
  - `full-e2e` (dispatch only; `needs: [fast-checks, heavy-checks]`).
  - `ci-success` (blacksmith-2vcpu; `if: always()`; `needs: [fast-checks, heavy-checks, formal, image-scan, generated-project-e2e]` since #398, `[fast-checks, heavy-checks]` at this survey's commit; runs a `jq` check over the needs results).
  - Other workflows: `azure-preview`, `gcp-small-acceptance`, `indx-dev`, `live-e2e`, `quality`, `release`, `security`.
- **`scripts/check-workflows.mjs` `validateWorkflowDocuments`** (L63):
  - Every workflow has a top-level `permissions:`, and none uses `pull_request_target`.
  - For `ci.yml`, `quality.yml` and `security.yml` only, `runs-on` must match `/^(?:blacksmith-(?:2|4|8|16|32)vcpu-ubuntu-2404|ubuntu-latest)$/`.
  - Every external `uses:` needs a 40-hex SHA in the `approvedActions` map (L11; `actions/cache@55cc8345…` is `v6.1.0`) and an exact `# <version>` comment.
  - `fast-checks`: no `services:`, plus the 13 required step strings (L130–L146).
  - `heavy-checks`: required strings, and no `needs: fast-checks`.
  - `full-e2e` and **`ci-success`** must match the **exact line** `^ {4}needs: \[fast-checks, heavy-checks\]$`, and `ci-success` must also have `if: always()`. Adding `formal` requires rewriting these regexes, not just adding a job.
  - The PR template needs exactly one `## Ownership` and the literal `Owns globs:` prompt line.
  - **Tests** are in `tests/tooling/quality-validators.test.ts`. There is no `scripts/check-workflows.test.*`.
- **Generator pattern.** `scripts/docs/generate-sdk-reference.mjs` (TS compiler API over contracts, SDK and `aw` → `docs/sdk/site/reference/**`; `lib/*.mjs` helpers) and `scripts/docs/generate-llms-txt.mjs` both take `--write` or `--check`. `--check` renders in memory and fails on `missing:` or `stale:`, telling the user to "run `pnpm docs:generate`". Root scripts: `docs:generate` (L40) runs both with `--write`; `docs:check` runs both with `--check` and is part of `check:fast`.
- **`llms.txt`.** Rendered by `renderLlmsTxt` in `generate-llms-txt.mjs`. It has three curated `REPOSITORY_SECTIONS` ("Start here", "Product and design", "Operating the platform and its status"). Each entry's title is read from the document's `# ` heading, and a missing file throws. These are followed by the docs-site navigation from `docs/sdk/site/docs.json`, with titles and descriptions from frontmatter. The `Reference` tab goes under `## Optional`. **To list the formal documents, add entries to `REPOSITORY_SECTIONS`, or add them to a `docs.json` page.**
- **`.claude/workflows/README.md`.** Scripts are committed **verbatim**. The only content added is a provenance header naming the run id, execution date, session and exact resume invocation. Example format (`wave-0-closeout.mjs` L1–L9): `// PROVENANCE — …`, `Workflow run id : wf_…`, `Executed : YYYY-MM-DD`, `Session : <url>`, `Resume with : Workflow { script: '…', resumeFromRunId: '…' }`, `Nothing below this header was edited`. A failed run is resumed with `resumeFromRunId`. A new round after full return is a new file (`-repair`, `-round3`). `check-file-ownership.mjs --plan` is **not run by CI**, and it only warns on a script with no declared ownership. The documented naming is `wave-<n>-<slug>.mjs`; the programme's `formal-*.mjs` naming departs from it.
- **PR template.** Line 1 is an HTML comment (the fail-fast contract). The sections are Ownership, Task, Spec, What changed, Acceptance, Declared gaps, Non-goals check. The `## Task` placeholder is `W<wave>-<track>-<nn> · <title> · precision level PL-<n>`.

---

## 14. Seed-fact verification (Appendix A)

✅ means verified and ✏️ means corrected.

| # | Seed fact | Verdict |
|---|---|---|
| 1 | No Lean/TLA+/Alloy/Coq/Dafny, no PBT, and `fast-check` is absent from the lockfile | ✅ ("fast-checks" appears only as a CI job name) |
| 2 | About 137 `it.each` | ✅ 138 `it.each` (143 including `test.each`/`describe.each`) |
| 3 | Latest ADR 0059, so the programme ADR is 0060; 0040 is used twice | ✅ |
| 4 | ADR format: title, Status/Date/Decided by/Scope, then Context, Decision, Alternatives, Consequences | ✏️ The headers are right. The section **order varies** (0052 and 0059 put Consequences *before* Alternatives), extra sections occur, and Decision is not always numbered. There is no template file |
| 5 | Task-scoped ADRs use `<TASK-ID>-kebab.md`; the index is regenerated with `regenerate-index.sh` | ✅ |
| 6 | "19 subpath exports" | ✏️ There are **19 export entries = root `.` plus 18 subpaths**. `identifiers` and `problem` are root-only |
| 7 | About 111 schemas; zod is the only dependency | ✅ Exactly 111 exported `*Schema`; `zod` 4.6.4 |
| 8 | The listed closed enums exist | ✅ All exist. `RUN_STATUS_EVENT` is a string constant, not an enum. Also mirror `PROJECT_VISIBILITIES`, `TEST_CONNECTION_FAILURE_KINDS`, `MODEL_CONNECTION_CONFIG_FIELDS`, `DISCOVERED_MODEL_CAPABILITY_KEYS`, `AGENT_MUTABLE_FIELDS`, the inline `RevokeRunTokens.outcome` and `access` enums, and `'unknown'` in `RunFailedFrameData.status` |
| 9 | `bypassPermissions` is refused via `AGENT_POLICY_PROBLEM_CODES` | ✏️ The code `dangerous_permission_mode_refused` (400) exists, but the refusal happens in the **route**. The Zod schema accepts `bypassPermissions` when `allowDangerouslySkipPermissions: true` |
| 10 | The seven regex grammars exist | ✅ All seven, with the literals in §1. Also mirror `UUID_PATTERN`, `API_KEY_DISPLAY_PREFIX_PATTERN` and `SKILL_FILE_BASE64_PATTERN` |
| 11 | Three envelope spellings | ✅ |
| 12 | `COMMON_PROBLEM_CODES` maps each code to a status | ✅ |
| 13 | "Each family has its own `*_PROBLEM_CODES`" | ✏️ Only **four** families do: `AGENT_POLICY`, `FILES`, `SHARES`, `SKILLS`. The other families' codes live only in server code |
| 14 | `decide` takes `(role, method, path, ownership, scope)` → allow/deny/refuse | ✅ (`AuthorisationQuery` L95; `scope` is required and may be `null`) |
| 15 | Path grammar `/api/<resource>[/:id[/<sub>]]`, anything deeper refused | ✅ Also: `/p/…` → allow, a page → refuse, and an unclassified sub → refuse |
| 16 | GET/HEAD read; POST to runs/messages/interrupt is run; other writes are write; OPTIONS refused | ✅ Any other method string is also refused |
| 17 | Grants none/own/permitted/any; ownership own/other/unknown/not-applicable/permitted | ✅ |
| 18 | "`TOKEN_SCOPE_GRAMMAR` **refuses** … with `token_out_of_scope`" | ✏️ It returns **`deny`** with `code: 'token_out_of_scope'`, not `refuse`. It also denies the collection `GET /api/runs` for both scopes. In-grammar requests still go through the role table |
| 19 | "`permissions.ts` has 25 `RESOURCES` and `SUB_RESOURCES`, composed from `declarations/*.ts`" | ✏️ `RESOURCES` (25) is defined in **`rbac/resources.ts`** and re-exported by `permissions.ts`. `SUB_RESOURCES` = 3 §34 pairs plus **14 declared pairs from 11 files** = 17 pairs |
| 20 | `roles.ts`: an unknown role is refused, never downgraded | ✅ |
| 21 | `dominates` returns three values; "anything involving `permitted` is undecidable" | ✏️ It has three values, but `dominates(any, permitted)`, `dominates(permitted, none)` and `dominates(permitted, permitted)` all return **`dominates`**. Undecidable happens only when neither rule 1 nor 2 nor 3 applies and one side is `permitted` |
| 22 | `conferRole` requires domination on every resource × operation | ✅ It stops at the first failing cell: `does-not` → deny, `undecidable` → refuse |
| 23 | ADR-0031 (undecidable means refused), ADR-0015 (positive assertion) | ✅ The file names are `0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md` and `0015-gates-decide-on-positive-assertions.md` |
| 24 | The capability tables are derived from `decide` (W9-UI-184) and live in `projects/archive-capability.ts` and `team/{membership,invitation,team}-capability.ts` | ✅ |
| 25 | `authorisation-matrix.test.ts` and `token-scope-matrix.test.ts` are oracles | ✅ |
| 26 | `markRunning`: queued → running only | ✅ |
| 27 | `finish` rejects non-terminal; no-op when already terminal (`notInArray`) | ✅ It also revokes `run_tokens` in the same transaction and back-fills `started_at` |
| 28 | Interrupt is a control-plane transition (SDK-03-RUN-235) | ✅ The file is `SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md` |
| 29 | `workspaces/run-gate.ts` and `projects/archive-gate.ts` block new work | ✅ The refusal is reported as `unknown-principal` |
| 30 | Invitation lifecycle ADR W9-TEAM-121, constraints in `schema/invitations.ts`, state derived only in the UI (`invitationStateOf`) | ✅ The path is `apps/web/components/team/invitations-model.ts` L79. The server repository outcomes encode the same precedence, but there is no server state function |
| 31 | SDK events `parseSseFrame`, `splitSseFrames`, `classifyRunEventFrame`, `toAgentEvent[s]` | ✅ Plus `readSseFrames` |
| 32 | Server `classify*EventName`, `sseFrame`, `MAX_EVENT_ID`, `DEFAULT_RETRY_MS`; relay `SseLineSplitter`, `SseMessageAssembler`; `cursor.ts` `readResumeCursor` | ✅ Note that the server `CONTROL_FRAME_NAMES` has 4 names (with `error`) and the contract has 3 |
| 33 | `key-safety.ts` (`evaluateRelativePath`, `toObjectKey`) | ✅ Plus `toObjectPrefix` |
| 34 | `files/file-id.ts` (`encodeFileId`, `decodeFileId`) | ✅ |
| 35 | `skills/keys.ts` (`isAdmissibleRelativePath`, `createCaseFoldGuard`) | ✅ |
| 36 | `sessions/transcript.ts` (`parseSubpath`, `WINDOWS_DEVICE_NAME_PATTERN`) | ✅ |
| 37 | `packages/runtime/src/transfer.ts` (`normalizeArchivePath`; the runner's `safeWorkspacePath` no longer exists) | ✅ It decodes up to 3 times |
| 38 | `packages/runtime/src/transfer.ts` (`normalizeArchivePath`, ustar) | ✅ |
| 39 | ADRs W2-CP-03, W2-CP-04, W9-FILES-131 (case-only renames refused), 0044 | ✅ W2-CP-03 and W2-CP-04 are task prefixes with several ADRs each (e.g. `W2-CP-03-object-key-safety.md`, `W2-CP-04-file-path-admission-grammar.md`) |
| 40 | Tenancy files `scope.ts`, `object-store.ts` (`createScopedObjectStore`), `schemas.ts` (`validateTenantSessionScope`), `resources/authorise.ts` (`requireResourceAccess`), `workspaces/access.ts` | ✅ |
| 41 | `schema/tenancy.test.ts` and `scope-forgery.test.ts` are oracles | ✅ `scope-forgery.test.ts` is at `packages/core/src/db/repositories/` |
| 42 | Narrowing files `agents/policy.ts`, `compose/run-request.ts`, `core/config.ts` (`compileRunRequest`), `runtimes/network-policy.ts`, `shares/runnable/service.ts` | ✅ The persisted **file-access permission cap** lives in `packages/core/src/db/repositories/agent-resources.ts`, not in `agents/policy.ts` |
| 43 | ADRs SDK-02-AGENT-POLICY-234, W9-PROJ-125, W9-UI-133-*, W1-COMP-01 ("permissions map onto deny") | ✅ |
| 44 | Three SDK error classes | ✅ Plus the abstract base `AgentWorkspaceError` with `kind` |
| 45 | `http.ts`: headers-only deadline, `AbortSignal.any`, `Retry-After`, no automatic retry | ✅ `Retry-After` is numeric seconds only |
| 46 | `EXIT_CODE` ok 0, problem 1, usage 2, contract 3, transport 4, interrupted 130 | ✅ |
| 47 | `args.ts` `parseArguments`, `commands/index.ts` `resolveCommand` | ✅ Longest-prefix match |
| 48 | §3/§6 "the single reconnect in `follow()`" (prompt body) | ✏️ `follow()` reconnects up to **`maxReconnects` (default 5)** with `reconnectDelayMs` (default 3000). The counter is not reset, and the caller's abort ends the follow. The claim "SDK retries nothing except `follow()`" holds |
| 49 | `packages/gateway/src/pricing.ts` (`calculateUsageCost`) | ✅ |
| 50 | "`tokens/run-token.ts`" | ✏️ The path is **`packages/gateway/src/tokens/run-token.ts`**. `apps/web/server/tokens/` holds the browser-token `handlers.ts` and `runtime.ts` |
| 51 | `translate/openai*.ts` | ✅ `packages/gateway/src/translate/openai.ts`, `openai-stream.ts` |
| 52 | `core/net/egress-policy.ts` (`checkEgress`) | ✅ |
| 53 | `runs/failures.ts` (`publicRunFailure`, redaction) | ✏️ Only `publicRunFailure` exists. The redaction is its own `DomainError.publicMessage` vs `ctx.publicMessage` choice; there is no separate function |
| 54 | `models/contract.ts` (`requiredConfigFields`) | ✅ |
| 55 | CI: every workflow declares `permissions:`, `pull_request_target` banned | ✅ |
| 56 | `runs-on` must match `blacksmith-(2\|4\|8\|16\|32)vcpu-ubuntu-2404` | ✏️ The regex also allows **`ubuntu-latest`**, and it applies only to `ci.yml`, `quality.yml` and `security.yml` |
| 57 | Every `uses:` allowlisted at its SHA with a version comment | ✅ Local `./` uses are skipped |
| 58 | `fast-checks` has no services and a required step list | ✅ |
| 59 | `heavy-checks` must not `needs: fast-checks` | ✅ |
| 60 | `ci-success` has `if: always()` and needs the gate jobs | ✅ It is the **exact-line** regex `needs: [fast-checks, heavy-checks]`, so the regex itself must change to require `formal`. Since #398 it is `needs: [fast-checks, heavy-checks, formal, image-scan, generated-project-e2e]` |
| 61 | "Test that extension in `scripts/check-workflows` tests" | ✏️ The tests are in **`tests/tooling/quality-validators.test.ts`**. No `scripts/check-workflows.test.*` exists |
| 62 | "The first line of `.github/pull_request_template.md` sets the PR format" and the sections list | ✏️ Line 1 opens an HTML comment (the fail-fast contract). The sections (Ownership, Task, Spec, What changed, Acceptance, Declared gaps, Non-goals check) are ✅. The `## Task` placeholder is `W<wave>-<track>-<nn> · <title> · precision level PL-<n>`, so `FORMAL-P<n>-<nn> · <title>` departs from it and needs the programme ADR to say so |
| 63 | §2 table: "latest `migrations/meta/*_snapshot.json`" | ✏️ This is the repo-root `migrations/meta/0025_snapshot.json`, not under `packages/core` |
| 64 | §2 table: `packages/sdk/src/{…,testing}.ts` and `packages/aw/src/{args,config,inputs,output,stream,main}.ts` | ✅ All present |
| 65 | §6 T5 example: "the §3.3 table gives Admin `none` on skills and files while Builder has `read any`" | ✅ Admin also has `none` on **projects**, where Builder has `own`. Since ADR-0116 Admin holds skills and files as `EVERYTHING`; only the `projects` gap remains |
