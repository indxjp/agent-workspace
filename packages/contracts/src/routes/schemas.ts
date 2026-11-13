import type { z } from 'zod';

import { A2aAgentCardSchema, A2aJsonRpcRequestSchema, A2aJsonRpcResponseSchema } from '../a2a.js';
import {
  AgentTeamListResponseSchema,
  AgentTeamResourceSchema,
  AgentTeamVersionListResponseSchema,
  AgentTeamVersionSchema,
  CreateAgentTeamRequestSchema,
  CreateAgentTeamVersionRequestSchema,
} from '../agent-teams.js';
import {
  AgentPointerMoveResponseSchema,
  AgentVersionCheckResponseSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  CreateAgentFromVersionResponseSchema,
  CreateAgentVersionRequestSchema,
  PromoteAgentRequestSchema,
  RollbackAgentRequestSchema,
  SetAgentPointerRequestSchema,
  SetAgentPointerResponseSchema,
  ToolBundleResponseSchema,
  UploadToolBundleRequestSchema,
  UploadToolBundleResponseSchema,
} from '../agent-versions.js';
import {
  AgentGrantsSchema,
  AgentListResponseSchema,
  AgentPolicyResponseSchema,
  AgentPolicySchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
  CreateAgentWithAssignmentsResponseSchema,
} from '../agents.js';
import {
  ApiKeyListResponseSchema,
  ApiKeyResponseSchema,
  MintedApiKeyResponseSchema,
} from '../api-keys.js';
import {
  CliTokenRequestSchema,
  CliTokenResponseSchema,
  DeviceAuthorizationResponseSchema,
} from '../cli-auth.js';
import {
  ConnectorListResponseSchema,
  ConnectorResourceSchema,
  TestConnectionOutcomeSchema,
} from '../connectors.js';
import {
  CreateEndpointClientRequestSchema,
  EndpointClientListResponseSchema,
  EndpointClientResponseSchema,
  MintEndpointKeyRequestSchema,
  RotateEndpointClientSecretResponseSchema,
  UpdateEndpointClientRequestSchema,
} from '../endpoint-clients.js';
import { EngineListResponseSchema } from '../engines.js';
import {
  AdvanceEvaluationRunRequestSchema,
  CreateEvaluationRequestSchema,
  CreateEvaluationRunRequestSchema,
  EvaluationResourceSchema,
  EvaluationRunResourceSchema,
} from '../evaluations.js';
import { UpdateWorkspaceFeaturesRequestSchema, WorkspaceFeaturesSchema } from '../features.js';
import { RunFeedbackListResponseSchema, RunFeedbackRequestSchema } from '../feedback.js';
import {
  CreateDownloadUrlRequestSchema,
  CreateUploadUrlRequestSchema,
  FileListResponseSchema,
  FileResponseSchema,
  FileSearchResponseSchema,
  MoveFileRequestSchema,
  MoveFileResponseSchema,
  PresignedUrlSchema,
  RemoveFileResponseSchema,
} from '../files.js';
import {
  AcceptedInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
} from '../invitations.js';
import {
  DeleteModelConnectionResponseSchema,
  DiscoveredModelsResponseSchema,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
} from '../models.js';
import { AuditEventListResponseSchema, RunTelemetryListResponseSchema } from '../observability.js';
import {
  PlatformExportRequestSchema,
  PlatformExportResponseSchema,
  PlatformListResponseSchema,
} from '../platforms.js';
import { ApiProblemSchema } from '../problem.js';
import {
  ProjectListResponseSchema,
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
  ProjectSessionResponseSchema,
} from '../projects.js';
import {
  AgentFrameSchema,
  RunFailedFrameDataSchema,
  RunStatusEventDataSchema,
  RunWarningEventDataSchema,
  StreamResetFrameDataSchema,
} from '../run-events.js';
import {
  InterruptRunResponseSchema,
  RevokeRunTokensResponseSchema,
  RunApprovalRequestSchema,
  RunApprovalResponseSchema,
  RunDetailResponseSchema,
  RunListResponseSchema,
  RunResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from '../runs.js';
import {
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
} from '../runtimes.js';
import { SecretListResponseSchema, SecretResourceSchema } from '../secrets.js';
import {
  SessionListResponseSchema,
  SessionResponseSchema,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
} from '../sessions.js';
import { ShareListResponseSchema, ShareResourceSchema } from '../shares.js';
import {
  PublishSkillRevisionRequestSchema,
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SkillRevisionResponseSchema,
} from '../skills.js';
import {
  CreateStorageConnectionInputSchema,
  StorageConnectionBrowseResponseSchema,
  StorageConnectionCredentialSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
  UpdateStorageConnectionPatchSchema,
} from '../storage-connections.js';
import { SurfaceAttachmentResponseSchema } from '../surfaces.js';
import {
  CreatedUserResponseSchema,
  MembershipListResponseSchema,
  MembershipResponseSchema,
  MeResponseSchema,
  UserListResponseSchema,
} from '../team.js';
import { TokenExchangeRequestSchema, TokenExchangeResponseSchema } from '../token-exchange.js';
import { MintTokenRequestSchema, MintTokenResponseSchema } from '../tokens.js';
import {
  CreateTriggerRequestSchema,
  CreateTriggerResponseSchema,
  TriggerListResponseSchema,
  TriggerResponseSchema,
  TriggerSecretResponseSchema,
  UpdateTriggerRequestSchema,
  ZoomUrlValidationResponseSchema,
} from '../triggers.js';
import {
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  WebhookListResponseSchema,
} from '../webhooks.js';
import {
  SharingPolicySchema,
  WorkspaceListResponseSchema,
  WorkspaceMembershipResponseSchema,
  WorkspaceResponseSchema,
  WorkspaceSwitchRequestSchema,
  WorkspaceSwitchResponseSchema,
} from '../workspaces.js';

/**
 * The route catalogue of the public `/api/**` surface: one entry per `METHOD /path`, naming the
 * contract schemas its request and responses are parsed with (SDK unit 13, issue #245, P-7).
 *
 * This is what `scripts/docs/generate-openapi.mjs` reads to emit the OpenAPI 3.1 document
 * (`docs/sdk/site/openapi.json`). The document is generated, never the source of truth: a schema
 * here is the same Zod value the server parses with and the SDK validates against, and the name
 * an entry carries is the key under which that value appears in {@link API_SCHEMAS} — so a
 * misspelt name is a type error, not a broken reference in the emitted document.
 *
 * `tests/docs/openapi.test.ts` holds this table equal, in both directions, to the declared route
 * inventory (`tests/route-declarations/**`) minus {@link API_ROUTE_EXCLUSIONS}: a route that lands
 * without an entry here fails the check.
 *
 * A body the contracts do not yet describe with a schema is declared `json-undescribed` rather
 * than guessed. That is an honest gap, listed by the generator, and closed by adding the schema to
 * the owning contract module — never by hand-editing the emitted document.
 */

/** Every contract schema an entry below may name, keyed by its exported name. */
export const API_SCHEMAS = {
  A2aAgentCardSchema,
  A2aJsonRpcRequestSchema,
  A2aJsonRpcResponseSchema,
  AcceptedInvitationResponseSchema,
  AdvanceEvaluationRunRequestSchema,
  AgentFrameSchema,
  AgentGrantsSchema,
  AgentListResponseSchema,
  AgentPointerMoveResponseSchema,
  AgentPolicyResponseSchema,
  AgentPolicySchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
  AgentTeamListResponseSchema,
  AgentTeamResourceSchema,
  AgentTeamVersionListResponseSchema,
  AgentTeamVersionSchema,
  AgentVersionCheckResponseSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  ApiKeyListResponseSchema,
  ApiKeyResponseSchema,
  ApiProblemSchema,
  AuditEventListResponseSchema,
  CliTokenRequestSchema,
  CliTokenResponseSchema,
  ConnectorListResponseSchema,
  ConnectorResourceSchema,
  CreateAgentFromVersionResponseSchema,
  CreateAgentTeamRequestSchema,
  CreateAgentTeamVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  CreateAgentWithAssignmentsResponseSchema,
  CreateEndpointClientRequestSchema,
  CreateEvaluationRequestSchema,
  CreateEvaluationRunRequestSchema,
  CreateTriggerRequestSchema,
  CreateTriggerResponseSchema,
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  CreatedUserResponseSchema,
  DeleteModelConnectionResponseSchema,
  DiscoveredModelsResponseSchema,
  EndpointClientListResponseSchema,
  EndpointClientResponseSchema,
  EngineListResponseSchema,
  PlatformExportRequestSchema,
  PlatformExportResponseSchema,
  PlatformListResponseSchema,
  EvaluationResourceSchema,
  EvaluationRunResourceSchema,
  DeviceAuthorizationResponseSchema,
  CreateDownloadUrlRequestSchema,
  CreateUploadUrlRequestSchema,
  FileListResponseSchema,
  FileResponseSchema,
  FileSearchResponseSchema,
  InterruptRunResponseSchema,
  InvitationListResponseSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
  MeResponseSchema,
  MembershipListResponseSchema,
  MembershipResponseSchema,
  MintEndpointKeyRequestSchema,
  MintTokenRequestSchema,
  MintTokenResponseSchema,
  MintedApiKeyResponseSchema,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
  MoveFileRequestSchema,
  MoveFileResponseSchema,
  PresignedUrlSchema,
  ProjectListResponseSchema,
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
  ProjectSessionResponseSchema,
  PromoteAgentRequestSchema,
  RemoveFileResponseSchema,
  RevokeRunTokensResponseSchema,
  RollbackAgentRequestSchema,
  RotateEndpointClientSecretResponseSchema,
  RunFailedFrameDataSchema,
  RunFeedbackListResponseSchema,
  RunFeedbackRequestSchema,
  RunListResponseSchema,
  RunDetailResponseSchema,
  RunResponseSchema,
  RunStatusEventDataSchema,
  RunTelemetryListResponseSchema,
  RunWarningEventDataSchema,
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
  SecretListResponseSchema,
  SecretResourceSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResourceSchema,
  CreateStorageConnectionInputSchema,
  StorageConnectionCredentialSchema,
  UpdateStorageConnectionPatchSchema,
  StorageConnectionTestOutcomeSchema,
  StorageConnectionBrowseResponseSchema,
  SessionListResponseSchema,
  RunApprovalRequestSchema,
  RunApprovalResponseSchema,
  SessionResponseSchema,
  SetAgentPointerRequestSchema,
  SetAgentPointerResponseSchema,
  ShareListResponseSchema,
  ShareResourceSchema,
  SharingPolicySchema,
  PublishSkillRevisionRequestSchema,
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SkillRevisionResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  StreamResetFrameDataSchema,
  SurfaceAttachmentResponseSchema,
  TestConnectionOutcomeSchema,
  TokenExchangeRequestSchema,
  TokenExchangeResponseSchema,
  ToolBundleResponseSchema,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
  TriggerListResponseSchema,
  TriggerResponseSchema,
  TriggerSecretResponseSchema,
  UpdateEndpointClientRequestSchema,
  UpdateTriggerRequestSchema,
  UpdateWorkspaceFeaturesRequestSchema,
  UploadToolBundleRequestSchema,
  UploadToolBundleResponseSchema,
  UserListResponseSchema,
  WebhookListResponseSchema,
  WorkspaceFeaturesSchema,
  WorkspaceListResponseSchema,
  WorkspaceMembershipResponseSchema,
  WorkspaceResponseSchema,
  WorkspaceSwitchRequestSchema,
  WorkspaceSwitchResponseSchema,
  ZoomUrlValidationResponseSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;
