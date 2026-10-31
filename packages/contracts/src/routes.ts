import type { z } from 'zod';

import { A2aAgentCardSchema, A2aJsonRpcRequestSchema, A2aJsonRpcResponseSchema } from './a2a.js';
import {
  AgentGrantsSchema,
  AgentListResponseSchema,
  AgentPolicyResponseSchema,
  AgentPolicySchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
  CreateAgentWithAssignmentsResponseSchema,
} from './agents.js';
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
} from './agent-versions.js';
import {
  ApiKeyListResponseSchema,
  ApiKeyResponseSchema,
  MintedApiKeyResponseSchema,
} from './api-keys.js';
import {
  CliTokenRequestSchema,
  CliTokenResponseSchema,
  DeviceAuthorizationResponseSchema,
} from './cli-auth.js';
import {
  ConnectorListResponseSchema,
  ConnectorResourceSchema,
  TestConnectionOutcomeSchema,
} from './connectors.js';
import {
  CreateEndpointClientRequestSchema,
  EndpointClientListResponseSchema,
  EndpointClientResponseSchema,
  MintEndpointKeyRequestSchema,
  RotateEndpointClientSecretResponseSchema,
  UpdateEndpointClientRequestSchema,
} from './endpoint-clients.js';
import { EngineListResponseSchema } from './engines.js';
import {
  AdvanceEvaluationRunRequestSchema,
  CreateEvaluationRequestSchema,
  CreateEvaluationRunRequestSchema,
  EvaluationResourceSchema,
  EvaluationRunResourceSchema,
} from './evaluations.js';
import {
  UpdateWorkspaceFeaturesRequestSchema,
  WorkspaceFeaturesSchema,
  type RouteFeature,
} from './features.js';
import {
  PlatformExportRequestSchema,
  PlatformExportResponseSchema,
  PlatformListResponseSchema,
} from './platforms.js';
import { RunFeedbackListResponseSchema, RunFeedbackRequestSchema } from './feedback.js';
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
} from './files.js';
import {
  AcceptedInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
} from './invitations.js';
import {
  DeleteModelConnectionResponseSchema,
  DiscoveredModelsResponseSchema,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
} from './models.js';
import { AuditEventListResponseSchema, RunTelemetryListResponseSchema } from './observability.js';
import { ApiProblemSchema } from './problem.js';
import {
  ProjectListResponseSchema,
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
  ProjectSessionResponseSchema,
} from './projects.js';
import {
  AgentFrameSchema,
  RunFailedFrameDataSchema,
  RunStatusEventDataSchema,
  RunWarningEventDataSchema,
  StreamResetFrameDataSchema,
} from './run-events.js';
import {
  InterruptRunResponseSchema,
  RevokeRunTokensResponseSchema,
  RunApprovalRequestSchema,
  RunApprovalResponseSchema,
  RunListResponseSchema,
  RunResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from './runs.js';
import {
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
} from './runtimes.js';
import { SecretListResponseSchema, SecretResourceSchema } from './secrets.js';
import {
  CreateStorageConnectionInputSchema,
  StorageConnectionBrowseResponseSchema,
  StorageConnectionCredentialSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
  UpdateStorageConnectionPatchSchema,
} from './storage-connections.js';
import {
  SessionListResponseSchema,
  SessionResponseSchema,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
} from './sessions.js';
import { ShareListResponseSchema, ShareResourceSchema } from './shares.js';
import { TokenExchangeRequestSchema, TokenExchangeResponseSchema } from './token-exchange.js';
import { SurfaceAttachmentResponseSchema } from './surfaces.js';
import {
  PublishSkillRevisionRequestSchema,
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SkillRevisionResponseSchema,
  SKILL_IMPORT_MULTIPART,
} from './skills.js';
import {
  CreatedUserResponseSchema,
  MembershipListResponseSchema,
  MembershipResponseSchema,
  MeResponseSchema,
  UserListResponseSchema,
} from './team.js';
import { MintTokenRequestSchema, MintTokenResponseSchema } from './tokens.js';
import {
  CreateTriggerRequestSchema,
  CreateTriggerResponseSchema,
  TriggerListResponseSchema,
  TriggerResponseSchema,
  TriggerSecretResponseSchema,
  UpdateTriggerRequestSchema,
  ZoomUrlValidationResponseSchema,
} from './triggers.js';
import {
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  WebhookListResponseSchema,
} from './webhooks.js';
import {
  SharingPolicySchema,
  WorkspaceListResponseSchema,
  WorkspaceMembershipResponseSchema,
  WorkspaceResponseSchema,
  WorkspaceSwitchRequestSchema,
  WorkspaceSwitchResponseSchema,
} from './workspaces.js';

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

/** The name of a schema in {@link API_SCHEMAS}. */
export type ApiSchemaName = keyof typeof API_SCHEMAS;

/** The methods a public route answers. */
export type ApiRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What travels in a request or response body.
 *
 * - `json` — `application/json`, parsed with the named schema; more than one name lists the
 *   alternatives a route answers on the same status (a client tells them apart by shape).
 * - `json-undescribed` — `application/json` the contracts do not yet describe (see the header).
 * - `binary` — opaque bytes (`application/octet-stream`, or the stored file's own type).
 * - `event-stream` — `text/event-stream`; `frames` names the schemas of each frame's `data:`.
 * - `multipart` — `multipart/form-data`, its parts named in the order they must be sent.
 * - `none` — no body (`204`, or a request that sends nothing).
 */
export type ApiBody =
  | { readonly kind: 'json'; readonly schemas: readonly [ApiSchemaName, ...ApiSchemaName[]] }
  | { readonly kind: 'json-undescribed' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'event-stream'; readonly frames: readonly ApiSchemaName[] }
  | {
      readonly kind: 'multipart';
      readonly parts: readonly [ApiMultipartPart, ...ApiMultipartPart[]];
    }
  | { readonly kind: 'none' };

/**
 * One named part of a `multipart` body: a `text` field, or `file` bytes. A `repeated` part is
 * sent once per item under the same name, at least once.
 */
export interface ApiMultipartPart {
  readonly name: string;
  readonly type: 'text' | 'file';
  readonly repeated?: true;
  readonly description: string;
}

/**
 * One request header a route reads beyond the ones every route shares (the contracts version and
 * the credential). The header's value is a string; its rules and refusals are in `description`.
 */
export interface ApiRequestHeader {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

/** One success answer of a route. Failures are the standard envelope and are not listed per route. */
export interface ApiSuccess {
  readonly status: number;
  readonly body: ApiBody;
}

/** One public route and the contracts it is parsed with. */
export interface ApiRoute {
  readonly method: ApiRouteMethod;
  /** The path in the specification's own notation: `:id`, not `[id]` or `{id}`. */
  readonly path: string;
  /** Stable and unique: the SDK operation name where one exists (`agents.list`). */
  readonly operationId: string;
  /** The SDK resource family the route belongs to; the OpenAPI tag. */
  readonly tag: string;
  /**
   * The feature this route belongs to (ADR-0160 D4), or `core`. Required, so a route cannot be
   * added without saying which switch turns it off.
   */
  readonly feature: RouteFeature;
  readonly summary: string;
  /** Absent when the request carries no body. */
  readonly request?: ApiBody;
  /** Request headers this route reads beyond the shared ones; absent when it reads none. */
  readonly headers?: readonly ApiRequestHeader[];
  /**
   * Older request bodies the route still accepts beside `request`, each on its own media type,
   * kept for one release and then removed (04 §4). The OpenAPI document marks them deprecated.
   */
  readonly deprecatedRequests?: readonly ApiBody[];
  readonly success: readonly ApiSuccess[];
  /** Kept for one release and replaced by another route (04 §4). */
  readonly deprecated?: true;
  /**
   * How the caller proves who it is, when that is not the default — a workspace API key, a
   * browser token or the control plane's session cookie. Mirrors the public and identity-only
   * routes of `apps/web/server/rbac/authorisation-matrix.test.ts`:
   *
   * - `none` — no identity proof at all;
   * - `session-cookie` — only the control plane's own browser session (the route is exempt from
   *   the proxy's session gate and checks the cookie itself);
   * - `invitation-identity` — the invitation-identity cookie, not a workspace credential;
   * - `user-token` — only the `awu_live_` token `aw login` holds, which the route acts on itself
   *   (revoke it, move it to another workspace; ADR-0083);
   * - `endpoint-credential` — only an endpoint-scoped key, a workspace API key or (T1c) an OAuth
   *   access token, never a browser session: the published-agent endpoint (ADR-0135) is exempt
   *   from the proxy's session gate and authenticates the bearer itself.
   */
  readonly security?: ApiRouteSecurity;
}

/** A non-default credential requirement of a route (see {@link ApiRoute.security}). */
export type ApiRouteSecurity =
  'none' | 'session-cookie' | 'invitation-identity' | 'user-token' | 'endpoint-credential';

/**
 * Declared routes that are not part of the programmatic surface, and why. Two kinds (ADR-0080):
 *
 * - browser journeys — spec 04 §1 puts first-run setup, OIDC sign-in and the public share pages
 *   permanently out of scope;
 * - private runner routes — the transcript writes and the ENG-06 engine-state routes, which only
 *   `apps/runner` calls, with the signed per-run token rather than a workspace credential
 *   (`apps/web/server/sessions/state-api.ts`; 04 §5.11: runtime-only, not exposed by the SDK).
 *
 * The platform's own callers sit beside them: the cron jobs (`CRON_SECRET` bearer, ADR-0120) and
 * the readiness probe a kubelet calls with no credential (issue #1562). The `aw-control` MCP door a
 * running agent reaches through the gateway (issue #1846) accepts only a run token, as a `run-caller`.
 */
export const API_ROUTE_EXCLUSIONS: readonly {
  readonly method: ApiRouteMethod;
  readonly path: string;
  readonly feature: RouteFeature;
  readonly because: string;
}[] = [
  { method: 'POST', path: '/api/setup', feature: 'core', because: 'first-run setup (04 §1)' },
  { method: 'GET', path: '/api/auth/login', feature: 'core', because: 'OIDC sign-in (04 §1)' },
  { method: 'POST', path: '/api/auth/callback', feature: 'core', because: 'OIDC sign-in (04 §1)' },
  {
    method: 'GET',
    path: '/api/auth/workspace',
    feature: 'core',
    because: 'the HTML workspace-selection step of OIDC sign-in (04 §1)',
  },
  {
    method: 'GET',
    path: '/api/auth/cli-verify',
    feature: 'core',
    because: "the HTML page approving `aw login`'s code, a browser sign-in step (04 §1)",
  },
  {
    method: 'POST',
    path: '/api/auth/cli-verify',
    feature: 'core',
    because: "the form post approving `aw login`'s code, a browser sign-in step (04 §1)",
  },
  {
    method: 'GET',
    path: '/api/cron/retention',
    feature: 'core',
    because: 'platform cron job (CRON_SECRET bearer)',
  },
  {
    method: 'GET',
    path: '/api/cron/triggers',
    feature: 'triggers',
    because: 'platform cron job (CRON_SECRET bearer)',
  },
  {
    method: 'GET',
    path: '/api/cron/storage-cleanup',
    feature: 'core',
    because: 'platform cron job (CRON_SECRET bearer)',
  },
  {
    method: 'GET',
    path: '/api/readyz',
    feature: 'core',
    because: 'platform readiness probe (no credential)',
  },
  {
    method: 'POST',
    path: '/api/builder/mcp',
    feature: 'builder',
    because: 'run-caller route (per-run token, aw-control tools)',
  },
  { method: 'GET', path: '/p/:token', feature: 'sharing', because: 'a public share page (04 §1)' },
  {
    method: 'POST',
    path: '/p/:token/messages',
    feature: 'sharing',
    because: 'a public share page (04 §1)',
  },
  {
    method: 'GET',
    path: '/p/s/:name',
    feature: 'surfaces',
    because: 'a hosted surface page (04 §1)',
  },
  {
    method: 'POST',
    path: '/p/s/:name/sessions',
    feature: 'surfaces',
    because:
      "the hosted surface's session bootstrap: loopback, or an anonymous visitor from the surface's allowed origins (04 §1)",
  },
  {
    method: 'GET',
    path: '/p/s/:name/widget.js',
    feature: 'surfaces',
    because: 'the hosted surface widget loader (04 §1)',
  },
  {
    method: 'GET',
    path: '/p/s/:name/try',
    feature: 'surfaces',
    because: 'the hosted surface try page (04 §1)',
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/transcript',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'DELETE',
    path: '/api/sessions/:engineSessionId/transcript',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'PUT',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'DELETE',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/file-search',
    feature: 'files',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-streams',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-blobs',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'PUT',
    path: '/api/sessions/:engineSessionId/state-blobs',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    feature: 'core',
    because: 'OAuth 2.0 authorization server metadata (RFC 8414), a public discovery document',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/projects/:name',
    feature: 'projects',
    because: 'OAuth protected resource metadata (RFC 9728), a public discovery document',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/builder',
    feature: 'builder',
    because: 'OAuth protected resource metadata (RFC 9728), a public discovery document',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
    feature: 'core',
    because: 'OAuth protected resource metadata (RFC 9728), a public discovery document',
  },
  {
    method: 'GET',
    path: '/oauth/authorize',
    feature: 'core',
    because:
      'the HTML consent page of the OAuth authorization code grant, a browser sign-in step (04 §1)',
  },
  {
    method: 'POST',
    path: '/oauth/authorize',
    feature: 'core',
    because:
      'the consent form post of the OAuth authorization code grant, a browser sign-in step (04 §1)',
  },
  {
    method: 'POST',
    path: '/oauth/token',
    feature: 'core',
    because:
      'the OAuth token endpoint (RFC 6749), form-encoded and authenticated by the client secret or the grant, not by a workspace credential',
  },
  {
    method: 'POST',
    path: '/oauth/revoke',
    feature: 'core',
    because:
      'the OAuth token revocation endpoint (RFC 7009), form-encoded and authenticated by the client',
  },
];

const json = (first: ApiSchemaName, ...rest: ApiSchemaName[]): ApiBody => ({
  kind: 'json',
  schemas: [first, ...rest],
});
const UNDESCRIBED: ApiBody = { kind: 'json-undescribed' };
const BINARY: ApiBody = { kind: 'binary' };
const NONE: ApiBody = { kind: 'none' };
const ok = (body: ApiBody): readonly ApiSuccess[] => [{ status: 200, body }];
const created = (body: ApiBody): readonly ApiSuccess[] => [{ status: 201, body }];
const NO_CONTENT: readonly ApiSuccess[] = [{ status: 204, body: NONE }];

/** The catalogue, grouped by family in the order of spec 04 §5. */
export const API_ROUTES: readonly ApiRoute[] = [
  // §3 / §5.1 — identity, workspaces, tokens
  {
    method: 'GET',
    path: '/api/me',
    operationId: 'me',
    tag: 'me',
    feature: 'core',
    summary: 'Read the calling principal, its workspace and role',
    success: ok(json('MeResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/workspaces',
    operationId: 'workspaces.list',
    tag: 'workspaces',
    feature: 'core',
    summary: 'List the workspaces the caller belongs to',
    success: ok(json('WorkspaceListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/workspaces',
    operationId: 'workspaces.create',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Create a workspace',
    request: UNDESCRIBED,
    success: created(json('WorkspaceMembershipResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/workspaces/:id',
    operationId: 'workspaces.get',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Read one workspace and the caller membership in it',
    success: ok(json('WorkspaceMembershipResponseSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/workspaces/:id',
    operationId: 'workspaces.update',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Rename a workspace',
    request: UNDESCRIBED,
    success: ok(json('WorkspaceResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/workspaces/:id/features',
    operationId: 'workspaces.features.list',
    tag: 'workspaces',
    feature: 'core',
    summary: 'List the features of a workspace and whether each is on',
    success: ok(json('WorkspaceFeaturesSchema')),
  },
  {
    method: 'PUT',
    path: '/api/workspaces/:id/features',
    operationId: 'workspaces.features.set',
    tag: 'workspaces',
    feature: 'core',
    summary: 'Replace the set of features a workspace has switched off (Owner only)',
    request: json('UpdateWorkspaceFeaturesRequestSchema'),
    success: ok(json('WorkspaceFeaturesSchema')),
  },
  {
    method: 'POST',
    path: '/api/auth/workspace',
    operationId: 'workspaces.select',
    tag: 'workspaces',
    feature: 'core',
    summary: "Switch the session's workspace",
    request: json('WorkspaceSwitchRequestSchema'),
    success: ok(json('WorkspaceSwitchResponseSchema')),
    security: 'session-cookie',
  },
  {
    method: 'POST',
    path: '/api/auth/cli-workspace',
    operationId: 'workspaces.selectForUserToken',
    tag: 'workspaces',
    feature: 'core',
    summary: "Move the CLI's user token to another of the person's workspaces",
    request: json('WorkspaceSwitchRequestSchema'),
    success: ok(json('WorkspaceSwitchResponseSchema')),
    security: 'user-token',
  },
  {
    method: 'POST',
    path: '/api/auth/cli-device',
    operationId: 'auth.startDevice',
    tag: 'auth',
    feature: 'core',
    summary: 'Start a device authorization for `aw login` (RFC 8628)',
    success: ok(json('DeviceAuthorizationResponseSchema')),
    security: 'none',
  },
  {
    method: 'POST',
    path: '/api/auth/cli-token',
    operationId: 'auth.pollToken',
    tag: 'auth',
    feature: 'core',
    summary: 'Poll with the device code; the user token once the person approved',
    request: json('CliTokenRequestSchema'),
    success: ok(json('CliTokenResponseSchema')),
    security: 'none',
  },
  {
    method: 'DELETE',
    path: '/api/auth/cli-token',
    operationId: 'auth.revoke',
    tag: 'auth',
    feature: 'core',
    summary: 'Revoke the presented user token (`aw logout`)',
    success: NO_CONTENT,
    security: 'user-token',
  },
  {
    method: 'POST',
    path: '/api/auth/token-exchange',
    operationId: 'auth.exchange',
    tag: 'auth',
    feature: 'core',
    summary:
      "Exchange the signed-in person's OIDC ID token for a short-lived access token of an app-backend endpoint client (ADR-0161)",
    request: json('TokenExchangeRequestSchema'),
    success: ok(json('TokenExchangeResponseSchema')),
    security: 'none',
  },
  {
    method: 'GET',
    path: '/api/sharing-policies',
    operationId: 'workspaces.sharingPolicy.get',
    tag: 'workspaces',
    feature: 'sharing',
    summary: "Read the workspace's sharing policy",
    success: ok(json('SharingPolicySchema')),
  },
  {
    method: 'PATCH',
    path: '/api/sharing-policies',
    operationId: 'workspaces.sharingPolicy.set',
    tag: 'workspaces',
    feature: 'sharing',
    summary: "Change the workspace's sharing policy",
    request: json('SharingPolicySchema'),
    success: ok(json('SharingPolicySchema')),
  },
  {
    method: 'POST',
    path: '/api/tokens',
    operationId: 'tokens.mint',
    tag: 'tokens',
    feature: 'core',
    summary: 'Mint a short-lived browser token',
    request: json('MintTokenRequestSchema'),
    success: created(json('MintTokenResponseSchema')),
  },

  // §5.2 — principals
  {
    method: 'GET',
    path: '/api/memberships',
    operationId: 'team.members.list',
    tag: 'team',
    feature: 'core',
    summary: 'List the members of the workspace',
    success: ok(json('MembershipListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/memberships',
    operationId: 'team.members.add',
    tag: 'team',
    feature: 'core',
    summary: 'Add a user to the workspace',
    request: UNDESCRIBED,
    success: created(json('MembershipResponseSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/memberships/:id',
    operationId: 'team.members.setRole',
    tag: 'team',
    feature: 'core',
    summary: "Change a member's role",
    request: UNDESCRIBED,
    success: ok(json('MembershipResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/memberships/:id',
    operationId: 'team.members.remove',
    tag: 'team',
    feature: 'core',
    summary: 'Remove a member',
    success: NO_CONTENT,
  },
  {
    method: 'GET',
    path: '/api/users',
    operationId: 'team.users.list',
    tag: 'team',
    feature: 'core',
    summary: 'List users',
    success: ok(json('UserListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/users',
    operationId: 'team.users.create',
    tag: 'team',
    feature: 'core',
    summary: 'Create a user',
    request: UNDESCRIBED,
    success: created(json('CreatedUserResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/invitations',
    operationId: 'team.invitations.list',
    tag: 'team',
    feature: 'core',
    summary: 'List invitations',
    success: ok(json('InvitationListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/invitations',
    operationId: 'team.invitations.create',
    tag: 'team',
    feature: 'core',
    summary: 'Invite someone to the workspace',
    request: UNDESCRIBED,
    success: created(json('IssuedInvitationResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/invitations/:id',
    operationId: 'team.invitations.revoke',
    tag: 'team',
    feature: 'core',
    summary: 'Revoke an invitation',
    success: ok(json('InvitationResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/invitations/:id/resend',
    operationId: 'team.invitations.resend',
    tag: 'team',
    feature: 'core',
    summary: 'Re-issue an invitation',
    success: ok(json('IssuedInvitationResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/invitations/:id/accept',
    operationId: 'team.invitations.accept',
    tag: 'team',
    feature: 'core',
    summary: 'Accept an invitation',
    request: UNDESCRIBED,
    success: ok(json('AcceptedInvitationResponseSchema')),
    security: 'invitation-identity',
  },
  {
    method: 'GET',
    path: '/api/api-keys',
    operationId: 'team.apiKeys.list',
    tag: 'team',
    feature: 'core',
    summary: 'List API keys',
    success: ok(json('ApiKeyListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/api-keys',
    operationId: 'team.apiKeys.create',
    tag: 'team',
    feature: 'core',
    summary: 'Mint an API key; the secret is returned once',
    request: UNDESCRIBED,
    success: created(json('MintedApiKeyResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/api-keys/:id',
    operationId: 'team.apiKeys.revoke',
    tag: 'team',
    feature: 'core',
    summary: 'Revoke an API key',
    success: ok(json('ApiKeyResponseSchema')),
  },

  // ADR-0134 — endpoint clients and their endpoint-scoped API keys
  {
    method: 'GET',
    path: '/api/endpoint-clients',
    operationId: 'endpointClients.list',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'List endpoint clients',
    success: ok(json('EndpointClientListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/endpoint-clients',
    operationId: 'endpointClients.create',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Create an endpoint client for an MCP project or an A2A agent',
    request: json('CreateEndpointClientRequestSchema'),
    success: created(json('EndpointClientResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/endpoint-clients/:id',
    operationId: 'endpointClients.get',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Read one endpoint client',
    success: ok(json('EndpointClientResponseSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/endpoint-clients/:id',
    operationId: 'endpointClients.update',
    tag: 'endpointClients',
    feature: 'core',
    summary: "Change an endpoint client's agents or tool allow-list",
    request: json('UpdateEndpointClientRequestSchema'),
    success: ok(json('EndpointClientResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/endpoint-clients/:id',
    operationId: 'endpointClients.revoke',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Revoke an endpoint client and every key bound to it',
    success: ok(json('EndpointClientResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/endpoint-clients/:id/keys',
    operationId: 'endpointClients.mintKey',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Mint an endpoint-scoped API key; the secret is returned once',
    request: json('MintEndpointKeyRequestSchema'),
    success: created(json('MintedApiKeyResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/endpoint-clients/:id/secret',
    operationId: 'endpointClients.rotateSecret',
    tag: 'endpointClients',
    feature: 'core',
    summary: "Rotate an endpoint client's OAuth client secret; the secret is returned once",
    success: created(json('RotateEndpointClientSecretResponseSchema')),
  },

  // ADR-0144 — inbound triggers
  {
    method: 'GET',
    path: '/api/triggers',
    operationId: 'triggers.list',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'List triggers',
    success: ok(json('TriggerListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/triggers',
    operationId: 'triggers.create',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'Create a webhook or schedule trigger; a webhook URL secret is returned once',
    request: json('CreateTriggerRequestSchema'),
    success: created(json('CreateTriggerResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/triggers/:id',
    operationId: 'triggers.get',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'Read one trigger',
    success: ok(json('TriggerResponseSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/triggers/:id',
    operationId: 'triggers.update',
    tag: 'triggers',
    feature: 'triggers',
    summary: "Change a trigger's name, prompt template, enabled flag or Zoom secret token",
    request: json('UpdateTriggerRequestSchema'),
    success: ok(json('TriggerResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/triggers/:id',
    operationId: 'triggers.remove',
    tag: 'triggers',
    feature: 'triggers',
    summary: 'Delete a trigger and its delivery records',
    success: ok(json('TriggerResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/triggers/:id/secret',
    operationId: 'triggers.rotateSecret',
    tag: 'triggers',
    feature: 'triggers',
    summary: "Rotate a webhook trigger's URL secret; the new secret is returned once",
    success: created(json('TriggerSecretResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/triggers/:id/fire/:secret',
    operationId: 'triggers.fire',
    tag: 'triggers',
    feature: 'triggers',
    summary:
      'Fire a webhook trigger: the body is the {{body}} of its prompt and a run starts as the ' +
      'trigger owner in a new session (202). The URL secret is the authentication and travels in ' +
      'the path, so it can appear in access logs of a proxy or CDN: rotate it if one may have ' +
      'leaked. Every miss answers one 404 trigger_not_found. A Microsoft Graph validationToken ' +
      'query parameter is echoed as text/plain, and Zoom endpoint.url_validation is answered with ' +
      'the token and its HMAC (200); neither starts a run.',
    request: { kind: 'binary' },
    success: [
      { status: 202, body: json('RunResponseSchema') },
      { status: 200, body: json('ZoomUrlValidationResponseSchema') },
    ],
    security: 'none',
  },

  // §5.17 — run-outcome webhooks (N-3, issue #250, ADR-SDK-18-N3-250)
  {
    method: 'GET',
    path: '/api/webhooks',
    operationId: 'webhooks.list',
    tag: 'webhooks',
    feature: 'runs',
    summary: "List the workspace's webhooks (at most 10, unpaginated); the secret is never listed",
    success: ok(json('WebhookListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/webhooks',
    operationId: 'webhooks.create',
    tag: 'webhooks',
    feature: 'runs',
    summary:
      'Register a webhook for terminal run outcomes. The URL must pass the egress policy; the ' +
      'whsec_ signing secret is returned once, in this answer',
    request: json('CreateWebhookRequestSchema'),
    success: created(json('CreateWebhookResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/webhooks/:id',
    operationId: 'webhooks.remove',
    tag: 'webhooks',
    feature: 'runs',
    summary: 'Remove a webhook, its pending deliveries and its signing secret',
    success: NO_CONTENT,
  },

  // §5.3 — model connections and models
  {
    method: 'GET',
    path: '/api/model-connections',
    operationId: 'models.connections.list',
    tag: 'models',
    feature: 'core',
    summary: 'List model connections',
    success: ok(json('ModelConnectionListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/model-connections',
    operationId: 'models.connections.create',
    tag: 'models',
    feature: 'core',
    summary: 'Create a model connection',
    request: UNDESCRIBED,
    success: created(json('ModelConnectionResourceSchema')),
  },
  {
    method: 'GET',
    path: '/api/model-connections/:id',
    operationId: 'models.connections.get',
    tag: 'models',
    feature: 'core',
    summary: 'Read one model connection',
    success: ok(json('ModelConnectionResourceSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/model-connections/:id',
    operationId: 'models.connections.update',
    tag: 'models',
    feature: 'core',
    summary: 'Update a model connection',
    request: UNDESCRIBED,
    success: ok(json('ModelConnectionResourceSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/model-connections/:id',
    operationId: 'models.connections.remove',
    tag: 'models',
    feature: 'core',
    summary: 'Delete a model connection',
    success: ok(json('DeleteModelConnectionResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/model-connections/:id/credential',
    operationId: 'models.connections.rotateCredential',
    tag: 'models',
    feature: 'core',
    summary: "Replace a model connection's credential",
    request: UNDESCRIBED,
    success: NO_CONTENT,
  },
  {
    method: 'POST',
    path: '/api/model-connections/:id/test',
    operationId: 'models.connections.test',
    tag: 'models',
    feature: 'core',
    summary: 'Probe a model connection; a failed probe answers 502 with the outcome',
    success: [
      { status: 200, body: json('ModelConnectionTestOutcomeSchema') },
      { status: 502, body: json('ModelConnectionTestOutcomeSchema') },
    ],
  },
  {
    method: 'GET',
    path: '/api/models',
    operationId: 'models.discover',
    tag: 'models',
    feature: 'core',
    summary: 'Discover the models every connection offers',
    success: ok(json('DiscoveredModelsResponseSchema')),
  },

  // §5.4 — runtimes
  {
    method: 'GET',
    path: '/api/runtime-profiles',
    operationId: 'runtimes.profiles.list',
    tag: 'runtimes',
    feature: 'core',
    summary: 'List runtime profiles',
    success: ok(json('RuntimeProfileListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/runtime-profiles',
    operationId: 'runtimes.profiles.create',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Create a runtime profile',
    request: UNDESCRIBED,
    success: created(json('RuntimeProfileResourceSchema')),
  },
  {
    method: 'GET',
    path: '/api/runtime-profiles/:id',
    operationId: 'runtimes.profiles.get',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Read one runtime profile',
    success: ok(json('RuntimeProfileResourceSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/runtime-profiles/:id',
    operationId: 'runtimes.profiles.update',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Update a runtime profile',
    request: UNDESCRIBED,
    success: ok(json('RuntimeProfileResourceSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/runtime-profiles/:id',
    operationId: 'runtimes.profiles.remove',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Delete a runtime profile',
    success: NO_CONTENT,
  },
  {
    method: 'GET',
    path: '/api/runtime-connections',
    operationId: 'runtimes.connections.list',
    tag: 'runtimes',
    feature: 'core',
    summary: 'List runtime connections',
    success: ok(json('RuntimeConnectionListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/runtime-connections',
    operationId: 'runtimes.connections.create',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Create a runtime connection',
    request: UNDESCRIBED,
    success: created(json('RuntimeConnectionResourceSchema')),
  },
  {
    method: 'POST',
    path: '/api/runtimes/:id',
    operationId: 'runtimes.test',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Test a runtime driver (the id is the literal `test`)',
    request: UNDESCRIBED,
    success: ok(UNDESCRIBED),
  },
  {
    method: 'GET',
    path: '/api/setup/runtime-detect',
    operationId: 'runtimes.detect',
    tag: 'runtimes',
    feature: 'core',
    summary: 'Detect which runtime drivers the host can run',
    success: ok(UNDESCRIBED),
    security: 'none',
  },

  // The storage design §05 — connected buckets and folders
  {
    method: 'GET',
    path: '/api/storage-connections',
    operationId: 'storage.connections.list',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'List the storage connections of the workspace',
    success: ok(json('StorageConnectionListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/storage-connections',
    operationId: 'storage.connections.create',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Connect an S3 bucket or an operator folder, read-only by default',
    request: json('CreateStorageConnectionInputSchema'),
    success: created(json('StorageConnectionResourceSchema')),
  },
  {
    method: 'GET',
    path: '/api/storage-connections/:id',
    operationId: 'storage.connections.get',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Read one storage connection',
    success: ok(json('StorageConnectionResourceSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/storage-connections/:id',
    operationId: 'storage.connections.update',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Rename a storage connection or change its URL, allowed prefixes or write access',
    request: json('UpdateStorageConnectionPatchSchema'),
    success: ok(json('StorageConnectionResourceSchema')),
  },
  {
    method: 'PUT',
    path: '/api/storage-connections/:id/credential',
    operationId: 'storage.connections.rotate',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Replace the credential of a storage connection (the old value is never returned)',
    request: json('StorageConnectionCredentialSchema'),
    success: ok(json('StorageConnectionResourceSchema')),
  },
  {
    method: 'POST',
    path: '/api/storage-connections/:id/test',
    operationId: 'storage.connections.test',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Open a storage connection and list one page of an allowed folder',
    success: ok(json('StorageConnectionTestOutcomeSchema')),
  },
  {
    method: 'GET',
    path: '/api/storage-connections/:id/browse',
    operationId: 'storage.connections.browse',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'List a folder of a storage connection inside its allowed prefixes (?prefix=&cursor=)',
    success: ok(json('StorageConnectionBrowseResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/storage-connections/:id',
    operationId: 'storage.connections.delete',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Delete a storage connection and its credential',
    success: NO_CONTENT,
  },

  // §5.5 — secrets
  {
    method: 'GET',
    path: '/api/secrets',
    operationId: 'secrets.list',
    tag: 'secrets',
    feature: 'core',
    summary: 'List secrets (names only)',
    success: ok(json('SecretListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/secrets',
    operationId: 'secrets.create',
    tag: 'secrets',
    feature: 'core',
    summary: 'Store a secret',
    request: UNDESCRIBED,
    success: created(json('SecretResourceSchema')),
  },
  {
    method: 'PUT',
    path: '/api/secrets/:id',
    operationId: 'secrets.replace',
    tag: 'secrets',
    feature: 'core',
    summary: "Replace a secret's value",
    request: UNDESCRIBED,
    success: ok(json('SecretResourceSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/secrets/:id',
    operationId: 'secrets.remove',
    tag: 'secrets',
    feature: 'core',
    summary: 'Delete a secret nothing references (`409 secret_in_use` names the referrers)',
    success: NO_CONTENT,
  },

  // §5.6 — files
  {
    method: 'GET',
    path: '/api/files',
    operationId: 'files.list',
    tag: 'files',
    feature: 'files',
    summary: 'List files and folders',
    success: ok(json('FileListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/files',
    operationId: 'files.upload',
    tag: 'files',
    feature: 'files',
    summary: 'Upload a file (bytes, path in `x-file-path`) or create a folder (`x-folder-path`)',
    request: BINARY,
    success: [
      { status: 200, body: json('FileResponseSchema') },
      { status: 201, body: json('FileResponseSchema') },
    ],
  },
  {
    method: 'GET',
    path: '/api/files/search',
    operationId: 'files.search',
    tag: 'files',
    feature: 'files',
    summary:
      'Search the text of workspace files (`q`, `limit`): path, page and snippet per hit; `pending` counts files not yet searchable',
    success: ok(json('FileSearchResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/files/:id',
    operationId: 'files.download',
    tag: 'files',
    feature: 'files',
    summary: "Download a file's bytes (the id is the base64url path)",
    success: ok(BINARY),
  },
  {
    method: 'PATCH',
    path: '/api/files/:id',
    operationId: 'files.move',
    tag: 'files',
    feature: 'files',
    summary: 'Move or rename a file or folder',
    request: json('MoveFileRequestSchema'),
    success: ok(json('MoveFileResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/files/:id',
    operationId: 'files.remove',
    tag: 'files',
    feature: 'files',
    summary: 'Delete a file or a folder subtree',
    success: [
      { status: 200, body: json('RemoveFileResponseSchema') },
      { status: 204, body: NONE },
    ],
  },
  {
    method: 'POST',
    path: '/api/files/:id/upload-urls',
    operationId: 'files.createUploadUrl',
    tag: 'files',
    feature: 'files',
    summary:
      'Mint a short-lived PUT URL on the object store, so the holder uploads without a relay',
    request: json('CreateUploadUrlRequestSchema'),
    success: created(json('PresignedUrlSchema')),
  },
  {
    method: 'POST',
    path: '/api/files/:id/upload-complete',
    operationId: 'files.completeUpload',
    tag: 'files',
    feature: 'files',
    summary: 'Verify the object a signed PUT wrote and mark the file ready',
    success: ok(json('FileResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/files/:id/download-urls',
    operationId: 'files.createDownloadUrl',
    tag: 'files',
    feature: 'files',
    summary:
      'Mint a short-lived GET URL on the object store, so the holder downloads without a relay',
    request: json('CreateDownloadUrlRequestSchema'),
    success: created(json('PresignedUrlSchema')),
  },

  // §5.7 — skills
  {
    method: 'GET',
    path: '/api/skills',
    operationId: 'skills.list',
    tag: 'skills',
    feature: 'skills',
    summary: 'List skills',
    success: ok(json('SkillListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/skills',
    operationId: 'skills.import',
    tag: 'skills',
    feature: 'skills',
    summary: 'Import a skill',
    request: {
      kind: 'multipart',
      parts: [
        {
          name: SKILL_IMPORT_MULTIPART.nameField,
          type: 'text',
          description: 'The skill name; the first part.',
        },
        {
          name: SKILL_IMPORT_MULTIPART.fileField,
          type: 'file',
          repeated: true,
          description:
            "One part per skill file, `SKILL.md` first; each part's filename is the file's relative path.",
        },
      ],
    },
    // The JSON + base64 bridge (`ImportSkillInput`), removed in the next major release (#1700).
    deprecatedRequests: [UNDESCRIBED],
    success: created(json('SkillResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/skills/:name',
    operationId: 'skills.get',
    tag: 'skills',
    feature: 'skills',
    summary: 'Read one skill, or export it with its files',
    success: ok(json('SkillResponseSchema', 'SkillExportResponseSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/skills/:name',
    operationId: 'skills.update',
    tag: 'skills',
    feature: 'skills',
    summary: 'Update a skill',
    request: UNDESCRIBED,
    success: ok(json('SkillResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/skills/:name/revisions',
    operationId: 'skills.publish',
    tag: 'skills',
    feature: 'skills',
    summary: 'Publish the skill as the next immutable revision an agent can pin',
    request: json('PublishSkillRevisionRequestSchema'),
    success: created(json('SkillRevisionResponseSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/skills/:name',
    operationId: 'skills.remove',
    tag: 'skills',
    feature: 'skills',
    summary: 'Delete a skill no agent is assigned (`409 skill_in_use` names the referrers)',
    success: NO_CONTENT,
  },

  // ADR-0118 TS1 — code-tool bundles, content-addressed
  {
    method: 'POST',
    path: '/api/tool-bundles',
    operationId: 'toolBundles.upload',
    tag: 'tool-bundles',
    feature: 'core',
    summary: 'Store a code-tool bundle by its SHA-256 (`200` when the workspace already held it)',
    request: json('UploadToolBundleRequestSchema'),
    success: [
      ...created(json('UploadToolBundleResponseSchema')),
      ...ok(json('UploadToolBundleResponseSchema')),
    ],
  },
  {
    method: 'GET',
    path: '/api/tool-bundles/:digest',
    operationId: 'toolBundles.get',
    tag: 'tool-bundles',
    feature: 'core',
    summary: 'Read the address and size of a stored code-tool bundle',
    success: ok(json('ToolBundleResponseSchema')),
  },

  // §5.8 — connectors
  {
    method: 'GET',
    path: '/api/connectors',
    operationId: 'connectors.list',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'List MCP connectors',
    success: ok(json('ConnectorListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/connectors',
    operationId: 'connectors.create',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Create a connector, or test a draft without saving it',
    request: UNDESCRIBED,
    success: [
      { status: 200, body: json('TestConnectionOutcomeSchema') },
      { status: 201, body: json('ConnectorResourceSchema') },
    ],
  },
  {
    method: 'GET',
    path: '/api/connectors/:id',
    operationId: 'connectors.get',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Read one connector',
    success: ok(json('ConnectorResourceSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/connectors/:id',
    operationId: 'connectors.rotateCredential',
    tag: 'connectors',
    feature: 'connectors',
    summary: "Replace a connector's credential",
    request: UNDESCRIBED,
    success: ok(json('ConnectorResourceSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/connectors/:id',
    operationId: 'connectors.remove',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Delete a connector',
    success: NO_CONTENT,
  },
  {
    method: 'POST',
    path: '/api/connectors/:id/test-connection',
    operationId: 'connectors.test',
    tag: 'connectors',
    feature: 'connectors',
    summary: 'Test a saved connector',
    success: ok(json('TestConnectionOutcomeSchema')),
  },

  // §5.9 — agents
  {
    method: 'GET',
    path: '/api/agents',
    operationId: 'agents.list',
    tag: 'agents',
    feature: 'core',
    summary: 'List agents',
    success: ok(json('AgentListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/agents',
    operationId: 'agents.create',
    tag: 'agents',
    feature: 'core',
    summary:
      'Create an agent, optionally with its resource assignments, or from a first version (dryRun checks it)',
    request: UNDESCRIBED,
    success: [
      ...created(
        json(
          'AgentResourceSchema',
          'CreateAgentWithAssignmentsResponseSchema',
          'CreateAgentFromVersionResponseSchema',
        ),
      ),
      ...ok(json('AgentVersionCheckResponseSchema')),
    ],
  },
  {
    method: 'GET',
    path: '/api/agents/:id',
    operationId: 'agents.get',
    tag: 'agents',
    feature: 'core',
    summary: 'Read one agent',
    success: ok(json('AgentResourceSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/agents/:id',
    operationId: 'agents.update',
    tag: 'agents',
    feature: 'core',
    summary: 'Update an agent',
    request: UNDESCRIBED,
    success: ok(json('AgentResourceSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/agents/:id',
    operationId: 'agents.remove',
    tag: 'agents',
    feature: 'core',
    summary: 'Delete an agent',
    success: NO_CONTENT,
  },
  {
    method: 'GET',
    path: '/api/agents/:id/resources',
    operationId: 'agents.getResourceAssignments',
    tag: 'agents',
    feature: 'core',
    summary: "Read an agent's resource assignments",
    success: ok(json('AgentResourceAssignmentsResponseSchema')),
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/resources',
    operationId: 'agents.replaceResourceAssignments',
    tag: 'agents',
    feature: 'core',
    summary: "Replace an agent's resource assignments",
    request: json('AgentResourceAssignmentsSchema'),
    success: ok(json('AgentResourceAssignmentsResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/grants',
    operationId: 'agents.getGrants',
    tag: 'agents',
    feature: 'core',
    summary: "Read an agent's grants",
    success: ok(json('AgentGrantsSchema')),
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/grants',
    operationId: 'agents.replaceGrants',
    tag: 'agents',
    feature: 'core',
    summary: "Replace an agent's grants",
    request: json('AgentGrantsSchema'),
    success: ok(json('AgentGrantsSchema')),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/policy',
    operationId: 'agents.getPolicy',
    tag: 'agents',
    feature: 'core',
    summary: "Read an agent's policy",
    success: ok(json('AgentPolicyResponseSchema')),
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/policy',
    operationId: 'agents.replacePolicy',
    tag: 'agents',
    feature: 'core',
    summary: "Replace an agent's policy",
    request: json('AgentPolicySchema'),
    success: ok(json('AgentPolicyResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/versions',
    operationId: 'agents.listVersions',
    tag: 'agents',
    feature: 'core',
    summary: "List an agent's versions and pointers",
    success: ok(json('AgentVersionListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/agents/:id/versions',
    operationId: 'agents.createVersion',
    tag: 'agents',
    feature: 'core',
    summary: 'Save a version of an agent, or check one with dryRun',
    request: json('CreateAgentVersionRequestSchema'),
    success: [
      ...created(json('AgentVersionResourceSchema')),
      ...ok(json('AgentVersionCheckResponseSchema')),
    ],
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/pointers',
    operationId: 'agents.setPointer',
    tag: 'agents',
    feature: 'core',
    summary: 'Point an environment at a saved version',
    request: json('SetAgentPointerRequestSchema'),
    success: ok(json('SetAgentPointerResponseSchema')),
  },
  /** Issue #615; production moves pass the promotion gate (issue #619). */
  {
    method: 'POST',
    path: '/api/agents/:id/promote',
    operationId: 'agents.promote',
    tag: 'agents',
    feature: 'core',
    summary: "Point production at local's version, or check the move with dryRun",
    request: json('PromoteAgentRequestSchema'),
    success: ok(json('AgentPointerMoveResponseSchema')),
  },
  /** Issue #615. */
  {
    method: 'POST',
    path: '/api/agents/:id/rollback',
    operationId: 'agents.rollback',
    tag: 'agents',
    feature: 'core',
    summary: 'Point an environment back at its previous version, or check it with dryRun',
    request: json('RollbackAgentRequestSchema'),
    success: ok(json('AgentPointerMoveResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/agents/:id/restore',
    operationId: 'agents.restore',
    tag: 'agents',
    feature: 'core',
    summary: 'Restore an archived agent',
    success: ok(json('AgentResourceSchema')),
  },
  /**
   * Issue #618. Synchronous: the server runs the cases one after another as ordinary runs, then
   * stores and answers the evaluation. At most 20 cases, and the server stops waiting after 225 s
   * (a case still running then fails with `deadline_exceeded`), so the answer arrives inside the
   * host's HTTP timeout: 240 s on Azure Container Apps, 300 s on Cloud Run; `aw dev` has none.
   * A client's own request timeout must allow for that.
   */
  {
    method: 'POST',
    path: '/api/agents/:id/evaluations',
    operationId: 'agents.evaluate',
    tag: 'agents',
    feature: 'evaluations',
    summary: "Run a version's evaluation cases and store the score",
    request: json('CreateEvaluationRequestSchema'),
    success: created(json('EvaluationResourceSchema')),
  },
  /**
   * Issue #799. Start an evaluation run of up to 200 cases: it is stored as `running` with no case
   * run yet. The client drives it: it calls `agents.evaluationRuns.advance` until the run is
   * `completed`.
   */
  {
    method: 'POST',
    path: '/api/agents/:id/evaluation-runs',
    operationId: 'agents.evaluationRuns.create',
    tag: 'agents',
    feature: 'evaluations',
    summary: "Start an asynchronous run of a version's evaluation cases",
    request: json('CreateEvaluationRunRequestSchema'),
    success: [{ status: 202, body: json('EvaluationRunResourceSchema') }],
  },
  /**
   * Issue #799. One evaluation run by id, at any status: the baseline that `aw eval --baseline <id>`
   * compares against once it is `completed`. Query: `evaluation`, the run's id, required; an id
   * that is not a UUID, is unknown or belongs to another agent answers `404 evaluation_not_found`.
   */
  {
    method: 'GET',
    path: '/api/agents/:id/evaluation-runs',
    operationId: 'agents.evaluationRuns.get',
    tag: 'agents',
    feature: 'evaluations',
    summary: 'Read an evaluation run and its results so far',
    success: ok(json('EvaluationRunResourceSchema')),
  },
  /**
   * Issue #799. Run the next cases of an evaluation run as ordinary runs and store each result as
   * it finishes. A call stops starting cases after about 120 s, so it answers inside the host's
   * HTTP timeout whatever the run's size; the answer is the run's progress, and the client calls
   * again until its `status` is `completed`. One call advances a run at a time (`409
   * evaluation_run_busy`); a completed run is answered unchanged. A dropped client leaves the run
   * `running`, and the promotion gate never reads a run that has not completed.
   */
  {
    method: 'POST',
    path: '/api/agents/:id/evaluation-advance',
    operationId: 'agents.evaluationRuns.advance',
    tag: 'agents',
    feature: 'evaluations',
    summary: 'Run the next cases of an evaluation run',
    request: json('AdvanceEvaluationRunRequestSchema'),
    success: ok(json('EvaluationRunResourceSchema')),
  },
  /**
   * Issue #620. The newest 50 ratings of the agent's runs, each with the run's prompt and answer,
   * so a thumbs-down can become an evaluation case. Optional query: `rating`, `since` (ISO 8601)
   * and `runId`. A caller who reads only their own runs sees only the ratings of those.
   */
  {
    method: 'GET',
    path: '/api/agents/:id/feedback',
    operationId: 'agents.listFeedback',
    tag: 'agents',
    feature: 'runs',
    summary: "List the ratings of an agent's runs",
    success: ok(json('RunFeedbackListResponseSchema')),
  },

  // §5.10 — projects
  {
    method: 'GET',
    path: '/api/projects',
    operationId: 'projects.list',
    tag: 'projects',
    feature: 'projects',
    summary: 'List projects',
    success: ok(json('ProjectListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/projects',
    operationId: 'projects.create',
    tag: 'projects',
    feature: 'projects',
    summary: 'Create a project',
    request: UNDESCRIBED,
    success: created(json('ProjectResourceSchema')),
  },
  {
    method: 'GET',
    path: '/api/projects/:id',
    operationId: 'projects.get',
    tag: 'projects',
    feature: 'projects',
    summary: 'Read one project',
    success: ok(json('ProjectResourceSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/projects/:id',
    operationId: 'projects.update',
    tag: 'projects',
    feature: 'projects',
    summary: 'Update a project',
    request: UNDESCRIBED,
    success: ok(json('ProjectResourceSchema')),
  },
  {
    method: 'POST',
    path: '/api/projects/:id/archive',
    operationId: 'projects.archive',
    tag: 'projects',
    feature: 'projects',
    summary: 'Archive a project',
    success: ok(json('ProjectResourceSchema')),
  },
  {
    method: 'POST',
    path: '/api/projects/:id/restore',
    operationId: 'projects.restore',
    tag: 'projects',
    feature: 'projects',
    summary: 'Restore an archived project',
    success: ok(json('ProjectResourceSchema')),
  },
  {
    method: 'POST',
    path: '/api/projects/:id/sessions',
    operationId: 'projects.startSession',
    tag: 'projects',
    feature: 'projects',
    summary: 'Start a session in a project, or adopt an existing one',
    request: UNDESCRIBED,
    success: [
      {
        status: 200,
        body: json('ProjectSessionResponseSchema', 'ProjectSessionMoveResponseSchema'),
      },
      { status: 201, body: json('ProjectSessionResponseSchema') },
    ],
  },

  // §5.11 — sessions, transcripts and engine session state
  {
    method: 'GET',
    path: '/api/sessions',
    operationId: 'sessions.list',
    tag: 'sessions',
    feature: 'chat',
    summary: 'List sessions',
    success: ok(json('SessionListResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId',
    operationId: 'sessions.get',
    tag: 'sessions',
    feature: 'chat',
    summary: 'Read one session',
    success: ok(json('SessionResponseSchema')),
  },
  {
    method: 'PATCH',
    path: '/api/sessions/:engineSessionId',
    operationId: 'sessions.update',
    tag: 'sessions',
    feature: 'chat',
    summary: 'Rename or archive a session',
    request: UNDESCRIBED,
    success: ok(json('SessionResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/transcript',
    operationId: 'sessions.transcript.read',
    tag: 'sessions',
    feature: 'chat',
    summary: "Read a session's transcript",
    success: ok(json('TranscriptResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/subkeys',
    operationId: 'sessions.transcript.subkeys',
    tag: 'sessions',
    feature: 'chat',
    summary: "List a transcript's subkeys",
    success: ok(json('TranscriptSubkeysResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/attachments',
    operationId: 'sessions.attachments.upload',
    tag: 'sessions',
    feature: 'core',
    summary:
      "Upload one file (bytes, name in `name`) into a visitor's session, for `runs.start` `attachments`",
    request: BINARY,
    success: created(json('SurfaceAttachmentResponseSchema')),
  },

  // §5.12 — runs and the event stream
  {
    method: 'POST',
    path: '/api/agents/:id/runs',
    operationId: 'runs.start',
    tag: 'runs',
    feature: 'core',
    summary: 'Start a run of an agent',
    request: json('StartRunRequestSchema'),
    headers: [
      {
        name: 'Idempotency-Key',
        required: false,
        description:
          'Makes a retried start safe (S-6, ADR-0151, spec §5.12): 1–255 characters after ' +
          'trimming, scoped to the calling principal. The same key with the same request returns ' +
          'the run the first start queued; the same key with a different request answers ' +
          '`409 run_idempotency_conflict`; a blank or longer key answers ' +
          '`400 invalid_idempotency_key`.',
      },
    ],
    success: [{ status: 202, body: json('StartRunResponseSchema') }],
  },
  {
    method: 'GET',
    path: '/api/runs',
    operationId: 'runs.list',
    tag: 'runs',
    feature: 'runs',
    summary: 'List runs',
    success: ok(json('RunListResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/runs/:id',
    operationId: 'runs.get',
    tag: 'runs',
    feature: 'core',
    summary: 'Read one run',
    success: ok(json('RunResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/runs/:id',
    operationId: 'runs.revokeTokensDeprecated',
    tag: 'runs',
    feature: 'core',
    summary: 'Revoke gateway tokens (deprecated alias of the revoke-tokens route)',
    request: UNDESCRIBED,
    success: ok(json('RevokeRunTokensResponseSchema')),
    deprecated: true,
  },
  {
    method: 'GET',
    path: '/api/runs/:id/events',
    operationId: 'runs.events',
    tag: 'runs',
    feature: 'core',
    summary: "Follow a run's events (resume with `Last-Event-ID`)",
    success: ok({
      kind: 'event-stream',
      frames: [
        'RunStatusEventDataSchema',
        'RunWarningEventDataSchema',
        'AgentFrameSchema',
        'RunFailedFrameDataSchema',
        'StreamResetFrameDataSchema',
      ],
    }),
  },
  {
    method: 'POST',
    path: '/api/runs/:id/interrupt',
    operationId: 'runs.interrupt',
    tag: 'runs',
    feature: 'core',
    summary: 'Interrupt a run',
    success: ok(json('InterruptRunResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/runs/:id/approval',
    operationId: 'runs.approval',
    tag: 'runs',
    feature: 'core',
    summary:
      'Approve or reject the tool call a paused run is waiting on (starts a continuation run; `409` once decided)',
    request: json('RunApprovalRequestSchema'),
    success: [{ status: 202, body: json('RunApprovalResponseSchema') }],
  },
  {
    method: 'POST',
    path: '/api/runs/:id/feedback',
    operationId: 'runs.feedback',
    tag: 'runs',
    feature: 'runs',
    summary: 'Rate a run (thumbs up or down)',
    request: json('RunFeedbackRequestSchema'),
    success: NO_CONTENT,
  },
  {
    method: 'POST',
    path: '/api/runs/:id/revoke-tokens',
    operationId: 'runs.revokeTokens',
    tag: 'runs',
    feature: 'core',
    summary: "Revoke a run's gateway tokens",
    request: UNDESCRIBED,
    success: ok(json('RevokeRunTokensResponseSchema')),
  },

  // §5.13 — shares
  {
    method: 'GET',
    path: '/api/shares',
    operationId: 'shares.list',
    tag: 'shares',
    feature: 'sharing',
    summary: 'List shares',
    success: ok(json('ShareListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/shares',
    operationId: 'shares.publish',
    tag: 'shares',
    feature: 'sharing',
    summary: 'Publish a session as a share',
    request: UNDESCRIBED,
    success: created(json('ShareResourceSchema')),
  },
  {
    method: 'DELETE',
    path: '/api/shares/:id',
    operationId: 'shares.revoke',
    tag: 'shares',
    feature: 'sharing',
    summary: 'Revoke a share',
    success: NO_CONTENT,
  },

  // §5.14 — metrics and audit
  {
    method: 'GET',
    path: '/api/metrics',
    operationId: 'observability.metrics.recentRuns',
    tag: 'observability',
    feature: 'runs',
    summary: 'Recent run telemetry',
    success: ok(json('RunTelemetryListResponseSchema')),
  },
  {
    method: 'GET',
    path: '/api/audit-events',
    operationId: 'observability.audit.list',
    tag: 'observability',
    feature: 'core',
    summary: 'List audit events',
    success: ok(json('AuditEventListResponseSchema')),
  },

  // §5.15 — engines
  {
    method: 'GET',
    path: '/api/engines',
    operationId: 'engines.list',
    tag: 'engines',
    feature: 'core',
    summary: 'List the engines this deployment knows',
    success: ok(json('EngineListResponseSchema')),
  },

  // §5.16 — platforms
  {
    method: 'GET',
    path: '/api/platforms',
    operationId: 'platforms.list',
    tag: 'platforms',
    feature: 'core',
    summary: 'List the agent platforms an agent can be exported to',
    success: ok(json('PlatformListResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/agents/:id/platform-exports',
    operationId: 'platforms.export',
    tag: 'platforms',
    feature: 'core',
    summary: 'Export a saved version of an agent for one platform, with the verdict report',
    request: json('PlatformExportRequestSchema'),
    success: ok(json('PlatformExportResponseSchema')),
  },
  {
    method: 'POST',
    path: '/api/agents/:id/platform-archives',
    operationId: 'platforms.exportArchive',
    tag: 'platforms',
    feature: 'core',
    summary: 'The same export as a POSIX tar archive',
    request: json('PlatformExportRequestSchema'),
    success: ok(BINARY),
  },

  // ADR-0135 — published agents over A2A v0.3
  {
    method: 'POST',
    path: '/api/a2a/agents/:agentName',
    operationId: 'a2a.rpc',
    tag: 'a2a',
    feature: 'core',
    summary:
      'A2A v0.3 JSON-RPC to a published agent (message/send, message/stream, tasks/get, tasks/cancel)',
    request: json('A2aJsonRpcRequestSchema'),
    // message/stream answers `text/event-stream`, each `data:` one A2aJsonRpcResponseSchema; one
    // status carries one body kind in this catalogue, so the stream is described in ADR-0135.
    success: ok(json('A2aJsonRpcResponseSchema')),
    security: 'endpoint-credential',
  },
  {
    method: 'GET',
    path: '/api/a2a/agents/:agentName/.well-known/agent-card.json',
    operationId: 'a2a.agentCard',
    tag: 'a2a',
    feature: 'core',
    summary: "Read a published agent's A2A v0.3 agent card",
    success: ok(json('A2aAgentCardSchema')),
    security: 'endpoint-credential',
  },

  // ADR-0134 part 2 — an mcp-project endpoint client's public MCP endpoint, outside /api (spec §34)
  {
    method: 'POST',
    path: '/mcp/projects/:name',
    operationId: 'mcp.projectRpc',
    tag: 'mcp',
    feature: 'projects',
    summary:
      "MCP JSON-RPC to an endpoint client's production code tools (initialize, ping, tools/list, tools/call)",
    request: json('A2aJsonRpcRequestSchema'),
    // The JSON-RPC 2.0 envelope is protocol-neutral; a notification (no `id`) is answered 202.
    success: ok(json('A2aJsonRpcResponseSchema')),
    security: 'endpoint-credential',
  },

  // Builder design §04 (#1846 slice 5b) — the read-only door for an outside MCP client (a `builder` OAuth client)
  {
    method: 'POST',
    path: '/mcp/builder',
    operationId: 'mcp.builderRpc',
    tag: 'mcp',
    feature: 'builder',
    summary:
      "MCP JSON-RPC to the Builder's read tools (initialize, ping, tools/list, tools/call) for an outside client",
    request: json('A2aJsonRpcRequestSchema'),
    success: ok(json('A2aJsonRpcResponseSchema')),
    security: 'endpoint-credential',
  },
];
