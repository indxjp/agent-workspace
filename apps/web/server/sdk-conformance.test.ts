/**
 * The seam between the control plane and `@indx-workspace/contracts`.
 *
 * The contracts package states what crosses the wire; the application's serializers are what
 * actually cross it. This gate holds the two together from the application's side: every value
 * a real serializer renders must satisfy the schema the SDK validates against, and every
 * vocabulary the server restates (run statuses, providers, accounting states, reserved event
 * names) must equal the one the contracts publish. It fails when either side drifts, which is the
 * point — `docs/sdk/03-sdk-design.md` makes this test the condition for consuming a domain
 * through the SDK rather than through the application's own parsers.
 *
 * It lives in the application rather than in a package because it is the application's promise:
 * `packages/*` may not import an application, and these serializers resolve under the web app's
 * own compiler settings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { negotiateContractsVersion, servedContractsHeaders } from './versioning/contracts-version';

import os from 'node:os';
import path from 'node:path';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';
import {
  ApiProblemDetailSchema,
  ApiProblemSchema,
  COMMON_PROBLEM_CODES,
  CONTRACTS_VERSION,
} from '@indx-workspace/contracts';
import {
  ApiProblemError,
  ContractsVersionUnsupportedError,
  createClient,
} from '@indx-workspace/sdk';
import {
  AgentGrantsSchema,
  AgentPolicySchema,
  AgentResourceSchema,
} from '@indx-workspace/contracts/agents';
import {
  API_KEY_ID_LENGTH,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  ApiKeyListResponseSchema,
  ApiKeyResourceSchema,
  ApiKeyResponseSchema,
  MintedApiKeyResponseSchema,
} from '@indx-workspace/contracts/api-keys';
import {
  CONNECTOR_NAME_MAX_LENGTH,
  CONNECTOR_REQUEST_BODY_MAX_BYTES,
  CONNECTORS_PROBLEM_CODES,
  ConnectorListResponseSchema,
  type ConnectorResource,
  type McpConnectorResource,
  ConnectorResourceSchema,
  TEST_CONNECTION_FAILURE_KINDS,
  type TestConnectionOutcome,
  TestConnectionOutcomeSchema,
  isMcpConnectorResource,
} from '@indx-workspace/contracts/connectors';
import {
  FileListResponseSchema,
  FileResponseSchema,
  fileRouteId,
  FILES_PROBLEM_CODES,
  MAX_SUBTREE_OBJECTS,
  MAX_UPLOAD_BYTES,
  MoveFileResponseSchema,
  SubtreeDeleteOutcomeSchema,
} from '@indx-workspace/contracts/files';
import {
  AcceptedInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationResourceSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
} from '@indx-workspace/contracts/invitations';
import {
  DeleteModelConnectionResponseSchema,
  DISCOVERED_MODEL_CAPABILITY_KEYS,
  DiscoveredModelCapabilitiesSchema,
  DiscoveredModelsResponseSchema,
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
} from '@indx-workspace/contracts/models';
import {
  AUDIT_ACTIONS,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AuditEventListResponseSchema,
  RunTelemetryListResponseSchema,
} from '@indx-workspace/contracts/observability';
import {
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
} from '@indx-workspace/contracts/projects';
import {
  AGENT_FRAME_NAMES,
  AGENT_FRAME_RAW_MAX_BYTES,
  AGENT_STOP_REASONS,
  AGENT_TOOL_KINDS,
  AgentFrameSchema,
  CONTROL_FRAME_NAMES,
  RELAYED_EVENT_NAMES,
  RUN_STATUS_EVENT,
} from '@indx-workspace/contracts/run-events';
import {
  ENGINE_IDS,
  ENGINE_PROBLEM_CODES,
  EngineCapabilitiesSchema,
  EngineCapabilityKeySchema,
  EngineListResponseSchema,
} from '@indx-workspace/contracts/engines';
import { PlatformListResponseSchema } from '@indx-workspace/contracts/platforms';
import {
  ACCOUNTING_STATES,
  InterruptRunResponseSchema,
  MAX_PROMPT_CHARS,
  MODEL_PROVIDERS,
  RevokeRunTokensResponseSchema,
  RUN_LIST_MAX_LIMIT,
  RUN_STATUSES,
  RUN_START_PROBLEM_CODES,
  RunResourceSchema,
  StartRunRequestSchema,
} from '@indx-workspace/contracts/runs';
import { enforceCeiling } from './policy-ceiling/ceiling';
import { recordingCeilingFor } from './policy-ceiling/fixtures';
import {
  type CreateRuntimeConnectionInput,
  type CreateRuntimeProfileInput,
  RUNTIME_DRIVERS,
  RUNTIME_FILESYSTEM_MODES,
  RUNTIME_NETWORK_POLICIES,
  RUNTIME_PROFILE_BOUNDS,
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
  type UpdateRuntimeProfilePatch,
} from '@indx-workspace/contracts/runtimes';
import {
  SECRET_NAME_MAX_LENGTH,
  SECRET_NAME_PATTERN,
  SECRET_VALUE_MAX_LENGTH,
  SecretListResponseSchema,
  SecretResourceSchema,
} from '@indx-workspace/contracts/secrets';
import {
  PROJECT_KEY_PATTERN,
  SESSION_STATUSES,
  SessionResourceSchema,
  SessionResponseSchema,
  TRANSCRIPT_SUBPATH_MAX_LENGTH,
  TRANSCRIPT_SUBPATH_PATTERN,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
} from '@indx-workspace/contracts/sessions';
import {
  type PublishShareCommand,
  SHARE_EXPIRIES,
  SHARE_MODES,
  SHARE_PASSPHRASE_MAX_LENGTH,
  SHARE_SUBJECT_TYPES,
  SHARE_VISIBILITIES,
  ShareListItemSchema,
  ShareListResponseSchema,
  ShareResourceSchema,
} from '@indx-workspace/contracts/shares';
import {
  SKILL_NAME_PATTERN,
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SKILLS_PROBLEM_CODES,
  type SkillsProblemCode,
} from '@indx-workspace/contracts/skills';
import {
  CreatedUserResponseSchema,
  MEMBERSHIP_ROLES,
  MembershipListResponseSchema,
  MembershipResponseSchema,
  MeResponseSchema,
  PRINCIPAL_KINDS as WIRE_PRINCIPAL_KINDS,
  type PrincipalKindName,
  USER_EMAIL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  UserListResponseSchema,
  UserResourceSchema,
} from '@indx-workspace/contracts/team';
import {
  RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS,
  RunFeedbackRequestSchema,
} from '@indx-workspace/contracts/feedback';
import {
  BROWSER_TOKEN_PATTERN,
  MintTokenRequestSchema,
  MintTokenResponseSchema,
} from '@indx-workspace/contracts/tokens';
import {
  SharingPolicySchema,
  WorkspaceSwitchResponseSchema,
} from '@indx-workspace/contracts/workspaces';
import {
  CreateRuntimeProfileInput as CoreCreateRuntimeProfileInputSchema,
  runtimeDriverIds,
  AGENT_FRAME_RAW_MAX_BYTES as CORE_AGENT_FRAME_RAW_MAX_BYTES,
  agentFrameNames as coreAgentFrameNames,
  agentStopReasons as coreAgentStopReasons,
  agentToolKinds as coreAgentToolKinds,
  classifySdkEvent,
  toAgentFrames,
} from '@agent-workspace/core';
import {
  type AgentRepository,
  type AuditEventRepository,
  type AuditEventRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
  engineIds as schemaEngineIds,
  RUN_FEEDBACK_COMMENT_MAX_LENGTH as CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS as CORE_RUN_FEEDBACK_RATINGS,
  type ProjectFileRepository,
  type ProjectMcpServerRepository,
  type ProjectRecord,
  type ProjectRepository,
  type SessionRecord,
  type SessionRepository,
  type ShareRecord,
} from '@agent-workspace/core/db';
import { auditActions as serverAuditActions } from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';
import { classifyRunEventFrame, parseSseFrame } from '@indx-workspace/sdk/events';
import { mkdtemp, rm } from 'node:fs/promises';

import { GET as getAuditEvents } from '../app/api/audit-events/route';
import { GET as getMetrics } from '../app/api/metrics/route';
import { POST as postProjectSession } from '../app/api/projects/[id]/sessions/route';
import { POST as switchWorkspaceRoute } from '../app/api/auth/workspace/route';
import { POST as mintTokenRoute } from '../app/api/tokens/route';
import { toShareResource } from '../app/api/shares/route';
import {
  GET as readSharingPolicy,
  PATCH as patchSharingPolicy,
} from '../app/api/sharing-policies/route';
import { toAgentResource } from './agents/contract';
import { problem } from './agents/handlers';
import { compiledPolicyFor, policyFor } from './agents/policy';
import { clearAuditRuntime, configureAuditRuntime } from './audit/runtime';
import { keysetPageOf } from './pagination/testing';
import { listEngines } from './engines/handlers';
import { listPlatforms } from './platforms/catalogue';
import { clearEnginesRegisteredForTests, registerEngineForTests } from './engines/registry';
import {
  mintSessionToken,
  newSessionClaims,
  sessionCookieName,
  verifySessionToken,
} from './auth/session';
import { FAILURE_KINDS as SERVER_FAILURE_KINDS } from './connectors/classify';
import {
  type ConnectorResource as ServerConnectorResource,
  parseCreateConnectorBody,
} from './connectors/contract';
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  rotateConnectorCredential,
  testConnectionSaved,
} from './connectors/handlers';
import { readConnectorBody } from './connectors/http';
import { createInMemoryConnectorsStoreProvider } from './connectors/memory-store';
import { type TestConnectionOutcome as ServerTestConnectionOutcome } from './connectors/test-connection';
import { DomainError } from './errors';
import { encodeFileId } from './files/file-id';
import {
  type ApiResult,
  createFolder,
  deleteSubtree,
  downloadFile,
  listFiles,
  MAX_SUBTREE_OBJECTS as SERVER_MAX_SUBTREE_OBJECTS,
  moveSubtree,
  renameFile,
  requireFilePath,
  uploadFile,
} from './files/handlers';
import { MAX_UPLOAD_BYTES as SERVER_MAX_UPLOAD_BYTES, toResponse } from './files/http';
import {
  createLocalFilesystemObjectStoreProvider,
  type ObjectStore,
} from './files/object-store-bridge';
import { errorResponse } from './http/error-response';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from './invitations/handlers';
import { type InvitationsRuntime } from './invitations/runtime';
import { createManualLinkInvitationSender } from './invitations/send-invitation';
import {
  parseCreateModelConnection,
  requiredConfigFields,
  toModelConnectionResource,
} from './models/contract';
import { createModelDiscovery } from './models/discovery';
import {
  createModelConnection,
  deleteModelConnection,
  listDiscoveredModels,
  listModelConnections,
  rotateModelConnectionCredential,
  testModelConnection,
} from './models/handlers';
import { createInMemoryModelsStoreProvider } from './models/memory-store';
import { probeModelConnection } from './models/probe';
import { toProjectResource } from './projects/resource';
import { clearProjectsRuntime, configureProjectsRuntime } from './projects/runtime';
import {
  API_KEY_PREFIX as SERVER_API_KEY_PREFIX,
  KEY_ID_LENGTH as SERVER_KEY_ID_LENGTH,
  SECRET_LENGTH as SERVER_SECRET_LENGTH,
} from './rbac/api-key';
import { type ApiKeySummary, type UserSummary } from './rbac/directory';
import {
  changeMembershipRole,
  createApiKey,
  createMembership,
  createUser,
  deleteMembership,
  listApiKeys,
  listMemberships,
  listUsers,
  readMe,
  revokeApiKey,
  wireKind,
  type WirePrincipalKind,
} from './rbac/handlers';
import { mintBrowserToken } from './rbac/browser-token';
import { problem as rbacProblem } from './rbac/http';
import { createMemoryDirectory } from './rbac/memory-directory';
import { Principal, PRINCIPAL_KINDS as SERVER_PRINCIPAL_KINDS } from './rbac/principal';
import { ROLES } from './rbac/roles';
import { clearTokensRuntime, configureTokensRuntime } from './tokens/runtime';
import {
  clearWorkspacesRuntime,
  configureWorkspacesRuntime,
  type WorkspaceRepositoryPort,
} from './workspaces/runtime';
import { clearRbacRuntime, configureRbacRuntime } from './rbac/runtime';
import { installRbacHarness, TEST_WORKSPACE_ID } from './rbac/testing';
import {
  MAX_PROMPT_CHARS as SERVER_MAX_PROMPT_CHARS,
  parseStartRunBody,
  renderRun,
  startRun,
} from './runs/api';
import { InMemoryRunStore } from './runs/store';
import { installRunApi, resetRunApi } from './runs/environment';
import { engineCapabilityRefusal } from './agents/policy';
import {
  classifyEventName,
  CONTROL_FRAME_NAMES as SERVER_CONTROL_FRAME_NAMES,
  RUN_STATUS_EVENT as SERVER_RUN_STATUS_EVENT,
  sseControlFrame,
  sseFrame,
} from './runs/sse';
import { accountingStates, MAX_RUN_LIST_LIMIT, type RunRecord, runStatuses } from './runs/store';
import {
  createInMemoryRuntimeConnectionStoreProvider,
  createRuntimeConnection,
  listRuntimeConnections,
  toRuntimeConnectionResource,
} from './runtimes/connections';
import {
  parseCreateRuntimeProfileInput,
  parseUpdateRuntimeProfilePatch,
  toRuntimeProfileResource,
} from './runtimes/contract';
import { createRuntimeProfile, listRuntimeProfiles } from './runtimes/handlers';
import { createInMemoryRuntimeProfileStoreProvider } from './runtimes/memory-store';
import { type RuntimeProfileRecord } from './runtimes/store';
import {
  parseCreateSecretBody,
  parseReplaceSecretBody,
  SECRET_NAME_PATTERN as SERVER_SECRET_NAME_PATTERN,
  SECRET_VALUE_MAX_LENGTH as SERVER_SECRET_VALUE_MAX_LENGTH,
  toSecretResource,
} from './secrets/contract';
import { createSecret, listSecrets, replaceSecret } from './secrets/handlers';
import { createInMemorySecretsStoreProvider } from './secrets/memory-store';
import { listTranscriptSubkeys, loadTranscript, serializeSession } from './sessions/api';
import { installSessionApi, resetSessionApi } from './sessions/environment';
import { InMemoryTranscriptStore } from './sessions/memory-store';
import {
  MAX_SUBPATH_LENGTH as SERVER_MAX_SUBPATH_LENGTH,
  PROJECT_KEY_PATTERN as SERVER_PROJECT_KEY_PATTERN,
  SUBPATH_PATTERN as SERVER_SUBPATH_PATTERN,
} from './sessions/transcript';
import { parsePublishShareRequest, PublishShareRequestSchema } from './shares/core/input';
import {
  clearSharesRuntime,
  configureSharesRuntime,
  type WorkspaceSharing,
} from './shares/core/runtime';
import {
  exportSkill,
  getSkill,
  importSkill,
  listSkills,
  patchSkill,
  requireSkillName,
} from './skills/handlers';
import { isValidSkillName } from './skills/keys';
import { recentRunTelemetry, recordRunTelemetry } from './telemetry/runtime';
import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionCheckResponseSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  CreateAgentFromVersionResponseSchema,
  SetAgentPointerResponseSchema,
  ToolBundleResponseSchema,
  UploadToolBundleResponseSchema,
} from '@indx-workspace/contracts/agent-versions';
import { getToolBundle, uploadToolBundle } from './tool-bundles/handlers';
import { toAgentVersionListResponse, toAgentVersionResource } from './agent-versions/contract';
import { createAgentFromVersion } from './agent-versions/create-from-version';
import {
  FIXTURE_POLICY,
  fixtureSurface,
  fromVersionRequest,
  versionRequest,
} from './agent-versions/fixtures';
import { createAgentVersion } from './agent-versions/handlers';
import { createInMemoryAgentStoreProvider } from './agents/memory-store';
import { createInMemoryAgentVersionStoreProvider } from './agent-versions/memory-store';
import { setAgentPointer } from './agent-versions/pointers';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const AGENT = '11111111-1111-4111-8111-111111111111';
const SESSION = '55555555-5555-4555-8555-555555555555';

describe('runs', () => {
  const queued: RunRecord = {
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
    status: 'queued',
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
    startedAt: null,
    endedAt: null,
    error: null,
  };

  it('renders a minimal record and a fully settled one into the published shape', () => {
    expect(RunResourceSchema.safeParse(renderRun(queued)).success).toBe(true);
    const settled: RunRecord = {
      ...queued,
      status: 'failed',
      startedAt: new Date('2026-09-21T10:00:01.000Z'),
      endedAt: new Date('2026-09-21T10:00:05.500Z'),
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      modelConnectionId: '22222222-2222-4222-8222-222222222222',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 1,
      toolCalls: 2,
      costUsd: '0.001234',
      costCurrency: 'USD',
      priceTableVersion: '2026-09',
      error: 'The runtime exited.',
      accountingState: 'failed',
      accountingError: 'ledger: relation "x" does not exist',
      projectId: '66666666-6666-4666-8666-666666666666',
      initiatingUserId: '77777777-7777-4777-8777-777777777777',
    };
    const parsed = RunResourceSchema.parse(renderRun(settled));
    expect(parsed.durationMs).toBe(4500);
    expect(parsed.usage.totalTokens).toBe(36);
    // The redacted accounting failure is the contract; the raw ledger cause never crosses.
    expect(parsed.accountingError).not.toContain('relation');
  });

  it('pins run_feedback’s rating set and comment cap to RunFeedbackRequestSchema (issue #539)', () => {
    // `packages/core` may not import the contracts, so the table restates both; same watcher as
    // `engineIds` below. The contract's `rating` enum is built from `RUN_FEEDBACK_RATINGS`.
    expect([...CORE_RUN_FEEDBACK_RATINGS]).toEqual([...RUN_FEEDBACK_RATINGS]);
    expect(CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH).toBe(RUN_FEEDBACK_COMMENT_MAX_LENGTH);
    const comment = (length: number) => ({ rating: 'up', comment: 'c'.repeat(length) });
    expect(
      RunFeedbackRequestSchema.safeParse(comment(CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH)).success,
    ).toBe(true);
    expect(
      RunFeedbackRequestSchema.safeParse(comment(CORE_RUN_FEEDBACK_COMMENT_MAX_LENGTH + 1)).success,
    ).toBe(false);
  });

  it('shares the run vocabulary and the list/prompt bounds with the server', () => {
    expect([...runStatuses]).toEqual([...RUN_STATUSES]);
    // ADR-0136: the database's engine list is `ENGINE_IDS` itself, not a restatement.
    expect(schemaEngineIds).toBe(ENGINE_IDS);
    // ENG-03 (#302): `packages/core` also restates the neutral frame vocabulary, because
    // `toAgentFrames` lives beside the Claude classification and cannot import the contracts. Same
    // rule, same watcher — and the raw cap too, since the contract publishes the number a consumer
    // reads while core is the side that applies it.
    expect([...coreAgentFrameNames]).toEqual([...AGENT_FRAME_NAMES]);
    expect([...coreAgentToolKinds]).toEqual([...AGENT_TOOL_KINDS]);
    expect([...coreAgentStopReasons]).toEqual([...AGENT_STOP_REASONS]);
    expect(CORE_AGENT_FRAME_RAW_MAX_BYTES).toBe(AGENT_FRAME_RAW_MAX_BYTES);
    // And every frame the Claude mapping produces satisfies the published union — the hole the
    // restatement opens, closed by a test rather than left to a comment (see `core/src/types.ts`).
    for (const message of [
      { type: 'system', subtype: 'init', session_id: 'sess_1' },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1' }] } },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: { m: { inputTokens: 1, outputTokens: 2 } },
      },
      { type: 'system', subtype: 'status' },
      'not an object',
    ]) {
      for (const frame of toAgentFrames(classifySdkEvent(message))) {
        const parsed = AgentFrameSchema.safeParse(frame);
        expect(parsed.success, `${frame.frame}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
          true,
        );
      }
    }
    expect([...accountingStates]).toEqual([...ACCOUNTING_STATES]);
    expect(SERVER_MAX_PROMPT_CHARS).toBe(MAX_PROMPT_CHARS);
    expect(MAX_RUN_LIST_LIMIT).toBe(RUN_LIST_MAX_LIMIT);
  });

  it('renders the interrupted run through renderRun into InterruptRunResponseSchema (issue #235, S-14)', () => {
    const cancelled: RunRecord = {
      ...queued,
      status: 'cancelled',
      startedAt: new Date('2026-09-21T10:00:01.000Z'),
      endedAt: new Date('2026-09-21T10:00:02.000Z'),
      error: 'the run was interrupted by request',
    };
    expect(InterruptRunResponseSchema.safeParse({ run: renderRun(cancelled) }).success).toBe(true);
  });

  it('publishes RevokeRunTokensResponseSchema for the repository’s own outcome vocabulary (issue #235, S-15)', () => {
    for (const outcome of ['revoked', 'already-revoked', 'not-found'] as const) {
      expect(
        RevokeRunTokensResponseSchema.safeParse({ revoked: outcome === 'revoked' ? 1 : 0, outcome })
          .success,
      ).toBe(true);
    }
  });

  it('accepts a start-run body as the SDK sends it, and rejects what the SDK rejects', () => {
    const bodies: readonly unknown[] = [
      { prompt: 'hello', sessionId: null, modelConnectionId: null, model: null },
      { prompt: 'hello', sessionId: SESSION, modelConnectionId: null, model: null },
      {
        prompt: 'hello',
        sessionId: null,
        modelConnectionId: '22222222-2222-4222-8222-222222222222',
        model: 'claude-sonnet-5',
      },
      { prompt: '   ' },
      { prompt: 'hello', model: 'alone' },
      { prompt: 'hello', sessionId: 'latest' },
      { prompt: 'hello', unknown: 1 },
      { prompt: 'hello', sessionId: null, modelConnectionId: null, model: null, version: 2 },
      { prompt: 'hello', version: 0 },
      { prompt: 'hello', version: 1.5 },
      { prompt: 'hello', version: '2' },
      { prompt: 'hello', sessionId: SESSION, version: 2 },
    ];
    for (const body of bodies) {
      expect(
        parseStartRunBody(body).kind === 'ok',
        `server and contract disagree on ${JSON.stringify(body)}`,
      ).toBe(StartRunRequestSchema.safeParse(body).success);
    }
  });
});

describe('run events', () => {
  it('reserves the same names as the server, minus the one it never emits', () => {
    expect(SERVER_RUN_STATUS_EVENT).toBe(RUN_STATUS_EVENT);
    expect(SERVER_CONTROL_FRAME_NAMES.filter((name) => name !== 'error')).toEqual([
      ...CONTROL_FRAME_NAMES,
    ]);
    for (const name of RELAYED_EVENT_NAMES) {
      expect(classifyEventName(name).kind, `${name} must be relayable`).toBe('ok');
    }
  });

  it('parses every frame the server writes into the classification the SDK publishes', () => {
    const status = parseSseFrame(
      sseFrame({ id: 7n, type: RUN_STATUS_EVENT, data: { status: 'running', error: null } }),
    );
    expect(status).not.toBeNull();
    expect(classifyRunEventFrame(status ?? { event: '', id: null, data: null })).toEqual({
      kind: 'run-status',
      id: '7',
      data: { status: 'running', error: null },
    });

    const relayed = parseSseFrame(
      sseFrame({ id: 8n, type: 'sdk-event', data: { kind: 'event', type: 'assistant' } }),
    );
    expect(classifyRunEventFrame(relayed ?? { event: '', id: null, data: null })).toEqual({
      kind: 'runtime',
      id: '8',
      name: 'sdk-event',
      data: { kind: 'event', type: 'assistant' },
    });

    const failed = parseSseFrame(
      sseControlFrame({ name: 'run-failed', data: { status: 'failed', message: 'x' } }),
    );
    expect(classifyRunEventFrame(failed ?? { event: '', id: null, data: null })).toEqual({
      kind: 'run-failed',
      data: { status: 'failed', message: 'x' },
    });

    const reset = parseSseFrame(
      sseControlFrame({ name: 'stream-reset', data: { reason: 'retention', resumedAfter: null } }),
    );
    expect(classifyRunEventFrame(reset ?? { event: '', id: null, data: null })).toEqual({
      kind: 'stream-reset',
      data: { reason: 'retention', resumedAfter: null },
    });

    const done = parseSseFrame(sseControlFrame({ name: 'done', data: null }));
    expect(classifyRunEventFrame(done ?? { event: '', id: null, data: null })).toEqual({
      kind: 'done',
    });
  });
});

describe('agents and projects', () => {
  it('renders the grants route body as the strict principal-id contract', () => {
    const body = { principalIds: ['77777777-7777-4777-8777-777777777777'] };
    expect(AgentGrantsSchema.parse(body)).toEqual(body);
  });

  it('serialises an agent record into the published shape', () => {
    const resource = toAgentResource({
      id: AGENT,
      workspaceId: WORKSPACE,
      name: 'Support',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      policy: null,
      createdBy: null,
      ownerPrincipalId: 'principal-1',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    });
    expect(AgentResourceSchema.safeParse(resource).success).toBe(true);
  });

  it('serialises the compiled policy (NULL column) into the published AgentPolicy shape (S-13)', () => {
    const compiled = compiledPolicyFor(
      { readFiles: true, writeFiles: false, runCommands: false, unrestrictedNetwork: true },
      ['triage'],
    );
    const parsed = AgentPolicySchema.safeParse(compiled);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it('serialises a stored policy through policyFor into the published AgentPolicy shape (S-13)', () => {
    const stored = {
      engine: 'claude-agent-sdk' as const,
      tools: {
        base: 'claude_code_preset' as const,
        autoApprove: ['mcp__github__*'],
        deny: ['Bash'],
        permissionMode: 'default' as const,
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'all' as const },
      limits: { maxTurns: 25, maxBudgetUsd: 10 },
    };
    const agent = {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: 'Support',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      policy: stored,
      createdBy: null,
      ownerPrincipalId: 'principal-1',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    };
    const served = policyFor(agent, []);
    expect(served).toEqual(stored);
    const parsed = AgentPolicySchema.safeParse(served);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it('serialises a project record into the published shape', () => {
    const resource = toProjectResource(
      {
        id: '66666666-6666-4666-8666-666666666666',
        workspaceId: WORKSPACE,
        name: 'Ops',
        instructions: null,
        defaultAgentId: AGENT,
        defaultModelConnectionId: null,
        defaultModel: null,
        visibility: 'workspace',
        createdBy: null,
        ownerPrincipalId: 'principal-1',
        archivedAt: new Date('2026-09-21T11:00:00.000Z'),
        createdAt: new Date('2026-09-21T10:00:00.000Z'),
        updatedAt: new Date('2026-09-21T10:00:00.000Z'),
      },
      ['f1'],
      [],
    );
    expect(ProjectResourceSchema.safeParse(resource).success).toBe(true);
  });
});

describe('engines (issue #319, ENG-02c)', () => {
  afterEach(clearEnginesRegisteredForTests);

  it('renders the real registry through listEngines into the published catalogue', () => {
    const result = listEngines();

    expect(result.status).toBe(200);
    const parsed = EngineListResponseSchema.parse(result.body);
    // The acceptance criterion, against the body the route actually produces.
    expect(parsed.engines).toEqual([
      expect.objectContaining({
        id: 'claude-agent-sdk',
        installed: true,
        capabilities: expect.objectContaining({ wireProtocols: ['anthropic-messages'] }) as unknown,
      }),
      // Registered since ENG-09 (#308); not installed under the development image map (ADR-0073).
      expect.objectContaining({
        id: 'openai-agents',
        installed: false,
        capabilities: expect.objectContaining({
          maxBudget: 'adapter',
          wireProtocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
        }) as unknown,
      }),
      // Registered since ENG-08 (#307); not installed under the development image map either.
      expect.objectContaining({
        id: 'pi',
        installed: false,
        capabilities: expect.objectContaining({
          mcp: false,
          maxTurns: 'adapter',
          wireProtocols: ['anthropic-messages'],
        }) as unknown,
      }),
      // Registered since ENG-10 (#309); not installed under the development image map either.
      expect.objectContaining({
        id: 'mastra',
        installed: false,
        capabilities: expect.objectContaining({
          mcp: true,
          fork: false,
          maxTurns: 'native',
          wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
        }) as unknown,
      }),
    ]);
  });

  it('keeps the served catalogue inside the ids the contracts publish', () => {
    for (const engine of EngineListResponseSchema.parse(listEngines().body).engines) {
      expect(ENGINE_IDS as readonly string[]).toContain(engine.id);
    }
  });

  it('answers a registry the contract cannot express as a published problem, not a short list', () => {
    registerEngineForTests({
      id: 'not-an-engine-the-contracts-publish',
      displayName: 'Test engine',
      version: '0.0.0',
      capabilities: EngineCapabilitiesSchema.parse({
        mcp: false,
        skills: false,
        subagents: false,
        resume: false,
        fork: false,
        interrupt: false,
        streamingText: false,
        reasoning: false,
        maxTurns: 'adapter',
        maxBudget: 'none',
        wireProtocols: ['anthropic-messages'],
      }),
    });

    const result = listEngines();

    expect(result.status).toBe(ENGINE_PROBLEM_CODES.engine_catalogue_invalid);
    expect(ApiProblemSchema.parse(result.body).error.code).toBe('engine_catalogue_invalid');
  });
});

describe('platforms (issue #968)', () => {
  it('renders every registered target into the published catalogue', () => {
    const parsed = PlatformListResponseSchema.parse(listPlatforms().body);

    expect(parsed.platforms.map((platform) => platform.id)).toStrictEqual(
      PLATFORM_TARGETS.map((target) => target.id),
    );
  });
});

describe('problems', () => {
  it('renders a handler problem and a domain error as the one published envelope', async () => {
    expect(
      ApiProblemSchema.safeParse(problem(400, 'invalid_field', 'Bad.', ['name']).body).success,
    ).toBe(true);
    expect(ApiProblemSchema.safeParse(problem(404, 'agent_not_found', 'Gone.').body).success).toBe(
      true,
    );

    const domain = errorResponse(
      new DomainError({ category: 'conflict', code: 'name_conflict', publicMessage: 'Taken.' }),
      { component: 'test', operation: 'conflict', log: () => undefined },
    );
    expect(domain.status).toBe(409);
    expect(ApiProblemSchema.parse(await domain.json()).error.code).toBe('name_conflict');
  });

  /**
   * ADR-0065's two enforcement refusals, from the real handlers, against the published envelope and
   * the published status table (ENG-02b, #318). The point of testing them here rather than only at
   * the routes is drift: `ENGINE_PROBLEM_CODES` is what an SDK consumer branches on, and a route
   * that answered the same code under a different status would still pass its own suite.
   */
  describe('engine refusals', () => {
    const ENGINE_AGENT = '33333333-3333-4333-8333-333333333333';
    const ENGINE_SESSION = '44444444-4444-4444-8444-444444444444';

    afterEach(() => {
      resetRunApi();
      clearEnginesRegisteredForTests();
    });

    it('renders session_engine_mismatch from the real run route as the published envelope', async () => {
      installRunApi({
        authenticate: () =>
          Promise.resolve({
            principalId: '77777777-7777-4777-8777-777777777777',
            ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
            userId: '66666666-6666-4666-8666-666666666666',
            workspaceId: WORKSPACE,
            role: 'owner' as const,
            scope: null,
          }),
        findAgent: (principal, agentId) =>
          Promise.resolve(
            agentId === ENGINE_AGENT
              ? // A test-only engine: the only way two engine ids can differ while `ENGINE_IDS`
                // publishes one member.
                { id: ENGINE_AGENT, workspaceId: principal.workspaceId, engine: 'test-only-engine' }
              : null,
          ),
        openSession: () =>
          Promise.resolve({
            id: ENGINE_SESSION,
            agentId: ENGINE_AGENT,
            engine: 'claude-agent-sdk',
          }),
        ownsRun: () => Promise.resolve(true),
        store: new InMemoryRunStore(),
        launch: () => undefined,
      });

      const response = await startRun(
        new Request(`http://web/api/agents/${ENGINE_AGENT}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'hi', sessionId: ENGINE_SESSION }),
        }),
        ENGINE_AGENT,
      );

      const envelope = ApiProblemSchema.parse(await response.json());
      expect(envelope.error.code).toBe('session_engine_mismatch');
      expect(response.status).toBe(ENGINE_PROBLEM_CODES.session_engine_mismatch);
    });

    it('renders engine_capability_unsupported as the published envelope, details being the capability', () => {
      registerEngineForTests({
        id: 'claude-agent-sdk',
        displayName: 'Claude Agent SDK (test: no MCP)',
        version: 'test',
        capabilities: {
          mcp: false,
          skills: true,
          subagents: false,
          resume: true,
          fork: false,
          interrupt: true,
          streamingText: false,
          reasoning: true,
          maxTurns: 'native',
          maxBudget: 'native',
          wireProtocols: ['anthropic-messages'],
        },
      });
      const refusal = engineCapabilityRefusal('claude-agent-sdk', {
        connectors: true,
        skills: false,
      });
      expect(refusal).not.toBeNull();
      if (refusal === null) return;
      const envelope = ApiProblemSchema.parse(refusal.body);
      expect(envelope.error.code).toBe('engine_capability_unsupported');
      expect(refusal.status).toBe(ENGINE_PROBLEM_CODES.engine_capability_unsupported);
      // Exactly one detail, and it is a capability the contract publishes — not prose a client
      // would have to parse.
      expect(envelope.error.details).toHaveLength(1);
      expect(EngineCapabilityKeySchema.parse(envelope.error.details?.[0])).toBe('mcp');
    });
  });

  it('renders the RBAC layer’s problems in the standard envelope, with detail as a deprecated duplicate', () => {
    const body = rbacProblem(409, 'last_owner', 'The last owner cannot leave.').body;
    const parsed = ApiProblemSchema.parse(body);
    expect(parsed.error.code).toBe('last_owner');
    expect(parsed.error.message).toBe('The last owner cannot leave.');
    expect(parsed.error.detail).toBe(parsed.error.message);
    // The detail-only schema now describes only what an older deployment answers.
    expect(ApiProblemDetailSchema.safeParse(body).success).toBe(false);
  });

  it('never lets an infrastructure cause cross, and uses a common code the contract knows', async () => {
    const response = errorResponse(new Error('relation "runs" does not exist'), {
      component: 'test',
      operation: 'boom',
      log: () => undefined,
    });
    const envelope = ApiProblemSchema.parse(await response.json());
    expect(envelope.error.message).not.toContain('relation');
    expect(COMMON_PROBLEM_CODES[envelope.error.code as keyof typeof COMMON_PROBLEM_CODES]).toBe(
      response.status,
    );
  });
});

describe('models', () => {
  const MODELS_WORKSPACE = '88888888-8888-4888-8888-888888888888';
  // TEST-NET-3 literals over https: the egress policy needs no DNS for them and does not block
  // them, so the real parser, probe and discovery adapters run end to end against a fetch double.
  const REACHABLE_BASE_URL = 'https://203.0.113.10/v1';
  const FAILING_BASE_URL = 'https://203.0.113.11/v1';
  const PROVIDER_KEY = 'Provider-Key-Must-Never-Escape';

  const modelsStore = () =>
    createInMemoryModelsStoreProvider([MODELS_WORKSPACE]).forWorkspace(MODELS_WORKSPACE);

  const providerFetch: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url.startsWith(FAILING_BASE_URL)
        ? Response.json({ error: 'boom' }, { status: 500 })
        : Response.json({ data: [{ id: 'llama-3-70b', created: 0 }] }),
    );
  };

  const createdResource = async (
    store: ReturnType<typeof modelsStore>,
    name: string,
    baseUrl: string,
  ) => {
    const created = await createModelConnection(store, {
      name,
      provider: 'openai-compatible',
      apiKey: PROVIDER_KEY,
      config: { baseUrl },
    });
    expect(created.status).toBe(201);
    return ModelConnectionResourceSchema.parse(created.body);
  };

  it('renders the server resource into the published shape, without the credential', () => {
    const record = {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: MODELS_WORKSPACE,
      name: 'Anthropic',
      provider: 'anthropic' as const,
      config: {},
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    };
    const bare = ModelConnectionResourceSchema.parse(toModelConnectionResource(record, true));
    expect(bare.ready).toBe(true);
    const azure = ModelConnectionResourceSchema.parse(
      toModelConnectionResource(
        {
          ...record,
          provider: 'azure-openai',
          config: { baseUrl: 'https://example.openai.azure.com', apiVersion: '2024-10-21' },
        },
        true,
      ),
    );
    // A credential with an incomplete config is not ready — the contract's own definition.
    expect(azure.ready).toBe(false);
    expect(JSON.stringify(azure)).not.toContain(PROVIDER_KEY);
  });

  it('restates the same providers and config rules as the contract', async () => {
    const sample = { baseUrl: 'https://provider.example', deployment: 'd', apiVersion: 'v' };
    const acceptedConfig = async (provider: (typeof MODEL_PROVIDERS)[number], config: unknown) =>
      (
        await parseCreateModelConnection({ name: 'n', provider, apiKey: 'k', config }, () =>
          Promise.resolve({ ok: true }),
        )
      ).ok;
    for (const provider of MODEL_PROVIDERS) {
      const rule = MODEL_PROVIDER_CONFIG_RULES[provider];
      expect([...requiredConfigFields(provider)]).toEqual([...rule.required]);
      const required = Object.fromEntries(rule.required.map((field) => [field, sample[field]]));
      expect(await acceptedConfig(provider, required), `${provider}: required`).toBe(true);
      for (const field of MODEL_CONNECTION_CONFIG_FIELDS) {
        expect(
          await acceptedConfig(provider, { ...required, [field]: sample[field] }),
          `${provider}: ${field}`,
        ).toBe(rule.allowed.includes(field));
      }
      for (const field of rule.required) {
        const without = Object.fromEntries(
          Object.entries(required).filter(([key]) => key !== field),
        );
        expect(await acceptedConfig(provider, without), `${provider}: without ${field}`).toBe(
          false,
        );
      }
    }
  });

  it('renders the list, the delete outcome and the rotation through the real handlers', async () => {
    const store = modelsStore();
    const connection = await createdResource(store, 'Compatible', REACHABLE_BASE_URL);
    const listed = await listModelConnections(store);
    expect(listed.status).toBe(200);
    expect(ModelConnectionListResponseSchema.parse(listed.body).models).toEqual([connection]);

    const rotated = await rotateModelConnectionCredential(store, connection.id, {
      apiKey: 'Rotated-Key',
    });
    expect(rotated).toEqual({ status: 204, body: null });

    const deleted = await deleteModelConnection(store, connection.id);
    expect(deleted.status).toBe(200);
    expect(DeleteModelConnectionResponseSchema.safeParse(deleted.body).success).toBe(true);
  });

  it('renders the probe outcome under 200 and 502 into the one published shape', async () => {
    const store = modelsStore();
    const reachable = await createdResource(store, 'Reachable', REACHABLE_BASE_URL);
    const failing = await createdResource(store, 'Failing', FAILING_BASE_URL);
    const probe = (resolved: Parameters<typeof probeModelConnection>[0]) =>
      probeModelConnection(resolved, providerFetch);

    const succeeded = await testModelConnection(store, reachable.id, probe);
    expect(succeeded.status).toBe(200);
    expect(ModelConnectionTestOutcomeSchema.parse(succeeded.body).ok).toBe(true);

    const failed = await testModelConnection(store, failing.id, probe);
    expect(failed.status).toBe(502);
    const outcome = ModelConnectionTestOutcomeSchema.parse(failed.body);
    expect(outcome).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(failed.body)).not.toContain(PROVIDER_KEY);
  });

  it('renders discovery rows and the unavailable list through the real adapter', async () => {
    const store = modelsStore();
    const reachable = await createdResource(store, 'Reachable', REACHABLE_BASE_URL);
    const failing = await createdResource(store, 'Failing', FAILING_BASE_URL);
    const discovered = await listDiscoveredModels(
      store,
      createModelDiscovery({ fetch: providerFetch }),
    );
    expect(discovered.status).toBe(200);
    const catalog = DiscoveredModelsResponseSchema.parse(discovered.body);
    expect(catalog.models).toEqual([
      expect.objectContaining({ connectionId: reachable.id, providerModelId: 'llama-3-70b' }),
    ]);
    expect(catalog.unavailable).toEqual([
      expect.objectContaining({ connectionId: failing.id, connectionName: 'Failing' }),
    ]);
    expect(JSON.stringify(discovered.body)).not.toContain(PROVIDER_KEY);
  });

  it('reports exactly the capability flags the gateway registry publishes', () => {
    for (const row of createProviderRegistry()) {
      expect(Object.keys(row.capabilities).sort(), row.id).toEqual(
        [...DISCOVERED_MODEL_CAPABILITY_KEYS].sort(),
      );
      expect(DiscoveredModelCapabilitiesSchema.safeParse(row.capabilities).success).toBe(true);
    }
  });
});

describe('runtimes', () => {
  const RUNTIME_WORKSPACE = '44444444-4444-4444-8444-444444444444';
  const RUNTIME_CONNECTION = '22222222-2222-4222-8222-222222222222';
  const unrestricted = () => Promise.resolve(null);

  const minimalProfile: RuntimeProfileRecord = {
    id: '88888888-8888-4888-8888-888888888888',
    workspaceId: RUNTIME_WORKSPACE,
    name: 'Standard',
    driver: 'docker',
    runtimeConnectionId: null,
    cpu: null,
    memoryMb: null,
    diskMb: null,
    networkPolicy: 'restricted',
    allowedDomains: null,
    filesystem: 'read-write',
    persistPaths: null,
    timeoutSeconds: null,
    idleTimeoutSeconds: null,
    driverConfig: null,
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
  };

  const createProfileBody: CreateRuntimeProfileInput = {
    name: 'Pinned',
    driver: 'kubernetes',
    networkPolicy: 'restricted',
    allowedDomains: ['api.anthropic.com'],
    filesystem: 'read-only',
    persistPaths: ['/workspace/.cache'],
    cpu: 0.5,
    memoryMb: 2048,
    diskMb: 10_240,
    timeoutSeconds: 3600,
    idleTimeoutSeconds: 600,
    driverConfig: { image: `ghcr.io/x/runner@sha256:${'a'.repeat(64)}`, namespace: 'agents' },
  };

  it('renders a minimal record and a fully pinned one into the published shape', () => {
    expect(
      RuntimeProfileResourceSchema.safeParse(toRuntimeProfileResource(minimalProfile)).success,
    ).toBe(true);
    const pinned: RuntimeProfileRecord = {
      ...minimalProfile,
      driver: 'kubernetes',
      runtimeConnectionId: RUNTIME_CONNECTION,
      cpu: 0.5,
      memoryMb: 2048,
      diskMb: 10_240,
      networkPolicy: 'none',
      allowedDomains: ['api.anthropic.com'],
      filesystem: 'read-only',
      persistPaths: ['/workspace/.cache'],
      timeoutSeconds: 3600,
      idleTimeoutSeconds: 600,
      driverConfig: { image: `ghcr.io/x/runner@sha256:${'a'.repeat(64)}` },
    };
    const parsed = RuntimeProfileResourceSchema.parse(toRuntimeProfileResource(pinned));
    expect(parsed.createdAt).toBe('2026-09-21T10:00:00.000Z');
    expect(parsed.runtimeConnectionId).toBe(RUNTIME_CONNECTION);
  });

  it('answers create with a bare item and list with the published envelope', async () => {
    const store = createInMemoryRuntimeProfileStoreProvider().forWorkspace(RUNTIME_WORKSPACE);
    const created = await createRuntimeProfile(store, createProfileBody, unrestricted);
    expect(created.status).toBe(201);
    expect(RuntimeProfileResourceSchema.safeParse(created.body).success).toBe(true);
    const listed = await listRuntimeProfiles(store);
    expect(listed.status).toBe(200);
    expect(RuntimeProfileListResponseSchema.safeParse(listed.body).success).toBe(true);
  });

  it('restates the same drivers, network policies and filesystem modes as the contract', () => {
    expect([...runtimeDriverIds]).toEqual([...RUNTIME_DRIVERS]);
    expect(CoreCreateRuntimeProfileInputSchema.shape.driver.options).toEqual([...RUNTIME_DRIVERS]);
    expect(CoreCreateRuntimeProfileInputSchema.shape.networkPolicy.options).toEqual([
      ...RUNTIME_NETWORK_POLICIES,
    ]);
    expect(CoreCreateRuntimeProfileInputSchema.shape.filesystem.options).toEqual([
      ...RUNTIME_FILESYSTEM_MODES,
    ]);
  });

  it('accepts the sizing values the contract accepts and refuses the ones it refuses', () => {
    const probes: readonly (readonly [keyof typeof RUNTIME_PROFILE_BOUNDS, number])[] = [
      ['cpu', RUNTIME_PROFILE_BOUNDS.cpu.exclusiveMin],
      ['cpu', 0.25],
      ['memoryMb', RUNTIME_PROFILE_BOUNDS.memoryMb.min - 1],
      ['memoryMb', RUNTIME_PROFILE_BOUNDS.memoryMb.min],
      ['memoryMb', 1.5],
      ['diskMb', RUNTIME_PROFILE_BOUNDS.diskMb.max],
      ['diskMb', RUNTIME_PROFILE_BOUNDS.diskMb.max + 2],
      ['timeoutSeconds', -1],
      ['idleTimeoutSeconds', RUNTIME_PROFILE_BOUNDS.idleTimeoutSeconds.min],
    ];
    for (const [field, value] of probes) {
      const server = parseCreateRuntimeProfileInput({ ...createProfileBody, [field]: value }).ok;
      const contract = RuntimeProfileResourceSchema.safeParse({
        ...toRuntimeProfileResource(minimalProfile),
        [field]: value,
      }).success;
      expect(server, `server and contract disagree on ${field}=${String(value)}`).toBe(contract);
    }
  });

  it('parses the bodies the SDK types as create and patch inputs', () => {
    expect(parseCreateRuntimeProfileInput(createProfileBody).ok).toBe(true);
    const patch: UpdateRuntimeProfilePatch = { networkPolicy: 'none', memoryMb: 512 };
    expect(parseUpdateRuntimeProfilePatch(patch).ok).toBe(true);
    // A patch cannot clear a sizing field: the route refuses `null`, as the contract documents.
    expect(parseUpdateRuntimeProfilePatch({ memoryMb: null }).ok).toBe(false);
  });

  it('renders a connection without its endpoint or credential, bare and in the list envelope', async () => {
    expect(
      RuntimeConnectionResourceSchema.safeParse(
        toRuntimeConnectionResource({
          id: RUNTIME_CONNECTION,
          name: 'RUNTIME_CONNECTION__DOCKER__PRIMARY',
          driver: 'docker',
          createdAt: new Date('2026-09-21T10:00:00.000Z'),
        }),
      ).success,
    ).toBe(true);
    const store = createInMemoryRuntimeConnectionStoreProvider().forWorkspace(RUNTIME_WORKSPACE);
    const body: CreateRuntimeConnectionInput = {
      name: 'Primary',
      driver: 'docker',
      endpoint: 'tcp://docker.internal:2376',
      credential: 'cert-and-key',
    };
    const created = await createRuntimeConnection(store, body);
    expect(created.status).toBe(201);
    // `.strict()` is the proof: a `credential` or `endpoint` key in the body would fail here.
    expect(RuntimeConnectionResourceSchema.safeParse(created.body).success).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('cert-and-key');
    const listed = await listRuntimeConnections(store);
    expect(RuntimeConnectionListResponseSchema.safeParse(listed.body).success).toBe(true);
  });
});

describe('secrets', () => {
  const SECRETS_WORKSPACE = '99999999-9999-4999-8999-999999999999';
  const SECRET_PLAINTEXT = 'sk-ant-conformance-plaintext-never-on-the-wire';

  it('renders a store record into the published shape', () => {
    const resource = toSecretResource({
      id: '88888888-8888-4888-8888-888888888888',
      name: 'ANTHROPIC_API_KEY',
      algorithm: 'aes-256-gcm',
      masterKeyId: 'local-dev-key-1',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:05:00.000Z'),
    });
    expect(SecretResourceSchema.safeParse(resource).success).toBe(true);
  });

  it('answers create, list and replace through the real handlers with bodies the contract accepts, and no body carries the value', async () => {
    const store = createInMemorySecretsStoreProvider().forWorkspace(SECRETS_WORKSPACE);

    const created = await createSecret(store, { name: 'GITHUB_TOKEN', value: SECRET_PLAINTEXT });
    expect(created.status).toBe(201);
    const createdParsed = SecretResourceSchema.safeParse(created.body);
    expect(createdParsed.success, JSON.stringify(createdParsed)).toBe(true);
    if (!createdParsed.success) return;

    const listed = await listSecrets(store);
    expect(listed.status).toBe(200);
    expect(SecretListResponseSchema.safeParse(listed.body).success).toBe(true);

    const rotated = 'sk-ant-conformance-rotated-value';
    const replaced = await replaceSecret(store, createdParsed.data.id, { value: rotated });
    expect(replaced.status).toBe(200);
    expect(SecretResourceSchema.safeParse(replaced.body).success).toBe(true);

    for (const body of [created.body, listed.body, replaced.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET_PLAINTEXT);
      expect(text).not.toContain(rotated);
      expect(text).not.toContain('"value"');
    }
  });

  it('restates the same name shape and value bound as the contract', () => {
    expect(SERVER_SECRET_NAME_PATTERN.source).toBe(SECRET_NAME_PATTERN.source);
    expect(SERVER_SECRET_NAME_PATTERN.flags).toBe(SECRET_NAME_PATTERN.flags);
    expect(SERVER_SECRET_VALUE_MAX_LENGTH).toBe(SECRET_VALUE_MAX_LENGTH);

    const longestName = `A${'B'.repeat(SECRET_NAME_MAX_LENGTH - 1)}`;
    expect(parseCreateSecretBody({ name: longestName, value: 'v' }).ok).toBe(true);
    expect(parseCreateSecretBody({ name: `${longestName}C`, value: 'v' }).ok).toBe(false);
    expect(
      parseCreateSecretBody({ name: 'TOKEN', value: 'x'.repeat(SECRET_VALUE_MAX_LENGTH) }).ok,
    ).toBe(true);
    expect(
      parseCreateSecretBody({ name: 'TOKEN', value: 'x'.repeat(SECRET_VALUE_MAX_LENGTH + 1) }).ok,
    ).toBe(false);
  });

  it('accepts exactly the request bodies the SDK sends', () => {
    expect(parseCreateSecretBody({ name: 'TOKEN', value: 'v' }).ok).toBe(true);
    expect(parseCreateSecretBody({ name: 'TOKEN', value: 'v', extra: 1 }).ok).toBe(false);
    expect(parseReplaceSecretBody({ value: 'v' }).ok).toBe(true);
    expect(parseReplaceSecretBody({ name: 'RENAMED', value: 'v' }).ok).toBe(false);
  });
});

describe('files', () => {
  const FILES_WORKSPACE = '44444444-4444-4444-8444-444444444444';
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
  let filesRootDir: string;
  let store: ObjectStore;

  beforeEach(async () => {
    filesRootDir = await mkdtemp(path.join(os.tmpdir(), 'sdk-conformance-files-'));
    store = createLocalFilesystemObjectStoreProvider(filesRootDir).forWorkspace(FILES_WORKSPACE);
  });

  afterEach(async () => {
    await rm(filesRootDir, { recursive: true, force: true });
  });

  function jsonBody(result: ApiResult): unknown {
    if (result.kind !== 'json') throw new Error(`expected a JSON result, got ${result.kind}`);
    return result.body;
  }

  function problemOf(result: ApiResult): { status: number; code: string } {
    const body = jsonBody(result) as { error: { code: string } };
    return { status: result.status, code: body.error.code };
  }

  it('mints the same route id for a path as the server does', () => {
    for (const filePath of [
      'a/b c.txt',
      'contracts/agreement.pdf',
      '案件/見積書_日本語.txt',
      'x',
    ]) {
      expect(fileRouteId(filePath)).toBe(encodeFileId(filePath));
      expect(requireFilePath(fileRouteId(filePath))).toEqual({ ok: true, path: filePath });
    }
  });

  it('renders uploads, folders, listings and renames into the published shapes', async () => {
    const uploaded = await uploadFile(store, {
      path: 'reports/q3 summary.md',
      contentType: 'text/markdown',
      body: utf8('# Q3'),
    });
    expect(uploaded.status).toBe(201);
    expect(FileResponseSchema.safeParse(jsonBody(uploaded)).success).toBe(true);

    const untyped = await uploadFile(store, {
      path: 'raw.bin',
      contentType: null,
      body: utf8('x'),
    });
    expect(FileResponseSchema.parse(jsonBody(untyped)).file.contentType).toBeNull();

    const created = await createFolder(store, 'empty');
    expect(created.status).toBe(201);
    const createdFolder = FileResponseSchema.parse(jsonBody(created)).file;
    expect(createdFolder).toMatchObject({ kind: 'folder', sizeBytes: null, lastModified: null });

    const listed = await listFiles(store, null);
    expect(listed.status).toBe(200);
    const listing = FileListResponseSchema.parse(jsonBody(listed));
    expect(listing.files.map((file) => [file.path, file.kind])).toEqual([
      ['empty', 'folder'],
      ['raw.bin', 'file'],
      ['reports', 'folder'],
    ]);
    expect(
      FileListResponseSchema.safeParse(jsonBody(await listFiles(store, 'reports'))).success,
    ).toBe(true);

    const asFolder = await downloadFile(store, 'reports');
    expect(asFolder.status).toBe(200);
    expect(FileResponseSchema.safeParse(jsonBody(asFolder)).success).toBe(true);

    const renamed = await renameFile(store, 'raw.bin', { newPath: 'renamed.bin' });
    expect(renamed.status).toBe(200);
    expect(MoveFileResponseSchema.safeParse(jsonBody(renamed)).success).toBe(true);
    expect(FileResponseSchema.parse(jsonBody(renamed)).file.path).toBe('renamed.bin');
  });

  it('serves a download as an inert attachment with the two-form filename the SDK parses', async () => {
    await uploadFile(store, {
      path: '案件/見積 書.txt',
      contentType: 'text/plain',
      body: utf8('hi'),
    });
    const response = toResponse(await downloadFile(store, '案件/見積 書.txt'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="____.txt"; filename*=UTF-8''${encodeURIComponent('見積 書.txt')}`,
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('hi');
  });

  it('renders every subtree outcome into the published unions', async () => {
    await uploadFile(store, { path: 'tree/one.txt', contentType: null, body: utf8('1') });
    await uploadFile(store, { path: 'tree/deep/two.txt', contentType: null, body: utf8('2') });

    const moved = await moveSubtree(store, null, 'tree', { newPath: 'moved' });
    expect(moved.status).toBe(200);
    expect(MoveFileResponseSchema.safeParse(jsonBody(moved)).success).toBe(true);
    expect(jsonBody(moved)).toEqual({ status: 'ok', moved: 2 });
    expect(jsonBody(await moveSubtree(store, null, 'moved', { newPath: 'moved' }))).toEqual({
      status: 'ok',
      moved: 0,
    });

    const refused = await deleteSubtree(store, 'moved', false);
    expect(refused === null ? null : problemOf(refused)).toEqual({
      status: 409,
      code: 'folder_not_empty',
    });

    const deleted = await deleteSubtree(store, 'moved', true);
    expect(deleted?.status).toBe(200);
    expect(
      deleted === null ? null : SubtreeDeleteOutcomeSchema.safeParse(jsonBody(deleted)).success,
    ).toBe(true);
    expect(await deleteSubtree(store, 'moved', true)).toBeNull();
  });

  it('answers each documented refusal with a code and status the contract publishes', async () => {
    await uploadFile(store, { path: 'file.txt', contentType: null, body: utf8('x') });
    await createFolder(store, 'dir');
    const refusals: readonly ApiResult[] = [
      await listFiles(store, '../outside'),
      await createFolder(store, '.claude/cache'),
      await uploadFile(store, { path: 'dir', contentType: null, body: utf8('x') }),
      await createFolder(store, 'file.txt'),
      await renameFile(store, 'missing.txt', { newPath: 'x.txt' }),
      await moveSubtree(store, null, 'dir', { newPath: 'dir/inner' }),
      await moveSubtree(store, null, 'nowhere', { newPath: 'somewhere' }),
    ];
    const seen = refusals.map(problemOf);
    expect(seen).toEqual([
      { status: 400, code: 'invalid_path' },
      { status: 400, code: 'reserved_path' },
      { status: 409, code: 'name_conflict' },
      { status: 409, code: 'name_conflict' },
      { status: 404, code: 'file_not_found' },
      { status: 409, code: 'self_descendant' },
      { status: 404, code: 'file_not_found' },
    ]);
    for (const { status, code } of seen) {
      expect(FILES_PROBLEM_CODES[code as keyof typeof FILES_PROBLEM_CODES]).toBe(status);
    }
    const unminted = requireFilePath('not base64url!');
    expect(unminted.ok ? null : problemOf(unminted.result)).toEqual({
      status: 404,
      code: 'file_not_found',
    });
  });

  it('shares the upload and subtree bounds with the server', () => {
    expect(SERVER_MAX_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES);
    expect(SERVER_MAX_SUBTREE_OBJECTS).toBe(MAX_SUBTREE_OBJECTS);
  });
});

describe('skills', () => {
  const SKILLS_WORKSPACE = '99999999-9999-4999-8999-999999999999';
  const SKILL_MD_TEXT =
    '---\nname: demo\ndescription: A demo skill\nallowed-tools: Read Grep\n---\n\nDo the thing.\n';
  const skillsBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const skillMdEntry = { path: 'SKILL.md', contentBase64: skillsBase64(SKILL_MD_TEXT) };
  const skillsStore = () => createInMemoryObjectStoreProvider().forWorkspace(SKILLS_WORKSPACE);
  /**
   * The one piece of `apps/web/app/api/skills/route.ts`'s `GET` this suite composes by hand: an
   * in-memory stand-in for the catalog's `putSkill`, at the same fidelity `skillsStore()` above
   * already gives the object store for this describe block. Real upsert semantics (same name,
   * same id) — not a fixed string.
   */
  const skillCatalogRows = new Map<string, string>();
  let nextSkillCatalogId = 0;
  const catalog = {
    putSkill: (input: {
      name: string;
      skillMd: string;
      enabled: boolean;
      ownerPrincipalId: string;
      createdBy: string | null;
    }): Promise<{ id: string }> => {
      const id = skillCatalogRows.get(input.name) ?? `catalog-${String((nextSkillCatalogId += 1))}`;
      skillCatalogRows.set(input.name, id);
      return Promise.resolve({ id });
    },
  };
  /**
   * The composition every route under `apps/web/app/api/skills/**` performs: the handler body
   * plus the catalog row's id (K-4, issue #234). `source` is `null` only for a skill whose
   * `SKILL.md` was pre-existing and unreadable — `listSkills` itself now refuses that state
   * (500 `store_inconsistent`), so no composed body this helper builds ever needs a fallback.
   */
  async function withCatalogId<T extends { name: string; enabled: boolean; source: string | null }>(
    skill: T,
  ): Promise<T & { id: string }> {
    const row = await catalog.putSkill({
      name: skill.name,
      skillMd: skill.source ?? '',
      enabled: skill.enabled,
      ownerPrincipalId: 'principal-1',
      createdBy: null,
    });
    return { ...skill, id: row.id };
  }

  it('answers import, get, list, patch and export through the real handlers with bodies the contract accepts', async () => {
    const store = skillsStore();

    const imported = await importSkill(store, {
      name: 'demo',
      files: [skillMdEntry, { path: 'scripts/run.sh', contentBase64: skillsBase64('#!/bin/sh\n') }],
    });
    expect(imported.status).toBe(201);
    const importedBody = imported.body as {
      skill: { name: string; enabled: boolean; source: string | null };
    };
    // K-4: every pin below is the composed route serializer — the handler body plus the catalog
    // row's id (`apps/web/app/api/skills/route.ts`) — through a real (in-memory) catalog's
    // `putSkill`, never a hand-written id, so every id comes from a real serializer.
    const created = SkillResponseSchema.safeParse({
      skill: await withCatalogId(importedBody.skill),
    });
    expect(created.success, JSON.stringify(created)).toBe(true);
    if (!created.success) return;
    expect(created.data.skill.description).toBe('A demo skill');
    expect(created.data.skill.allowedTools).toEqual(['Read', 'Grep']);
    expect(created.data.skill.fileCount).toBe(2);

    const fetched = await getSkill(store, 'demo');
    expect(fetched.status).toBe(200);
    const fetchedBody = fetched.body as {
      skill: { name: string; enabled: boolean; source: string | null };
    };
    expect(
      SkillResponseSchema.safeParse({ skill: await withCatalogId(fetchedBody.skill) }).success,
    ).toBe(true);

    const listed = await listSkills(store);
    expect(listed.status).toBe(200);
    const listedBody = listed.body as {
      skills: Array<{ name: string; enabled: boolean; source: string | null }>;
    };
    const composedSkills = await Promise.all(listedBody.skills.map(withCatalogId));
    const page = SkillListResponseSchema.safeParse({ skills: composedSkills });
    expect(page.success, JSON.stringify(page)).toBe(true);

    const patched = await patchSkill(store, 'demo', {
      enabled: false,
      files: [{ path: 'notes.txt', contentBase64: '' }],
      removeFiles: ['scripts/run.sh'],
    });
    expect(patched.status).toBe(200);
    const patchedBody = patched.body as {
      skill: { name: string; enabled: boolean; source: string | null };
    };
    const updated = SkillResponseSchema.safeParse({
      skill: await withCatalogId(patchedBody.skill),
    });
    expect(updated.success, JSON.stringify(updated)).toBe(true);
    if (!updated.success) return;
    expect(updated.data.skill.enabled).toBe(false);
    expect(updated.data.skill.files.map((file) => file.path)).toEqual(['SKILL.md', 'notes.txt']);

    const exported = await exportSkill(store, 'demo');
    expect(exported.status).toBe(200);
    const directory = SkillExportResponseSchema.safeParse(exported.body);
    expect(directory.success, JSON.stringify(directory)).toBe(true);
    if (!directory.success) return;
    expect(directory.data.skill.files).toEqual([
      { path: 'SKILL.md', contentBase64: skillMdEntry.contentBase64 },
      { path: 'notes.txt', contentBase64: '' },
    ]);
  });

  it('K-4: refuses a SKILL.md whose bytes are not valid UTF-8, in the published problem shape', async () => {
    // Before K-4 this imported and rendered with every text field null; K-4 refuses it outright
    // (issue #234) so no new skill can reach the state `SkillDetail.id` being required cannot
    // honestly describe — see `store_inconsistent` in the "skills" describe block above this one.
    const store = skillsStore();
    const imported = await importSkill(store, {
      name: 'binary',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') },
      ],
    });
    expect(imported.status).toBe(400);
    const envelope = ApiProblemSchema.safeParse(imported.body);
    expect(envelope.success, JSON.stringify(envelope)).toBe(true);
    if (!envelope.success) return;
    expect(envelope.data.error.code).toBe('malformed_content');
  });

  it('refuses what the contract documents, under the status and code the contract publishes', async () => {
    const store = skillsStore();
    expect((await importSkill(store, { name: 'demo', files: [skillMdEntry] })).status).toBe(201);

    const refusals: readonly (readonly [
      SkillsProblemCode,
      Promise<{ status: number; body: unknown }>,
    ])[] = [
      ['missing_name', importSkill(store, { files: [skillMdEntry] })],
      ['invalid_name', importSkill(store, { name: 'Not-A-Slug', files: [skillMdEntry] })],
      ['missing_files', importSkill(store, { name: 'other', files: [] })],
      ['malformed_file_entry', importSkill(store, { name: 'other', files: [{ path: 'x' }] })],
      [
        'inadmissible_path',
        importSkill(store, {
          name: 'other',
          files: [{ path: 'SKILL.md::$DATA', contentBase64: '' }],
        }),
      ],
      [
        'duplicate_path',
        importSkill(store, { name: 'other', files: [skillMdEntry, skillMdEntry] }),
      ],
      [
        'missing_skill_md',
        importSkill(store, { name: 'other', files: [{ path: 'notes.txt', contentBase64: '' }] }),
      ],
      [
        'malformed_content',
        importSkill(store, { name: 'other', files: [{ path: 'SKILL.md', contentBase64: '%%%' }] }),
      ],
      ['skill_already_exists', importSkill(store, { name: 'demo', files: [skillMdEntry] })],
      [
        'colliding_paths',
        importSkill(store, {
          name: 'other',
          files: [skillMdEntry, { path: 'skill.md', contentBase64: '' }],
        }),
      ],
      ['skill_not_found', getSkill(store, 'absent')],
      ['skill_not_found', exportSkill(store, 'absent')],
      ['empty_patch', patchSkill(store, 'demo', {})],
      ['cannot_remove_skill_md', patchSkill(store, 'demo', { removeFiles: ['skill.MD'] })],
      [
        'colliding_paths',
        patchSkill(store, 'demo', { files: [{ path: 'skill.md', contentBase64: '' }] }),
      ],
    ];
    for (const [code, pending] of refusals) {
      const result = await pending;
      const envelope = ApiProblemSchema.safeParse(result.body);
      expect(envelope.success, `${code}: ${JSON.stringify(result.body)}`).toBe(true);
      if (!envelope.success) continue;
      expect(envelope.data.error.code).toBe(code);
      expect(result.status).toBe(SKILLS_PROBLEM_CODES[code]);
    }

    const notASlug = requireSkillName('Not-A-Slug');
    expect(notASlug.ok).toBe(false);
    if (!notASlug.ok) {
      expect(notASlug.result.status).toBe(SKILLS_PROBLEM_CODES.skill_not_found);
      expect(ApiProblemSchema.parse(notASlug.result.body).error.code).toBe('skill_not_found');
    }

    const malformed = await patchSkill(store, 'demo', { enabled: 'yes' });
    expect(malformed.status).toBe(COMMON_PROBLEM_CODES.malformed_body);
    expect(ApiProblemSchema.parse(malformed.body).error.code).toBe('malformed_body');
  });

  it('accepts exactly the names the contract grammar accepts', () => {
    const probes = [
      'a',
      'demo',
      'my-skill-2',
      'Demo',
      '-leading',
      'trailing-',
      'double--hyphen',
      'under_score',
      '',
      'a'.repeat(64),
      'a'.repeat(65),
      `a${'-'.repeat(62)}a`,
    ];
    for (const probe of probes) {
      expect(isValidSkillName(probe), JSON.stringify(probe)).toBe(SKILL_NAME_PATTERN.test(probe));
    }
  });
});

describe('tool bundles (issue #790)', () => {
  const bytes = Buffer.from('export default () => 1;\n').toString('base64');

  it('answers upload and get through the real handlers with bodies the contract accepts', async () => {
    const store = createInMemoryObjectStoreProvider().forWorkspace(
      '99999999-9999-4999-8999-999999999999',
    );
    const first = await uploadToolBundle(store, { contentBase64: bytes });
    const again = await uploadToolBundle(store, { contentBase64: bytes });
    const parsed = UploadToolBundleResponseSchema.parse(first.body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(UploadToolBundleResponseSchema.parse(again.body).created).toBe(false);
    const fetched = await getToolBundle(store, parsed.bundle.digest);
    expect(ToolBundleResponseSchema.parse(fetched.body)).toEqual({ bundle: parsed.bundle });
  });
});

describe('connectors', () => {
  const CONNECTORS_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CONNECTORS_OWNER = {
    principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const CONNECTOR_PLAINTEXT = 'ghp_conformance-plaintext-never-on-the-wire';
  const remoteConnectorBody = {
    name: 'GitHub',
    transport: 'http',
    url: 'https://mcp.example.invalid/mcp',
    authType: 'bearer',
    credential: CONNECTOR_PLAINTEXT,
  };
  const stdioConnectorBody = {
    name: 'Filesystem',
    transport: 'stdio',
    command: 'sdk-conformance-no-such-binary',
    args: ['--root', '/data'],
  };

  // The server's own types must be exactly what the contract infers, in both directions, so a
  // field added on one side without the other is a compile error here before it is a runtime one.
  function connectorResourceToContract(value: ServerConnectorResource): ConnectorResource {
    return value;
  }
  function connectorResourceFromContract(value: McpConnectorResource): ServerConnectorResource {
    return value;
  }
  function testOutcomeToContract(value: ServerTestConnectionOutcome): TestConnectionOutcome {
    return value;
  }
  function testOutcomeFromContract(value: TestConnectionOutcome): ServerTestConnectionOutcome {
    return value;
  }

  it('answers create, list, get, rotate and delete through the real handlers with bodies the contract accepts, and no body carries the credential', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(CONNECTORS_WORKSPACE);

    const created = await createConnector(store, remoteConnectorBody, CONNECTORS_OWNER);
    expect(created.status).toBe(201);
    const createdParsed = ConnectorResourceSchema.safeParse(created.body);
    expect(createdParsed.success, JSON.stringify(createdParsed)).toBe(true);
    if (!createdParsed.success) return;
    expect(isMcpConnectorResource(createdParsed.data)).toBe(true);
    if (!isMcpConnectorResource(createdParsed.data)) return;
    expect(createdParsed.data.hasCredential).toBe(true);
    expect(connectorResourceFromContract(createdParsed.data).id).toBe(createdParsed.data.id);

    const stdioCreated = await createConnector(store, stdioConnectorBody, CONNECTORS_OWNER);
    expect(stdioCreated.status).toBe(201);
    const stdioParsed = ConnectorResourceSchema.safeParse(stdioCreated.body);
    expect(stdioParsed.success, JSON.stringify(stdioParsed)).toBe(true);
    if (!stdioParsed.success) return;
    expect(stdioParsed.data).toMatchObject({ url: null, authType: 'none', hasCredential: false });

    const listed = await listConnectors(store);
    expect(listed.status).toBe(200);
    expect(ConnectorListResponseSchema.safeParse(listed.body).success).toBe(true);

    const fetched = await getConnector(store, createdParsed.data.id);
    expect(fetched.status).toBe(200);
    expect(ConnectorResourceSchema.safeParse(fetched.body).success).toBe(true);

    const rotatedPlaintext = 'ghp_conformance-rotated-value';
    const rotated = await rotateConnectorCredential(store, createdParsed.data.id, {
      credential: rotatedPlaintext,
    });
    expect(rotated.status).toBe(200);
    expect(ConnectorResourceSchema.safeParse(rotated.body).success).toBe(true);

    for (const body of [created.body, stdioCreated.body, listed.body, fetched.body, rotated.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(CONNECTOR_PLAINTEXT);
      expect(text).not.toContain(rotatedPlaintext);
      expect(text).not.toContain('"credential"');
    }

    const deleted = await deleteConnector(store, createdParsed.data.id);
    expect(deleted).toEqual({ status: 204, body: null });
  });

  it('answers a saved test and a dry-run test with the published outcome shape, without persisting a draft', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(CONNECTORS_WORKSPACE);
    const created = await createConnector(store, stdioConnectorBody, CONNECTORS_OWNER);
    const createdParsed = ConnectorResourceSchema.safeParse(created.body);
    expect(createdParsed.success, JSON.stringify(createdParsed)).toBe(true);
    if (!createdParsed.success) return;
    expect(isMcpConnectorResource(createdParsed.data)).toBe(true);
    if (!isMcpConnectorResource(createdParsed.data)) return;

    // A stdio probe never launches the command in the control plane (ADR-0045); its declared
    // refusal is the one real outcome this test can drive without a network.
    const saved = await testConnectionSaved(store, createdParsed.data.id);
    expect(saved.status).toBe(200);
    const savedParsed = TestConnectionOutcomeSchema.safeParse(saved.body);
    expect(savedParsed.success, JSON.stringify(savedParsed)).toBe(true);
    if (!savedParsed.success) return;
    expect(savedParsed.data).toMatchObject({ ok: false, kind: 'stdio-probe-unavailable' });
    expect(testOutcomeFromContract(savedParsed.data).ok).toBe(false);

    const draft = await createConnector(
      store,
      { ...stdioConnectorBody, name: 'Draft', dryRun: true },
      null,
    );
    expect(draft.status).toBe(200);
    expect(TestConnectionOutcomeSchema.safeParse(draft.body).success).toBe(true);
    const listed = await listConnectors(store);
    expect(ConnectorListResponseSchema.parse(listed.body).connectors.map((c) => c.name)).toEqual([
      'Filesystem',
    ]);

    // The success arm is not reachable without a live MCP server; it is pinned by type through
    // `testOutcomeToContract` and by value through the server's own literal shape.
    const connected: ServerTestConnectionOutcome = {
      ok: true,
      kind: 'ok',
      message: 'Connected. The server answered and accepted the credential.',
      serverName: 'github-mcp',
      serverVersion: '1.2.0',
      toolCount: 12,
    };
    expect(TestConnectionOutcomeSchema.safeParse(testOutcomeToContract(connected)).success).toBe(
      true,
    );
    expect(
      ConnectorResourceSchema.safeParse(connectorResourceToContract(createdParsed.data)).success,
    ).toBe(true);
  });

  it('creates openapi and postgres connectors whose resources and dry runs the contract accepts', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(CONNECTORS_WORKSPACE);
    const egressOpen = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });
    const document = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Orders', version: '1' },
      servers: [{ url: 'https://93.184.216.34/v1' }],
      paths: { '/orders': { get: { operationId: 'listOrders', responses: {} } } },
    });
    const bodies = [
      {
        kind: 'openapi',
        name: 'orders',
        document,
        allow: ['GET /orders'],
        auth: 'bearer',
        credential: 'tok',
      },
      {
        kind: 'postgres',
        name: 'warehouse',
        credential: 'postgres://u:p@93.184.216.34:5432/db',
        tables: ['public.orders'],
        readOnly: true,
      },
    ];
    for (const body of bodies) {
      const dry = await createConnector(store, { ...body, dryRun: true }, null, egressOpen);
      expect(dry.status).toBe(200);
      expect(TestConnectionOutcomeSchema.safeParse(dry.body).success).toBe(true);

      const created = await createConnector(store, body, CONNECTORS_OWNER, egressOpen);
      expect(created.status).toBe(201);
      const parsed = ConnectorResourceSchema.safeParse(created.body);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      if (parsed.success) expect(isMcpConnectorResource(parsed.data)).toBe(false);
      expect(JSON.stringify(created.body)).not.toContain(body.credential);
    }
    const listed = ConnectorListResponseSchema.safeParse((await listConnectors(store)).body);
    expect(listed.success && listed.data.connectors.length).toBe(2);

    const refusals = [
      await createConnector(store, { kind: 'ftp', name: 'x' }, CONNECTORS_OWNER, egressOpen),
      await createConnector(
        store,
        { ...bodies[0], name: 'w', allow: ['POST /orders'] },
        CONNECTORS_OWNER,
        egressOpen,
      ),
      await createConnector(
        store,
        { ...bodies[0], name: 'z', document: '{}' },
        CONNECTORS_OWNER,
        egressOpen,
      ),
    ];
    for (const refusal of refusals) {
      const code = (refusal.body as { error: { code: keyof typeof CONNECTORS_PROBLEM_CODES } })
        .error.code;
      expect(refusal.status).toBe(CONNECTORS_PROBLEM_CODES[code]);
    }
  });

  it('restates the same failure kinds and bounds as the contract', async () => {
    expect([...SERVER_FAILURE_KINDS]).toEqual([...TEST_CONNECTION_FAILURE_KINDS]);
    // An mcp body one byte over the contract's cap is refused (`{"name":"…"}` is 11 bytes + name).
    const oversized = await readConnectorBody(
      new Request('http://localhost/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'n'.repeat(CONNECTOR_REQUEST_BODY_MAX_BYTES + 1 - 11) }),
      }),
    );
    expect(oversized.ok ? 200 : oversized.result.status).toBe(413);

    const longestName = 'n'.repeat(CONNECTOR_NAME_MAX_LENGTH);
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, name: longestName }).ok).toBe(true);
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, name: `${longestName}x` }).ok).toBe(
      false,
    );
  });

  it('accepts exactly the request bodies the SDK sends', () => {
    expect(parseCreateConnectorBody(remoteConnectorBody).ok).toBe(true);
    expect(parseCreateConnectorBody(stdioConnectorBody).ok).toBe(true);
    expect(parseCreateConnectorBody({ name: 'FS', transport: 'stdio', command: 'npx' }).ok).toBe(
      true,
    );
    expect(
      parseCreateConnectorBody({ name: 'S', transport: 'sse', url: 'https://x.invalid/sse' }).ok,
    ).toBe(true);
    // The contract's two input shapes are exclusive because the route refuses the mix.
    expect(parseCreateConnectorBody({ ...remoteConnectorBody, command: 'npx' }).ok).toBe(false);
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, url: 'https://x' }).ok).toBe(false);
    expect(parseCreateConnectorBody({ ...remoteConnectorBody, credential: undefined }).ok).toBe(
      false,
    );
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, credential: 'unexpected' }).ok).toBe(
      false,
    );
  });
});

describe('team', () => {
  const TEAM_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const TEAM_WORKSPACE_SLUG = 'team-conformance';
  const TEAM_OWNER_EMAIL = 'owner@team.example.test';
  const TEAM_SESSION_SECRET = 'team-conformance-session-secret-that-is-long-enough';

  function teamDirectory() {
    return createMemoryDirectory({
      newId: () => crypto.randomUUID(),
      workspaces: [{ id: TEAM_WORKSPACE, slug: TEAM_WORKSPACE_SLUG, name: 'Team' }],
      users: [
        { email: TEAM_OWNER_EMAIL, name: 'Owner', workspaceId: TEAM_WORKSPACE, role: 'owner' },
        {
          email: 'admin@team.example.test',
          name: 'Admin',
          workspaceId: TEAM_WORKSPACE,
          role: 'admin',
        },
      ],
    });
  }

  /** The real session principal the invitation handlers demand — never an API key. */
  async function teamOwnerPrincipal(): Promise<Principal> {
    const token = await mintSessionToken(
      newSessionClaims(TEAM_OWNER_EMAIL, TEAM_WORKSPACE_SLUG),
      TEAM_SESSION_SECRET,
    );
    const verified = await verifySessionToken(token, TEAM_SESSION_SECRET);
    if (!verified.ok) throw new Error(`session could not be verified: ${verified.reason}`);
    const built = Principal.fromSession(
      verified.claims,
      { id: TEAM_WORKSPACE, slug: TEAM_WORKSPACE_SLUG },
      'owner',
      { principalId: 'membership-principal:owner', userId: 'owner-user', label: 'Owner' },
    );
    if (!built.ok) throw new Error(`principal could not be built: ${built.because}`);
    return built.principal;
  }

  function teamInvitationsRuntime(): InvitationsRuntime {
    return {
      recordAuditEvent: () => Promise.resolve(),
      sendInvitation: createManualLinkInvitationSender(),
    };
  }

  function parsedOrThrow<T>(result: { success: true; data: T } | { success: false }): T {
    if (!result.success)
      throw new Error(`the server body does not satisfy the contract: ${JSON.stringify(result)}`);
    return result.data;
  }

  it('restates the same roles and API-key shape as the contract', () => {
    expect([...ROLES]).toEqual([...MEMBERSHIP_ROLES]);
    expect(SERVER_API_KEY_PREFIX).toBe(API_KEY_PREFIX);
    expect(SERVER_KEY_ID_LENGTH).toBe(API_KEY_ID_LENGTH);
    expect(SERVER_SECRET_LENGTH).toBe(API_KEY_SECRET_LENGTH);
  });

  it('answers the membership and user routes through the real handlers with bodies the contract accepts', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);

    const users = await listUsers(directory);
    expect(users.status).toBe(200);
    expect(UserListResponseSchema.safeParse(users.body).success).toBe(true);
    // The projection is typed as the server's own row type, so a field added there fails here.
    const projected: UserSummary = {
      id: 'u',
      email: 'x@y.test',
      name: 'X',
      createdAt: '2026-09-21T10:00:00.000Z',
    };
    expect(UserResourceSchema.safeParse(projected).success).toBe(true);

    const created = await createUser(directory, 'owner', {
      email: 'New.Person@team.example.test',
      name: 'New Person',
      role: 'builder',
    });
    expect(created.status).toBe(201);
    expect(CreatedUserResponseSchema.safeParse(created.body).success).toBe(true);

    const listed = await listMemberships(directory);
    expect(listed.status).toBe(200);
    const memberships = parsedOrThrow(MembershipListResponseSchema.safeParse(listed.body));
    expect(memberships.memberships.every((row) => row.principalId.length > 0)).toBe(true);

    const attached = await createMembership(
      teamDirectory().forWorkspace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      'owner',
      { email: TEAM_OWNER_EMAIL, role: 'viewer' },
    );
    expect(attached.status).toBe(201);
    expect(MembershipResponseSchema.safeParse(attached.body).success).toBe(true);

    const target = memberships.memberships.find(
      (row) => row.email === 'new.person@team.example.test',
    );
    if (target === undefined) throw new Error('the created user was not listed');
    const changed = await changeMembershipRole(directory, 'owner', target.id, { role: 'admin' });
    expect(changed.status).toBe(200);
    expect(MembershipResponseSchema.safeParse(changed.body).success).toBe(true);

    const removed = await deleteMembership(directory, 'owner', target.id);
    expect(removed).toEqual({ status: 204, body: null });
  });

  it('restates the name and email bounds the user routes apply', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);
    const longestName = 'n'.repeat(USER_NAME_MAX_LENGTH);
    const fits = await createUser(directory, 'owner', {
      email: 'fits@team.example.test',
      name: longestName,
      role: 'viewer',
    });
    expect(fits.status).toBe(201);
    const overflows = await createUser(directory, 'owner', {
      email: 'over@team.example.test',
      name: `${longestName}x`,
      role: 'viewer',
    });
    expect(overflows.status).toBe(400);

    const longestEmail = `${'e'.repeat(USER_EMAIL_MAX_LENGTH - '@team.example.test'.length)}@team.example.test`;
    expect(longestEmail).toHaveLength(USER_EMAIL_MAX_LENGTH);
    expect(
      (await createUser(directory, 'owner', { email: longestEmail, name: 'E', role: 'viewer' }))
        .status,
    ).toBe(201);
    expect(
      (
        await createUser(directory, 'owner', {
          email: `x${longestEmail}`,
          name: 'E',
          role: 'viewer',
        })
      ).status,
    ).toBe(400);
  });

  it('answers the API-key routes through the real handlers, and the plaintext appears in exactly one body', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);

    const minted = await createApiKey(directory, 'owner', {
      name: 'ci-deploy',
      role: 'builder',
      expiresAt: null,
    });
    expect(minted.status).toBe(201);
    const mint = parsedOrThrow(MintedApiKeyResponseSchema.safeParse(minted.body));

    const expiring = await createApiKey(directory, 'owner', {
      name: 'expiring',
      role: 'viewer',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(expiring.status).toBe(201);
    expect(MintedApiKeyResponseSchema.safeParse(expiring.body).success).toBe(true);

    const listed = await listApiKeys(directory);
    expect(listed.status).toBe(200);
    expect(ApiKeyListResponseSchema.safeParse(listed.body).success).toBe(true);

    const revoked = await revokeApiKey(directory, mint.apiKey.id);
    expect(revoked.status).toBe(200);
    expect(ApiKeyResponseSchema.safeParse(revoked.body).success).toBe(true);
    const again = await revokeApiKey(directory, mint.apiKey.id);
    expect(again.status).toBe(200);
    expect(ApiKeyResponseSchema.safeParse(again.body).success).toBe(true);

    const bodies = [minted.body, expiring.body, listed.body, revoked.body, again.body].map((body) =>
      JSON.stringify(body),
    );
    expect(bodies.filter((text) => text.includes(mint.key))).toHaveLength(1);
    for (const text of bodies.slice(2)) expect(text).not.toContain('"key"');

    const projected: ApiKeySummary = mint.apiKey;
    expect(ApiKeyResourceSchema.safeParse(projected).success).toBe(true);
  });

  it('restates the API-key name bound and the expiry rule', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);
    const longest = 'k'.repeat(API_KEY_NAME_MAX_LENGTH);
    expect((await createApiKey(directory, 'owner', { name: longest, role: 'viewer' })).status).toBe(
      201,
    );
    expect(
      (await createApiKey(directory, 'owner', { name: `${longest}x`, role: 'viewer' })).status,
    ).toBe(400);
    const past = await createApiKey(directory, 'owner', {
      name: 'past',
      role: 'viewer',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(past.status).toBe(400);
    const unparseable = await createApiKey(directory, 'owner', {
      name: 'soon',
      role: 'viewer',
      expiresAt: 'tomorrow',
    });
    expect(unparseable.status).toBe(400);
  });

  it('answers the invitation lifecycle through the real handlers with bodies the contract accepts', async () => {
    const root = teamDirectory();
    const directory = root.forWorkspace(TEAM_WORKSPACE);
    const principal = await teamOwnerPrincipal();
    const runtime = teamInvitationsRuntime();

    const created = await createInvitation(
      directory,
      principal,
      { email: 'Invitee@team.example.test', role: 'builder' },
      runtime,
    );
    expect(created.status).toBe(201);
    const issued = parsedOrThrow(IssuedInvitationResponseSchema.safeParse(created.body));

    const resent = await resendInvitation(directory, principal, issued.invitation.id, runtime);
    expect(resent.status).toBe(200);
    const rotated = parsedOrThrow(IssuedInvitationResponseSchema.safeParse(resent.body));
    expect(rotated.token).not.toBe(issued.token);

    const listed = await listInvitations(directory, principal);
    expect(listed.status).toBe(200);
    expect(InvitationListResponseSchema.safeParse(listed.body).success).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain(rotated.token);

    const accepted = await acceptInvitation(
      root,
      {
        email: 'invitee@team.example.test',
        issuer: 'https://issuer.example.test',
        subject: 'subject:invitee',
        iat: 0,
        exp: 0,
      },
      issued.invitation.id,
      { token: rotated.token },
      runtime,
    );
    expect(accepted.status).toBe(200);
    const joined = parsedOrThrow(AcceptedInvitationResponseSchema.safeParse(accepted.body));
    // The one route that renders the membership's principal id today.
    expect(joined.membership.principalId).toEqual(expect.any(String));
    expect(joined.workspaceId).toBe(TEAM_WORKSPACE);

    const second = await createInvitation(
      directory,
      principal,
      { email: 'other@team.example.test', role: 'viewer' },
      runtime,
    );
    const other = parsedOrThrow(IssuedInvitationResponseSchema.safeParse(second.body));
    const revoked = await revokeInvitation(directory, principal, other.invitation.id, runtime);
    expect(revoked.status).toBe(200);
    expect(InvitationResponseSchema.safeParse(revoked.body).success).toBe(true);
    expect(
      InvitationResourceSchema.parse(
        parsedOrThrow(InvitationResponseSchema.safeParse(revoked.body)).invitation,
      ).revokedAt,
    ).not.toBeNull();
  });
});

describe('me', () => {
  const ME_WORKSPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ME_WORKSPACE_SLUG = 'me-conformance';
  const ME_EMAIL = 'member@me.example.test';
  const ME_SESSION_SECRET = 'me-conformance-session-secret-that-is-long-enough';

  /** A real session principal, built the only way one can be built. */
  async function meSessionPrincipal(): Promise<Principal> {
    const token = await mintSessionToken(
      newSessionClaims(ME_EMAIL, ME_WORKSPACE_SLUG),
      ME_SESSION_SECRET,
    );
    const verified = await verifySessionToken(token, ME_SESSION_SECRET);
    if (!verified.ok) throw new Error(`session could not be verified: ${verified.reason}`);
    const built = Principal.fromSession(
      verified.claims,
      { id: ME_WORKSPACE, slug: ME_WORKSPACE_SLUG },
      'admin',
      {
        principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        label: 'Aya Ito',
      },
    );
    if (!built.ok) throw new Error(`principal could not be built: ${built.because}`);
    return built.principal;
  }

  function meApiKeyPrincipal(): Principal {
    return Principal.fromApiKey({
      principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      apiKeyId: 'abababab-abab-4bab-8bab-abababababab',
      workspaceId: ME_WORKSPACE,
      role: 'viewer',
      label: 'ci',
    });
  }

  it('renders both principal kinds through the real serializer into bodies the contract accepts', async () => {
    for (const principal of [await meSessionPrincipal(), meApiKeyPrincipal()]) {
      const result = readMe(principal);
      expect(result.status).toBe(200);
      const parsed = MeResponseSchema.safeParse(result.body);
      expect(
        parsed.success,
        `the ${principal.kind} body does not satisfy MeResponseSchema: ${JSON.stringify(parsed)}`,
      ).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.workspaceId).toBe(ME_WORKSPACE);
      // The wire's own promise about the field the two kinds differ in.
      expect(parsed.data.userId === null).toBe(principal.kind === 'api_key');
    }
  });

  it('keeps the server’s principal-kind vocabulary and the contract’s in correspondence', () => {
    // `MeResponseSchema` is `.strict()` and `kind` is an enum, so the assertion above would catch
    // a server kind the contract has not got — but only for the two kinds the fixtures above
    // happen to build. This one quantifies over the server's whole list, mapped through the same
    // `wireKind` the route uses, and asserts the mapping is onto the contract's whole list. A
    // third principal kind, or a rename on either side, fails here.
    expect(SERVER_PRINCIPAL_KINDS.map(wireKind)).toEqual([...WIRE_PRINCIPAL_KINDS]);
    expect(new Set(SERVER_PRINCIPAL_KINDS.map(wireKind)).size).toBe(WIRE_PRINCIPAL_KINDS.length);
    // The compile-time half, which the runtime comparison cannot make: a wire kind the contract
    // has not got would still be a string.
    const serverCoversContract: WirePrincipalKind extends PrincipalKindName ? true : false = true;
    const contractCoversServer: PrincipalKindName extends WirePrincipalKind ? true : false = true;
    expect([serverCoversContract, contractCoversServer]).toEqual([true, true]);
  });
});

describe('shares', () => {
  const SHARES_WORKSPACE = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  const SHARES_PRINCIPAL = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
  const SHARES_ROLE_HEADER = 'x-conformance-role';

  const record: ShareRecord = {
    id: '99999999-9999-4999-8999-999999999999',
    workspaceId: SHARES_WORKSPACE,
    token: 'pub_conformance-token-never-on-a-private-wire',
    subjectType: 'session',
    subjectId: '55555555-5555-4555-8555-555555555555',
    subjectLabel: 'Incident review',
    visibility: 'workspace',
    mode: null,
    snapshot: { messages: [] },
    include: { technicalDetails: true },
    budgetCapUsd: null,
    spentUsd: '0',
    stopped: false,
    expiresAt: null,
    passphraseHash: 'sensitive-hash',
    createdBy: null,
    publisherPrincipalId: SHARES_PRINCIPAL,
    revokedAt: null,
    suspendedAt: null,
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
  };

  const runnable: ShareRecord = {
    ...record,
    subjectType: 'agent',
    subjectId: '11111111-1111-4111-8111-111111111111',
    visibility: 'public',
    mode: 'runnable',
    include: {},
    budgetCapUsd: '20.0000',
    spentUsd: '1.250000',
    stopped: true,
    expiresAt: new Date('2026-09-28T10:00:00.000Z'),
    suspendedAt: new Date('2026-09-22T10:00:00.000Z'),
  };

  it('renders the 201 (bare) and every list item (with its view count) into the published shape', () => {
    const published = ShareResourceSchema.safeParse(toShareResource(record));
    expect(published.success, JSON.stringify(published)).toBe(true);
    const publicItem = ShareListItemSchema.safeParse(toShareResource(runnable, 3));
    expect(publicItem.success, JSON.stringify(publicItem)).toBe(true);
    if (!publicItem.success) return;
    expect(publicItem.data.url).toBe(`/p/${runnable.token}`);
    expect(publicItem.data.viewCount).toBe(3);

    const list = ShareListResponseSchema.safeParse({
      shares: [toShareResource(record, 0), toShareResource(runnable, 3)],
    });
    expect(list.success, JSON.stringify(list)).toBe(true);
    // The wire never carries the token of a non-public share, nor any hash: `.strict()` and the
    // public-link invariant are what refuse a serializer that started spreading the record.
    expect(JSON.stringify(toShareResource(record, 0))).not.toContain(record.token);
    expect(JSON.stringify(toShareResource(runnable, 3))).not.toContain('sensitive-hash');
  });

  it('restates the same subject types, visibilities, modes, expiries and passphrase bound as the contract', () => {
    const request = PublishShareRequestSchema.shape;
    expect(request.subjectType.options).toEqual([...SHARE_SUBJECT_TYPES]);
    expect(request.visibility.options).toEqual([...SHARE_VISIBILITIES]);
    expect(request.mode.unwrap().options).toEqual([...SHARE_MODES]);
    expect(request.expiry.unwrap().options).toEqual([...SHARE_EXPIRIES]);
    const command = {
      subjectType: 'session',
      subjectId: 'session-1',
      subjectLabel: 'Session',
      visibility: 'private',
    } as const;
    expect(() =>
      parsePublishShareRequest({ ...command, passphrase: 'p'.repeat(SHARE_PASSPHRASE_MAX_LENGTH) }),
    ).not.toThrow();
    expect(() =>
      parsePublishShareRequest({
        ...command,
        passphrase: 'p'.repeat(SHARE_PASSPHRASE_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('accepts every publish command the SDK sends, and refuses the pairings the contract documents', () => {
    const accepted: readonly PublishShareCommand[] = [
      { subjectType: 'session', subjectId: 's', subjectLabel: 'S', visibility: 'workspace' },
      {
        subjectType: 'session',
        subjectId: 's',
        subjectLabel: 'S',
        visibility: 'public',
        include: { technicalDetails: true, outputFiles: false },
        expiry: '7 days',
        passphrase: 'open sesame',
      },
      {
        subjectType: 'agent',
        subjectId: 'a',
        subjectLabel: 'A',
        visibility: 'workspace',
        mode: 'definition',
      },
      {
        subjectType: 'agent',
        subjectId: 'a',
        subjectLabel: 'A',
        visibility: 'public',
        mode: 'runnable',
        budgetCapUsd: 5,
      },
      {
        subjectType: 'project',
        subjectId: 'p',
        subjectLabel: 'P',
        visibility: 'private',
        expiry: 'never',
      },
      { subjectType: 'skill', subjectId: 'k', subjectLabel: 'K', visibility: 'workspace' },
    ];
    for (const command of accepted) {
      expect(() => parsePublishShareRequest(command), JSON.stringify(command)).not.toThrow();
      expect(parsePublishShareRequest(command)).toEqual(command);
    }
    const refused: readonly unknown[] = [
      {
        subjectType: 'session',
        subjectId: 's',
        subjectLabel: 'S',
        visibility: 'workspace',
        mode: 'definition',
      },
      {
        subjectType: 'agent',
        subjectId: 'a',
        subjectLabel: 'A',
        visibility: 'workspace',
        include: {},
      },
      {
        subjectType: 'agent',
        subjectId: 'a',
        subjectLabel: 'A',
        visibility: 'workspace',
        budgetCapUsd: 5,
      },
      {
        subjectType: 'project',
        subjectId: 'p',
        subjectLabel: 'P',
        visibility: 'public',
        budgetCapUsd: 5,
      },
      {
        subjectType: 'session',
        subjectId: 's',
        subjectLabel: 'S',
        visibility: 'workspace',
        extra: 1,
      },
      // Until RF-103 the route requires the label the SDK's command carries.
      { subjectType: 'session', subjectId: 's', visibility: 'workspace' },
    ];
    for (const body of refused) {
      expect(() => parsePublishShareRequest(body), JSON.stringify(body)).toThrow();
    }
  });

  describe('sharing policy', () => {
    let publicSharing = false;
    const unused = (): Promise<never> =>
      Promise.reject(new Error('not used by the sharing-policy routes'));
    const sharing: WorkspaceSharing = {
      shares: {
        list: unused,
        get: unused,
        findByToken: unused,
        create: unused,
        getPublicSharingEnabled: () => Promise.resolve(publicSharing),
        setPublicSharingEnabled: (enabled) => {
          publicSharing = enabled;
          return Promise.resolve();
        },
        revoke: unused,
        setSuspended: unused,
        stop: unused,
        reserveVisitorMessage: unused,
        linkRun: unused,
      },
      views: { record: unused, count: unused, countVisitorSince: unused },
      audit: { write: () => Promise.resolve(), count: unused, list: unused },
    };

    const roleOf = (request: Request): 'owner' | 'admin' =>
      request.headers.get(SHARES_ROLE_HEADER) === 'admin' ? 'admin' : 'owner';

    const policyRequest = (method: 'GET' | 'PATCH', role: 'owner' | 'admin', body?: string) =>
      new Request('https://example.invalid/api/sharing-policies', {
        method,
        headers: {
          [SHARES_ROLE_HEADER]: role,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });

    afterEach(() => {
      clearSharesRuntime();
      clearRbacRuntime();
    });

    it('answers both routes through the real handlers with the published envelope', async () => {
      configureSharesRuntime({
        resolveActor: (request) =>
          Promise.resolve({
            kind: 'workspace',
            workspaceId: SHARES_WORKSPACE,
            principalId: SHARES_PRINCIPAL,
            ownerPrincipalId: SHARES_PRINCIPAL,
            userId: null,
            userLabel: 'Conformance key',
            role: roleOf(request),
          }),
        forWorkspace: () => Promise.resolve(sharing),
        resolvePublic: unused,
        sharingMaterials: unused,
        subjectOwnership: unused,
        runPublic: unused,
      });
      configureRbacRuntime({
        directory: createMemoryDirectory(),
        identify: (request) =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: SHARES_PRINCIPAL,
              apiKeyId: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
              workspaceId: SHARES_WORKSPACE,
              role: roleOf(request),
              label: 'Conformance key',
            }),
          ),
      });

      const read = await readSharingPolicy(policyRequest('GET', 'admin'));
      expect(read.status).toBe(200);
      expect(SharingPolicySchema.parse(await read.json())).toEqual({ publicSharing: false });

      const enabled = await patchSharingPolicy(
        policyRequest('PATCH', 'owner', JSON.stringify({ publicSharing: true })),
      );
      expect(enabled.status).toBe(200);
      expect(SharingPolicySchema.parse(await enabled.json())).toEqual({ publicSharing: true });
      expect(publicSharing).toBe(true);

      const reread = await readSharingPolicy(policyRequest('GET', 'owner'));
      expect(SharingPolicySchema.parse(await reread.json())).toEqual({ publicSharing: true });

      const asAdmin = await patchSharingPolicy(
        policyRequest('PATCH', 'admin', JSON.stringify({ publicSharing: false })),
      );
      expect(asAdmin.status).toBe(403);
      expect(publicSharing).toBe(true);

      const notBoolean = await patchSharingPolicy(
        policyRequest('PATCH', 'owner', JSON.stringify({ publicSharing: 'yes' })),
      );
      expect(notBoolean.status).toBe(400);
      const refusal: unknown = await notBoolean.json();
      expect(refusal).toMatchObject({ error: { code: 'invalid_policy' } });
    });
  });
});

describe('sessions', () => {
  const SESSIONS_WORKSPACE = '44444444-4444-4444-8444-444444444444';
  const SESSIONS_AGENT = '11111111-1111-4111-8111-111111111111';
  const SESSIONS_PROJECT = '66666666-6666-4666-8666-666666666666';
  const SESSIONS_PRINCIPAL = 'a7367c68-ea61-4b03-bbf1-3cfd0fcac445';
  const SESSIONS_ROW = '55555555-5555-4555-8555-555555555555';
  const SESSIONS_PROVIDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sessionRow: SessionRecord = {
    id: SESSIONS_ROW,
    workspaceId: SESSIONS_WORKSPACE,
    agentId: SESSIONS_AGENT,
    userId: null,
    ownerPrincipalId: SESSIONS_PRINCIPAL,
    projectId: null,
    engineSessionId: null,
    engine: null,
    agentVersionId: null,
    title: null,
    status: 'active',
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
  };

  afterEach(() => {
    resetSessionApi();
    clearProjectsRuntime();
    clearRbacRuntime();
  });

  it('serialises a fresh session row and a resumable, titled one into the published shape', () => {
    expect(SessionResourceSchema.safeParse(serializeSession(sessionRow)).success).toBe(true);
    const resumable = serializeSession({
      ...sessionRow,
      userId: '77777777-7777-4777-8777-777777777777',
      projectId: SESSIONS_PROJECT,
      engineSessionId: SESSIONS_PROVIDER_ID,
      engine: 'claude-agent-sdk' as const,
      title: 'Incident 42',
      updatedAt: new Date('2026-09-21T10:05:00.000Z'),
    });
    const parsed = SessionResourceSchema.parse(resumable);
    expect(parsed.resumable).toBe(true);
    expect(parsed.updatedAt).toBe('2026-09-21T10:05:00.000Z');
    expect(SessionResponseSchema.safeParse({ session: resumable }).success).toBe(true);
    expect(serializeSession(null)).toBeNull();
  });

  it('restates the session statuses and the transcript key grammar the server enforces', () => {
    // The server keeps no status tuple (`SessionRecord.status` is a type union), so the
    // vocabulary is proven through the serializer: both of its states satisfy the contract.
    for (const status of SESSION_STATUSES) {
      expect(
        SessionResourceSchema.safeParse(serializeSession({ ...sessionRow, status })).success,
      ).toBe(true);
    }
    expect(SERVER_PROJECT_KEY_PATTERN.source).toBe(PROJECT_KEY_PATTERN.source);
    expect(SERVER_SUBPATH_PATTERN.source).toBe(TRANSCRIPT_SUBPATH_PATTERN.source);
    expect(SERVER_MAX_SUBPATH_LENGTH).toBe(TRANSCRIPT_SUBPATH_MAX_LENGTH);
  });

  it('renders the transcript and subkeys routes into the published envelopes', async () => {
    const store = new InMemoryTranscriptStore();
    installSessionApi({
      authenticate: () =>
        Promise.resolve({
          kind: 'user',
          principalId: SESSIONS_PRINCIPAL,
          ownerPrincipalId: SESSIONS_PRINCIPAL,
          userId: null,
          workspaceId: SESSIONS_WORKSPACE,
          role: 'builder',
        }),
      canAccessSession: () => Promise.resolve(true),
      store,
    });
    const main = { projectKey: SESSIONS_WORKSPACE, sessionId: SESSIONS_PROVIDER_ID };
    await store.append(main, [
      { type: 'user', uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z', message: {} },
      { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    await store.append({ ...main, subpath: 'subagents/agent-1a2b' }, [{ type: 'user' }]);
    const base = `https://control.example/api/sessions/${SESSIONS_PROVIDER_ID}`;
    const transcript = await loadTranscript(
      new Request(`${base}/transcript?projectKey=${SESSIONS_WORKSPACE}`),
      SESSIONS_PROVIDER_ID,
    );
    expect(transcript.status).toBe(200);
    expect(TranscriptResponseSchema.parse(await transcript.json()).entries).toHaveLength(2);
    const subagent = await loadTranscript(
      new Request(
        `${base}/transcript?projectKey=${SESSIONS_WORKSPACE}&subpath=subagents%2Fagent-1a2b`,
      ),
      SESSIONS_PROVIDER_ID,
    );
    expect(TranscriptResponseSchema.parse(await subagent.json()).entries).toEqual([
      { type: 'user' },
    ]);
    const subkeys = await listTranscriptSubkeys(
      new Request(`${base}/subkeys?projectKey=${SESSIONS_WORKSPACE}`),
      SESSIONS_PROVIDER_ID,
    );
    expect(subkeys.status).toBe(200);
    expect(TranscriptSubkeysResponseSchema.parse(await subkeys.json()).subkeys).toEqual([
      'subagents/agent-1a2b',
    ]);
  });

  it('renders the same published envelopes when the request omits projectKey (issue #235, S-21)', async () => {
    const store = new InMemoryTranscriptStore();
    installSessionApi({
      authenticate: () =>
        Promise.resolve({
          kind: 'user',
          principalId: SESSIONS_PRINCIPAL,
          ownerPrincipalId: SESSIONS_PRINCIPAL,
          userId: null,
          workspaceId: SESSIONS_WORKSPACE,
          role: 'builder',
        }),
      canAccessSession: () => Promise.resolve(true),
      store,
    });
    const main = { projectKey: SESSIONS_WORKSPACE, sessionId: SESSIONS_PROVIDER_ID };
    await store.append(main, [{ type: 'user', uuid: 'u-1' }]);
    const base = `https://control.example/api/sessions/${SESSIONS_PROVIDER_ID}`;
    const transcript = await loadTranscript(
      new Request(`${base}/transcript`),
      SESSIONS_PROVIDER_ID,
    );
    expect(transcript.status).toBe(200);
    expect(TranscriptResponseSchema.parse(await transcript.json())).toEqual({
      entries: [{ type: 'user', uuid: 'u-1' }],
    });
    const subkeys = await listTranscriptSubkeys(
      new Request(`${base}/subkeys`),
      SESSIONS_PROVIDER_ID,
    );
    expect(subkeys.status).toBe(200);
    expect(TranscriptSubkeysResponseSchema.parse(await subkeys.json())).toEqual({ subkeys: [] });
  });

  it('renders a moved session from POST /api/projects/:id/sessions into the published shape', async () => {
    const destination: ProjectRecord = {
      id: SESSIONS_PROJECT,
      workspaceId: SESSIONS_WORKSPACE,
      name: 'Ops',
      instructions: null,
      defaultAgentId: SESSIONS_AGENT,
      defaultModelConnectionId: null,
      defaultModel: null,
      visibility: 'private',
      createdBy: null,
      ownerPrincipalId: SESSIONS_PRINCIPAL,
      archivedAt: null,
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    };
    const unused = () => Promise.reject(new Error('not reached by a session move'));
    const projects: ProjectRepository = {
      list: unused,
      get: (id) => Promise.resolve(id === destination.id ? destination : null),
      create: unused,
      createWithAssociations: unused,
      update: unused,
      updateWithAssociations: unused,
      moveSession: () => Promise.resolve({ kind: 'moved' }),
      archive: unused,
      restore: unused,
    };
    const agentVersions = { list: unused };
    const sessions: SessionRepository = {
      ensure: unused,
      get: (id) => Promise.resolve(id === sessionRow.id ? sessionRow : null),
      getByEngineSessionId: unused,
      list: unused,
      update: unused,
      archive: unused,
      restore: unused,
    };
    const files: ProjectFileRepository = { list: unused, add: unused, remove: unused };
    const mcpServers: ProjectMcpServerRepository = { list: unused, add: unused, remove: unused };
    const audit: AuditEventRepository = {
      write: () => Promise.resolve(),
      count: unused,
      list: unused,
    };
    const agents: AgentRepository = {
      list: unused,
      get: unused,
      create: unused,
      update: unused,
      delete: unused,
      replacePolicy: unused,
    };
    const principal = Principal.fromApiKey({
      principalId: SESSIONS_PRINCIPAL,
      apiKeyId: '9a5f38dd-dc4f-4b8d-8ccb-7e4578489b01',
      workspaceId: SESSIONS_WORKSPACE,
      role: 'builder',
      label: 'Builder key',
    });
    configureProjectsRuntime({
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: SESSIONS_WORKSPACE,
          principalId: SESSIONS_PRINCIPAL,
          ownerPrincipalId: SESSIONS_PRINCIPAL,
          userId: null,
          userLabel: 'Builder key',
        }),
      forWorkspace: () =>
        Promise.resolve({ projects, files, mcpServers, audit, agents, sessions, agentVersions }),
    });
    configureRbacRuntime({
      directory: createMemoryDirectory({ users: [] }),
      identify: () => Promise.resolve(principal),
    });
    const response = await postProjectSession(
      new Request(`https://control.example/api/projects/${SESSIONS_PROJECT}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSIONS_ROW }),
      }),
      { params: Promise.resolve({ id: SESSIONS_PROJECT }) },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(ProjectSessionMoveResponseSchema.parse(await response.json())).toEqual({
      projectId: SESSIONS_PROJECT,
      sessionId: SESSIONS_ROW,
    });
  });
});

describe('observability', () => {
  const OBSERVABILITY_WORKSPACE = 'aaaaaaaa-0b5e-4aaa-8aaa-aaaaaaaaaaaa';
  const OBSERVABILITY_AGENT = '11111111-0b5e-4111-8111-111111111111';
  const OBSERVABILITY_PRINCIPAL = '99999999-0b5e-4999-8999-999999999999';
  const OBSERVABILITY_VIEWER = 'viewer@observability.example.test';

  /** One row as the PostgreSQL repository's `list` returns it: a `Date`, not a string, for `createdAt`. */
  type ServerAuditRow = Awaited<ReturnType<AuditEventRepository['list']>>['items'][number];

  const auditRows: readonly ServerAuditRow[] = [
    {
      id: '77777777-0b5e-4777-8777-777777777777',
      workspaceId: OBSERVABILITY_WORKSPACE,
      actorUserId: '88888888-0b5e-4888-8888-888888888888',
      actorPrincipalId: OBSERVABILITY_PRINCIPAL,
      actorLabel: 'Ito',
      action: 'agent-changed',
      subjectId: OBSERVABILITY_AGENT,
      subjectLabel: 'Customer Support Agent',
      createdAt: new Date('2026-09-21T10:00:01.000Z'),
    },
    {
      id: '77777777-0b5e-4777-8777-777777777778',
      workspaceId: OBSERVABILITY_WORKSPACE,
      actorUserId: null,
      actorPrincipalId: null,
      actorLabel: 'system',
      action: 'public-sharing-policy-changed',
      subjectId: null,
      subjectLabel: 'Public sharing',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
    },
  ];

  /**
   * Drive the real route with an in-memory repository that records the limit it was asked for,
   * so what is proved is the handler's own body and its query parsing, not a re-statement of them.
   */
  async function callAuditRoute(
    search: string,
    options: {
      readonly role?: 'owner' | 'admin' | 'builder' | 'viewer' | null;
      readonly configured?: boolean;
    } = {},
  ): Promise<{ readonly status: number; readonly body: unknown; readonly limits: number[] }> {
    const limits: number[] = [];
    const repository: AuditEventRepository = {
      write: () => Promise.resolve(),
      count: () => Promise.resolve(auditRows.length),
      list: (input = {}) => {
        const limit = input.limit ?? AUDIT_LIST_DEFAULT_LIMIT;
        limits.push(limit);
        return Promise.resolve(keysetPageOf(auditRows, { limit, cursor: input.cursor ?? null }));
      },
    };
    const repositories: AuditEventRepositoryProvider = { forScope: () => repository };
    const scopes = createInMemoryWorkspaceScopeResolver([
      { id: TEST_WORKSPACE_ID, slug: 'observability' },
    ]);
    const role = options.role === undefined ? 'owner' : options.role;
    const harness = installRbacHarness(
      role === null
        ? []
        : [{ email: OBSERVABILITY_VIEWER, name: 'Caller', workspaceId: TEST_WORKSPACE_ID, role }],
    );
    try {
      if (options.configured === false) {
        clearAuditRuntime();
      } else {
        configureAuditRuntime({ scopes, repositories });
      }
      const response = await harness.call(getAuditEvents, {
        method: 'GET',
        path: `/api/audit-events${search}`,
        as: role === null ? null : { email: OBSERVABILITY_VIEWER },
      });
      return { status: response.status, body: response.body, limits };
    } finally {
      harness.teardown();
    }
  }

  it('renders the metrics projection into the published shape through the real route', async () => {
    const harness = installRbacHarness([
      {
        email: OBSERVABILITY_VIEWER,
        name: 'Viewer',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'viewer',
      },
    ]);
    try {
      recordRunTelemetry({
        runId: '33333333-0b5e-4333-8333-333333333333',
        workspaceId: TEST_WORKSPACE_ID,
        agentId: OBSERVABILITY_AGENT,
        status: 'completed',
        durationMs: 4000,
        costUsd: 0.001234,
      });
      recordRunTelemetry({
        runId: '33333333-0b5e-4333-8333-333333333334',
        workspaceId: TEST_WORKSPACE_ID,
        agentId: OBSERVABILITY_AGENT,
        status: 'failed',
        durationMs: 12,
        costUsd: null,
      });
      const response = await harness.call(getMetrics, {
        method: 'GET',
        path: '/api/metrics',
        as: { email: OBSERVABILITY_VIEWER },
      });
      expect(response.status, response.text).toBe(200);
      const parsed = RunTelemetryListResponseSchema.safeParse(response.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(parsed.data?.runs).toEqual(recentRunTelemetry(TEST_WORKSPACE_ID));
      expect(parsed.data?.runs.length).toBeGreaterThanOrEqual(2);
    } finally {
      harness.teardown();
    }
  });

  it('renders the audit rows into the published shape through the real route', async () => {
    const { status, body, limits } = await callAuditRoute('?limit=2');
    expect(status).toBe(200);
    const parsed = AuditEventListResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.events.map((event) => event.id)).toEqual(auditRows.map((row) => row.id));
    expect(parsed.data?.events[0]?.createdAt).toBe('2026-09-21T10:00:01.000Z');
    expect(parsed.data?.nextCursor).toBeNull();
    expect(limits).toEqual([2]);
  });

  it('pins the paged shape: a limit=1 walk parses page by page and ends on nextCursor null', async () => {
    const first = AuditEventListResponseSchema.parse((await callAuditRoute('?limit=1')).body);
    expect(first.events.map((event) => event.id)).toEqual([auditRows[0]?.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = AuditEventListResponseSchema.parse(
      (await callAuditRoute(`?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).body,
    );
    expect(second.events.map((event) => event.id)).toEqual([auditRows[1]?.id]);
    expect(second.nextCursor).toBeNull();
    const refused = await callAuditRoute('?cursor=not-a-cursor');
    expect(refused.status).toBe(400);
    expect(ApiProblemSchema.parse(refused.body).error.code).toBe('invalid_cursor');
  });

  it('applies the default limit the contract publishes and refuses the bounds it states', async () => {
    const defaulted = await callAuditRoute('');
    expect(defaulted.status).toBe(200);
    expect(defaulted.limits).toEqual([AUDIT_LIST_DEFAULT_LIMIT]);

    const ceiling = await callAuditRoute(`?limit=${String(AUDIT_LIST_MAX_LIMIT)}`);
    expect(ceiling.status).toBe(200);
    expect(ceiling.limits).toEqual([AUDIT_LIST_MAX_LIMIT]);

    for (const outOfRange of ['0', String(AUDIT_LIST_MAX_LIMIT + 1), '1.5', 'ten']) {
      const refused = await callAuditRoute(`?limit=${outOfRange}`);
      expect(refused.status, outOfRange).toBe(400);
      expect(ApiProblemSchema.parse(refused.body).error.code).toBe('invalid_limit');
      expect(refused.limits).toEqual([]);
    }
  });

  it('refuses every role but Owner in the standard envelope, and a missing session and runtime too', async () => {
    for (const role of ['admin', 'builder', 'viewer'] as const) {
      const refused = await callAuditRoute('', { role });
      expect(refused.status, role).toBe(403);
      expect(ApiProblemSchema.parse(refused.body).error.code, role).toBe('forbidden');
      expect(refused.limits, role).toEqual([]);
    }

    const anonymous = await callAuditRoute('', { role: null });
    expect(anonymous.status).toBe(401);
    expect(ApiProblemSchema.parse(anonymous.body).error.code).toBe('unauthenticated');

    const unconfigured = await callAuditRoute('', { configured: false });
    expect(unconfigured.status).toBe(503);
    expect(ApiProblemSchema.parse(unconfigured.body).error.code).toBe(
      'audit_runtime_not_configured',
    );
  });

  it('restates the same audit actions as the contract', () => {
    expect([...serverAuditActions]).toEqual([...AUDIT_ACTIONS]);
  });
});

describe('tokens (issue #236, SDK-04, S-1)', () => {
  const TOKENS_WORKSPACE_ID = TEST_WORKSPACE_ID;
  const TOKENS_OWNER = { email: 'tokens-conformance-owner@example.test' };
  const TOKENS_RUN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

  function tokensHarnessAndRuntime(): {
    readonly harness: ReturnType<typeof installRbacHarness>;
    readonly cleanup: () => void;
  } {
    const harness = installRbacHarness([
      { email: TOKENS_OWNER.email, name: 'Owner', workspaceId: TOKENS_WORKSPACE_ID, role: 'owner' },
    ]);
    configureTokensRuntime({
      findTarget: (principal, scope) =>
        Promise.resolve(
          scope.id === TOKENS_RUN_ID
            ? { kind: 'found', ownerPrincipalId: principal.principalId }
            : { kind: 'not-found' },
        ),
      issue: async (_principal, scope) => {
        if (scope.id !== TOKENS_RUN_ID) return null;
        const minted = await mintBrowserToken();
        return { token: minted.presented, expiresAt: new Date(Date.now() + 300_000) };
      },
    });
    return {
      harness,
      cleanup: () => {
        harness.teardown();
        clearTokensRuntime();
      },
    };
  }

  it('reads a real request through MintTokenRequestSchema and rejects what it rejects', async () => {
    const { harness, cleanup } = tokensHarnessAndRuntime();
    try {
      for (const body of [
        { scope: { kind: 'run', id: TOKENS_RUN_ID } },
        { scope: { kind: 'run', id: TOKENS_RUN_ID }, ttlSeconds: 600 },
      ]) {
        expect(MintTokenRequestSchema.safeParse(body).success).toBe(true);
        const response = await harness.call(mintTokenRoute, {
          method: 'POST',
          path: '/api/tokens',
          as: TOKENS_OWNER,
          body,
        });
        expect(response.status, JSON.stringify(body)).toBe(201);
      }
      for (const body of [
        {},
        { scope: { kind: 'run', id: TOKENS_RUN_ID }, extra: 1 },
        { scope: { kind: 'run', id: TOKENS_RUN_ID }, ttlSeconds: 1 },
      ]) {
        expect(MintTokenRequestSchema.safeParse(body).success).toBe(false);
        const response = await harness.call(mintTokenRoute, {
          method: 'POST',
          path: '/api/tokens',
          as: TOKENS_OWNER,
          body,
        });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
    } finally {
      cleanup();
    }
  });

  it('renders the real mint response into a body MintTokenResponseSchema accepts', async () => {
    const { harness, cleanup } = tokensHarnessAndRuntime();
    try {
      const response = await harness.call(mintTokenRoute, {
        method: 'POST',
        path: '/api/tokens',
        as: TOKENS_OWNER,
        body: { scope: { kind: 'run', id: TOKENS_RUN_ID } },
      });
      expect(response.status, response.text).toBe(201);
      const parsed = MintTokenResponseSchema.safeParse(response.body);
      expect(
        parsed.success,
        `the mint body does not satisfy MintTokenResponseSchema: ${JSON.stringify(parsed)}`,
      ).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.scope).toEqual({ kind: 'run', id: TOKENS_RUN_ID });
      expect(BROWSER_TOKEN_PATTERN.test(parsed.data.token)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('workspace switch, JSON branch (issue #236, SDK-04, S-2)', () => {
  const SWITCH_SECRET = 'workspace-switch-conformance-session-secret-32';
  const SWITCH_EMAIL = 'switch-conformance@example.test';
  const SWITCH_WORKSPACE = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    slug: 'switch-conformance',
    name: 'Switch Conformance',
  };

  function switchWorkspaceRepository(): WorkspaceRepositoryPort {
    const notImplemented = (): never => {
      throw new Error('not used by this conformance fixture');
    };
    const record = {
      id: SWITCH_WORKSPACE.id,
      slug: SWITCH_WORKSPACE.slug,
      name: SWITCH_WORKSPACE.name,
      publicSharingEnabled: false,
      archivedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    return {
      listForUser: notImplemented,
      get: (id) => Promise.resolve(id === record.id ? { ...record } : null),
      getForMember: (id) =>
        Promise.resolve(id === record.id ? { ...record, role: 'owner' as const } : null),
      create: notImplemented,
      update: notImplemented,
      archive: notImplemented,
      restore: notImplemented,
    };
  }

  it('renders the real 200 body into a shape WorkspaceSwitchResponseSchema accepts', async () => {
    const directory = createMemoryDirectory({
      workspaces: [SWITCH_WORKSPACE],
      users: [
        {
          email: SWITCH_EMAIL,
          name: 'Switcher',
          workspaceId: SWITCH_WORKSPACE.id,
          role: 'owner',
        },
      ],
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });
    configureWorkspacesRuntime({ repository: switchWorkspaceRepository() });
    const previousSecret = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = SWITCH_SECRET;
    try {
      const session = await mintSessionToken(
        newSessionClaims(SWITCH_EMAIL, SWITCH_WORKSPACE.slug),
        SWITCH_SECRET,
      );
      const response = await switchWorkspaceRoute(
        new Request('https://control-plane.test/api/auth/workspace', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://control-plane.test',
            host: 'control-plane.test',
            cookie: `${sessionCookieName()}=${session}`,
          },
          body: JSON.stringify({ workspace: SWITCH_WORKSPACE.slug }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const parsed = WorkspaceSwitchResponseSchema.safeParse(await response.json());
      expect(
        parsed.success,
        `the switch body does not satisfy WorkspaceSwitchResponseSchema: ${JSON.stringify(parsed)}`,
      ).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.workspace.slug).toBe(SWITCH_WORKSPACE.slug);
      expect(
        response.headers.getSetCookie().some((c) => c.startsWith(`${sessionCookieName()}=`)),
      ).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previousSecret;
      clearRbacRuntime();
      clearWorkspacesRuntime();
    }
  });

  it('renders a JSON-branch refusal (404 workspace_not_available) in the standard ApiProblem envelope', async () => {
    const directory = createMemoryDirectory({
      workspaces: [SWITCH_WORKSPACE],
      users: [
        {
          email: SWITCH_EMAIL,
          name: 'Switcher',
          workspaceId: SWITCH_WORKSPACE.id,
          role: 'owner',
        },
      ],
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });
    configureWorkspacesRuntime({ repository: switchWorkspaceRepository() });
    const previousSecret = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = SWITCH_SECRET;
    try {
      const session = await mintSessionToken(
        newSessionClaims(SWITCH_EMAIL, SWITCH_WORKSPACE.slug),
        SWITCH_SECRET,
      );
      const response = await switchWorkspaceRoute(
        new Request('https://control-plane.test/api/auth/workspace', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://control-plane.test',
            host: 'control-plane.test',
            cookie: `${sessionCookieName()}=${session}`,
          },
          body: JSON.stringify({ workspace: 'not-a-member-workspace' }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(404);
      const { error } = ApiProblemSchema.parse(await response.json());
      expect(error.code).toBe('workspace_not_available');
      expect(error.detail).toBe(error.message);
    } finally {
      if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previousSecret;
      clearRbacRuntime();
      clearWorkspacesRuntime();
    }
  });
});

/**
 * Issue #244 (SDK-12, S-7): the `426` the edge renders is the one the SDK reads. The body goes
 * through `ApiProblemSchema`, and the whole answer — body and served-range headers — through a real
 * client, which must raise the typed refusal with both versions.
 */
describe('contracts version negotiation (issue #244, SDK-12, S-7)', () => {
  it('pins the 426 body to the envelope and the SDK reads it as ContractsVersionUnsupportedError', async () => {
    const negotiation = negotiateContractsVersion('0.0.1');
    if (negotiation.kind !== 'refused') throw new Error('expected a refusal');
    expect(negotiation.status).toBe(426);
    expect(ApiProblemSchema.parse(negotiation.body).error.code).toBe(
      'contracts_version_unsupported',
    );

    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(negotiation.body), {
            status: negotiation.status,
            headers: { 'content-type': 'application/json', ...servedContractsHeaders() },
          }),
        ),
    });
    const failure: unknown = await client.me().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractsVersionUnsupportedError);
    // The client here is on the served version, so the headers alone judge it served; the typed
    // error still carries the server's message, which names the refused version and the range.
    const refusal = failure as ContractsVersionUnsupportedError;
    expect(refusal.message).toContain('0.0.1');
    expect(refusal.message).toContain(CONTRACTS_VERSION);
  });
});

/**
 * S1-05 (issue #443): the version routes' serialisers render the shapes the contracts publish, and
 * every code the version pipeline can answer is one `AGENT_VERSION_PROBLEM_CODES` names, under the
 * same status — the table an SDK consumer branches on.
 */
describe('agent versions (S1-05, issue #443)', () => {
  const record = {
    id: 'version-1',
    workspaceId: WORKSPACE,
    agentId: AGENT,
    number: 1,
    summary: 'First version',
    via: 'aw-push' as const,
    body: versionRequest().body,
    createdByPrincipalId: 'principal-1',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  };

  it('serialises a version, a listing and a dry run into the published shapes', () => {
    const resource = AgentVersionResourceSchema.safeParse(toAgentVersionResource(record));
    expect(resource.success, JSON.stringify(resource.error)).toBe(true);
    const listing = AgentVersionListResponseSchema.safeParse(
      toAgentVersionListResponse(
        {
          versions: [record],
          pointers: [
            {
              agentId: AGENT,
              environment: 'local',
              versionId: record.id,
              number: 1,
              updatedAt: new Date('2026-10-01T11:00:00.000Z'),
            },
          ],
          materialisedVersionId: record.id,
        },
        [
          {
            environment: 'local',
            number: 1,
            reason: 'set',
            movedByPrincipalId: 'principal-1',
            movedAt: new Date('2026-10-01T11:00:00.000Z'),
          },
        ],
        [{ version: 1, score: 0.9, passed: 9, total: 10 }],
      ),
    );
    expect(listing.success, JSON.stringify(listing.error)).toBe(true);
    expect(listing.data?.materialised).toBe(1);
    expect(listing.data?.moves).toHaveLength(1);
    expect(listing.data?.evaluations).toHaveLength(1);
  });

  it('answers a dry run with the published check response', async () => {
    const agents = createInMemoryAgentStoreProvider();
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name: 'Support triage',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
      { principalId: 'principal-1', userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    const store = await createInMemoryAgentVersionStoreProvider({ agents }).forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    const checked = await createAgentVersion(
      { ...versionRequest(), dryRun: true },
      created.agent,
      'principal-1',
      { store },
    );
    expect(AgentVersionCheckResponseSchema.safeParse(checked.body).success).toBe(true);
  });

  it('answers every pipeline refusal with a code and status AGENT_VERSION_PROBLEM_CODES publishes', async () => {
    const agent = {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: 'Support triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] } },
      createdBy: null,
      ownerPrincipalId: 'principal-1',
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
      updatedAt: new Date('2026-10-01T10:00:00.000Z'),
    };
    const store = await createInMemoryAgentVersionStoreProvider({
      agents: createInMemoryAgentStoreProvider(),
      references: {
        [WORKSPACE]: {
          connector: [
            { id: 'c1', name: 'crm' },
            { id: 'c2', name: 'crm' },
            { id: 'c3', name: 'tickets' },
          ],
        },
      },
    }).forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    const published: Readonly<Record<string, number>> = AGENT_VERSION_PROBLEM_CODES;
    const limits = FIXTURE_POLICY.limits;
    const bodies: readonly [unknown, readonly string[] | undefined][] = [
      [{ summary: '' }, undefined],
      [versionRequest(), ['pi']],
      [
        versionRequest({
          policy: {
            ...FIXTURE_POLICY,
            tools: {
              ...FIXTURE_POLICY.tools,
              permissionMode: 'bypassPermissions',
              allowDangerouslySkipPermissions: true,
            },
          },
        }),
        undefined,
      ],
      [versionRequest({ resources: { skills: ['triage'] } }), undefined],
      [versionRequest({ resources: { connectors: ['crm'] } }), undefined],
      [
        versionRequest({
          policy: { engine: 'pi', skills: { mode: 'all' }, limits },
          resources: { connectors: ['tickets'] },
        }),
        undefined,
      ],
      [
        versionRequest({ policy: { engine: 'openai-agents', skills: { mode: 'all' }, limits } }),
        undefined,
      ],
    ];
    const seen = new Set<string>();
    for (const [body, registered] of bodies) {
      const result = await createAgentVersion(body, agent, 'principal-1', {
        store,
        ...(registered === undefined ? {} : { registered }),
      });
      if (result.status < 400) throw new Error(`expected a refusal for ${JSON.stringify(body)}`);
      const envelope = ApiProblemSchema.parse(result.body);
      const code = envelope.error.code;
      expect(published[code], code).toBe(result.status);
      seen.add(code);
    }
    expect([...seen].sort()).toEqual([
      'agent_definition_reference_ambiguous',
      'agent_definition_references_missing',
      'dangerous_permission_mode_refused',
      'engine_capability_unsupported',
      'engine_switch_would_widen',
      'invalid_agent_version',
      'unsupported_engine',
    ]);
  });
});

/**
 * S1-06 (issue #444): the pointer move and create-from-version render the shapes the contracts
 * publish, and every code they answer — `agent_name_conflict` (409) included, published since
 * issue #480 — is one `AGENT_VERSION_PROBLEM_CODES` names under the same status. S1-09 (issue
 * #447): the SDK's `agents.create`, `agents.versions.*` and `agents.pointers.set` read those
 * handler answers back as the parsed shapes and the typed refusal.
 */
describe('agent pointers and create-from-version (S1-06, issue #444)', () => {
  const OWNER = 'principal-1';

  async function workspace() {
    const agents = createInMemoryAgentStoreProvider();
    const provider = createInMemoryAgentVersionStoreProvider({ agents });
    const store = await provider.forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    return { agents: agents.forWorkspace(WORKSPACE), store };
  }

  it('serialises a pointer move, a create-from-version and its dry run into the published shapes', async () => {
    const { agents, store } = await workspace();
    const owner = { principalId: OWNER, ownerPrincipalId: OWNER, userId: null };
    const checked = await createAgentFromVersion(fromVersionRequest({ dryRun: true }), owner, {
      store,
      agents,
    });
    expect(AgentVersionCheckResponseSchema.safeParse(checked.body).success).toBe(true);

    const created = await createAgentFromVersion(fromVersionRequest(), owner, { store, agents });
    const createdBody = CreateAgentFromVersionResponseSchema.safeParse(created.body);
    expect(createdBody.success, JSON.stringify(createdBody.error)).toBe(true);
    if (!createdBody.success) return;

    const agent = await agents.get(createdBody.data.agent.id);
    if (agent === null) throw new Error('the created agent exists');
    const moved = await setAgentPointer(
      { environment: 'local', version: 1 },
      agent,
      { principalId: OWNER, userId: null, actor: 'conformance key' },
      { store },
    );
    const movedBody = SetAgentPointerResponseSchema.safeParse(moved.body);
    expect(movedBody.success, JSON.stringify(movedBody.error)).toBe(true);
  });

  it('answers every refusal with a published code and status', async () => {
    const { agents, store } = await workspace();
    const owner = { principalId: OWNER, ownerPrincipalId: OWNER, userId: null };
    const actor = { principalId: OWNER, userId: null, actor: 'conformance key' };
    const first = await createAgentFromVersion(
      fromVersionRequest({ surfaces: [fixtureSurface('main')] }),
      owner,
      { store, agents },
    );
    const firstAgent = CreateAgentFromVersionResponseSchema.parse(first.body).agent;
    const other = await createAgentFromVersion(fromVersionRequest({ name: 'Billing' }), owner, {
      store,
      agents,
    });
    const otherAgent = await agents.get(
      CreateAgentFromVersionResponseSchema.parse(other.body).agent.id,
    );
    if (otherAgent === null) throw new Error('the second agent exists');
    const saved = await createAgentVersion(
      versionRequest({ name: 'Billing', surfaces: [fixtureSurface('main', 'Billing')] }),
      otherAgent,
      OWNER,
      { store },
    );
    expect(saved.status).toBe(201);
    const renamed = await createAgentVersion(
      versionRequest({ name: firstAgent.name }),
      otherAgent,
      OWNER,
      { store },
    );
    expect(renamed.status).toBe(201);

    const results = [
      await createAgentFromVersion({ version: { summary: '' } }, owner, { store, agents }),
      await createAgentFromVersion(fromVersionRequest({ name: 'New' }), owner, {
        store,
        agents,
        registered: ['pi'],
      }),
      await createAgentFromVersion(
        fromVersionRequest({ name: 'New', resources: { skills: ['triage'] } }),
        owner,
        { store, agents },
      ),
      await createAgentFromVersion(fromVersionRequest(), owner, { store, agents }),
      await createAgentFromVersion(
        fromVersionRequest({ name: 'New', surfaces: [fixtureSurface('main', 'New')] }),
        owner,
        { store, agents },
      ),
      await setAgentPointer({ environment: 'preview', version: 1 }, otherAgent, actor, { store }),
      await setAgentPointer({ environment: 'local', version: 9 }, otherAgent, actor, { store }),
      await setAgentPointer({ environment: 'local', version: 2 }, otherAgent, actor, { store }),
      await setAgentPointer({ environment: 'local', version: 3 }, otherAgent, actor, { store }),
    ];
    const published: Readonly<Record<string, number>> = AGENT_VERSION_PROBLEM_CODES;
    const seen = new Set<string>();
    for (const result of results) {
      const code = ApiProblemSchema.parse(result.body).error.code;
      expect(published[code], code).toBe(result.status);
      seen.add(code);
    }
    expect([...seen].sort()).toEqual([
      'agent_definition_references_missing',
      'agent_name_conflict',
      'agent_version_not_found',
      'invalid_agent_version',
      'surface_name_taken',
      'unsupported_engine',
    ]);
  });

  it('S1-09: the SDK reads each handler answer as the parsed shape or the typed refusal', async () => {
    /** A client whose one request is answered with `result`, as the route would serve it. */
    function served(result: { readonly status: number; readonly body: unknown }) {
      return createClient({
        baseUrl: 'https://aw.example.com',
        auth: { kind: 'api-key', apiKey: 'ak_live_k' },
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify(result.body), {
              status: result.status,
              headers: { 'content-type': 'application/json', ...servedContractsHeaders() },
            }),
          ),
      });
    }
    const { agents, store } = await workspace();
    const owner = { principalId: OWNER, ownerPrincipalId: OWNER, userId: null };
    const { version } = fromVersionRequest();

    const checked = await createAgentFromVersion(fromVersionRequest({ dryRun: true }), owner, {
      store,
      agents,
    });
    const sdkChecked = await served(checked).agents.create({ version, dryRun: true });
    expect(sdkChecked).toEqual(AgentVersionCheckResponseSchema.parse(checked.body));

    const created = await createAgentFromVersion(fromVersionRequest(), owner, { store, agents });
    const sdkCreated = await served(created).agents.create({ version });
    expect(sdkCreated).toEqual(CreateAgentFromVersionResponseSchema.parse(created.body));
    const agent = await agents.get(sdkCreated.agent.id);
    if (agent === null) throw new Error('the created agent exists');

    const { summary, via, body } = versionRequest({
      instructions: 'Answer support mail politely.',
    });
    const draft = { summary, via, body };
    const versionCheck = await createAgentVersion({ ...draft, dryRun: true }, agent, OWNER, {
      store,
    });
    expect(await served(versionCheck).agents.versions.check(agent.id, draft)).toEqual({
      ok: true,
      number: 2,
    });
    const saved = await createAgentVersion(draft, agent, OWNER, { store });
    const sdkSaved = await served(saved).agents.versions.create(agent.id, draft);
    expect(sdkSaved).toEqual(AgentVersionResourceSchema.parse(saved.body));
    expect(sdkSaved.number).toBe(2);

    const moved = await setAgentPointer(
      { environment: 'local', version: 2 },
      agent,
      { principalId: OWNER, userId: null, actor: 'conformance key' },
      { store },
    );
    const sdkMoved = await served(moved).agents.pointers.set(agent.id, {
      environment: 'local',
      version: 2,
    });
    expect(sdkMoved).toEqual(SetAgentPointerResponseSchema.parse(moved.body));
    expect(sdkMoved.pointer.number).toBe(2);

    const collision = await createAgentFromVersion(fromVersionRequest(), owner, { store, agents });
    const failure: unknown = await served(collision)
      .agents.create({ version })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const refusal = failure as ApiProblemError;
    expect([refusal.status, refusal.code]).toEqual([collision.status, 'agent_name_conflict']);
    expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.agent_name_conflict);
  });
});

describe('policy_cannot_widen (issue #535)', () => {
  it('reaches an SDK client as ApiProblemError whose details round-trip, under the published status', async () => {
    const { ceilingFor } = recordingCeilingFor({
      permissions: { runCommands: false },
      models: ['claude-sonnet-4-5'],
    });
    const refusal = await enforceCeiling(
      {
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: true,
          unrestrictedNetwork: false,
        },
        limits: { maxTurns: null, maxBudgetUsd: null },
        engine: 'claude-agent-sdk',
        model: 'gpt-5.1',
        tools: [],
      },
      ceilingFor(new Request('https://aw.example.com/'), WORKSPACE),
      null,
    );
    if (refusal === null) throw new Error('the configuration is over the ceiling');
    const details = ['permissions.runCommands', 'model:gpt-5.1'];
    expect(ApiProblemSchema.parse(refusal.body).error).toMatchObject({
      code: 'policy_cannot_widen',
      details,
    });
    expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.policy_cannot_widen);
    expect(refusal.status).toBe(RUN_START_PROBLEM_CODES.policy_cannot_widen);

    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(refusal.body), {
            status: refusal.status,
            headers: { 'content-type': 'application/json', ...servedContractsHeaders() },
          }),
        ),
    });
    const { summary, via, body } = versionRequest();
    const failure: unknown = await client.agents.versions
      .create('11111111-1111-4111-8111-111111111111', { summary, via, body })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problemError = failure as ApiProblemError;
    expect([problemError.status, problemError.code, problemError.details]).toEqual([
      403,
      'policy_cannot_widen',
      details,
    ]);
  });
});
