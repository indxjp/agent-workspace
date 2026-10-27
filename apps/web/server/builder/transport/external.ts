/**
 * `POST /mcp/builder` — the Builder's read-only door for an outside MCP client (issue #1846 slice
 * 5b). It is OAuth-protected as `/mcp/projects/{name}` is and takes one credential: an access token
 * of a `builder` endpoint client whose audience is this URL. `tools/list` publishes the read tools
 * only; a write or spend tool is refused with `read_only_client` before any port, so no outside
 * client reaches an executor. A read tool runs the core (`handleToolCall`) as the member who
 * authorised the client, with that member's role, so RBAC applies as in the console.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  BUILDER_TOOL_NAMES,
  BUILDER_TOOLS,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';

import { applicationContext } from '../../application-context';
import { endpointCredentialKey } from '../../endpoints/request';
import { BUILDER_RESOURCE_PATH, bearerChallenge, resourceUrl } from '../../oauth/resource';
import type { Principal } from '../../rbac/principal';
import { apiError } from '../../runs/http';
import { answerLocally, readCall, toolCallName } from '../../tool-endpoint/handler';
import { admitToolEndpointCall } from '../../tool-endpoint/limits';
import type { CallContext } from '../ports';
import { handleToolCall } from '../shell';
import type { BuilderPorts } from '../tools/types';
import { TOOL_LIST, refusal, toolAnswer } from './mcp';

/** The parts of a verified principal this door reads; the workspace and caller come from nothing else. */
export type ExternalPrincipal = Pick<
  Principal,
  | 'via'
  | 'oauth'
  | 'scope'
  | 'workspaceId'
  | 'principalId'
  | 'ownerPrincipalId'
  | 'userId'
  | 'role'
  | 'apiKeyId'
>;

export interface ExternalBuilderDoor {
  readonly identify: (request: Request) => Promise<ExternalPrincipal | null>;
  /** `null` when the deployment lacks a store the tools read: every read is `builder_disabled`. */
  readonly ports: BuilderPorts | null;
}

/** The `Mcp-Session-Id` forms a run id may carry: short and plain, never an id a client can shape freely. */
const SESSION_ID = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * The core's view of one outside call. Workspace and caller come from the verified principal only;
 * the run id is `ext:<client id>:<session id>` when the session id is a bounded token, else `ext:`
 * plus a fresh uuid, so two clients that send the same session id never share a run, a journal key
 * or a run count;
 * the trace id is minted here; model and prompt version are the fixed value `external`.
 */
export function toExternalCallContext(principal: ExternalPrincipal, headers: Headers): CallContext {
  const session = headers.get('mcp-session-id');
  const clientId = principal.oauth?.clientId;
  const bound = session !== null && clientId !== undefined && SESSION_ID.test(session);
  return {
    workspaceId: principal.workspaceId,
    door: { kind: 'external' },
    runId: bound ? `ext:${clientId}:${session}` : `ext:${randomUUID()}`,
    traceId: randomBytes(16).toString('hex'),
    caller: {
      kind: 'person',
      principal: {
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        ownerPrincipalId: principal.ownerPrincipalId,
        userId: principal.userId,
        role: principal.role,
      },
    },
    modelId: 'external',
    promptVersion: 'external',
  };
}

function challenged(status: number, code: string, message: string, error?: 'invalid_token') {
  const response = apiError(status, code, message);
  response.headers.set('WWW-Authenticate', bearerChallenge(BUILDER_RESOURCE_PATH, error));
  return response;
}

const unauthenticated = () =>
  challenged(401, 'unauthenticated', 'this endpoint requires an OAuth access token.');

function doorFromContext(): ExternalBuilderDoor | null {
  const context = applicationContext();
  if (context === null) return null;
  return { identify: (request) => context.rbac.identify(request), ports: context.builder.ports };
}

export async function serveExternalBuilderMcp(
  request: Request,
  door: ExternalBuilderDoor | null = doorFromContext(),
): Promise<Response> {
  if (request.method !== 'POST') {
    const response = apiError(405, 'method_not_allowed', 'this endpoint accepts POST only.');
    response.headers.set('Allow', 'POST');
    return response;
  }
  if (request.headers.get('Authorization') === null && request.headers.get('Cookie') === null) {
    return unauthenticated();
  }
  if (door === null) {
    return apiError(503, 'builder_not_configured', 'the Builder door is not configured.');
  }
  const principal = await door.identify(request);
  if (principal === null) return unauthenticated();
  if (principal.via !== 'oauth-token' || principal.oauth === null) {
    return apiError(
      403,
      'builder_credential_not_accepted',
      'this endpoint accepts an OAuth access token of a builder client only.',
    );
  }
  const admission = admitToolEndpointCall(
    endpointCredentialKey({ principal, apiKeyId: principal.apiKeyId, oauth: principal.oauth }),
    Date.now(),
  );
  if (!admission.admitted) {
    const response = apiError(429, 'builder_rate_limited', 'too many requests; retry later.');
    response.headers.set('Retry-After', String(admission.retryAfterSeconds));
    return response;
  }
  if (principal.oauth.audience !== resourceUrl(BUILDER_RESOURCE_PATH)) {
    return challenged(
      401,
      'invalid_token',
      'the access token is not valid for this endpoint.',
      'invalid_token',
    );
  }
  if (request.headers.get('Origin') !== null) {
    return apiError(403, 'origin_not_allowed', 'browser origins cannot call this endpoint.');
  }
  if (principal.scope?.kind !== 'builder') {
    return apiError(403, 'builder_scope_required', 'this endpoint accepts a builder client only.');
  }

  const call = await readCall(request);
  if (call instanceof Response) return call;
  const local = answerLocally(call);
  if (local !== null) return local;
  if (call.method === 'tools/list') {
    const tools = TOOL_LIST.filter((tool) => BUILDER_TOOLS[tool.name].kind === 'read');
    return Response.json({ jsonrpc: '2.0', id: call.id ?? null, result: { tools } });
  }
  // answerLocally leaves only tools/list and tools/call to this point.
  const result = await callTool(request, call.params, principal, door.ports);
  return Response.json({ jsonrpc: '2.0', id: call.id ?? null, result: toolAnswer(result) });
}

/**
 * Names match the contract's list exactly (no trim, case-fold or prefix strip), and anything but a
 * read tool is refused here, before the core and so before any port or journal row.
 */
function callTool(
  request: Request,
  params: unknown,
  principal: ExternalPrincipal,
  ports: BuilderPorts | null,
) {
  const name: BuilderToolName | undefined = BUILDER_TOOL_NAMES.find(
    (known) => known === toolCallName(params),
  );
  if (name === undefined) return Promise.resolve(refusal('unknown_tool'));
  if (BUILDER_TOOLS[name].kind !== 'read') return Promise.resolve(refusal('read_only_client'));
  if (ports === null) return Promise.resolve(refusal('builder_disabled'));
  const { arguments: args } = params as { arguments?: unknown };
  const raw = { name, arguments: args, callId: randomUUID() };
  return handleToolCall(
    raw,
    toExternalCallContext(principal, request.headers),
    ports,
    request.signal,
  );
}
