/**
 * `POST /mcp/projects/{name}` (ADR-0134 part 2): the public MCP endpoint of an `mcp-project`
 * endpoint client. The order every call meets its checks in is fixed: method, credential, rate,
 * origin, scope and tenant, body and protocol version, run permission, then the sandbox. The tool
 * code never runs here; the call is forwarded through the gateway, the only caller of a tool
 * sandbox (ADR-0118 TS3), under a 60-second grant the control plane signs.
 */
import { log } from '../telemetry/logger';
import type { AgentVersionToolBundle } from '@indx-workspace/contracts/agent-versions';
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';
import { z } from 'zod';

import { applicationContext } from '../application-context';
import { endpointCredentialKey, readCappedBody } from '../endpoints/request';
import { DomainError } from '../errors';
import { featureRefusalResponse } from '../features/guard';
import { bearerChallenge, mcpResourcePath, resourceUrl } from '../oauth/resource';
import { requireRunPermission } from '../runs/api';
import { apiError } from '../runs/http';
import type { ToolEndpointEnvironment, ToolEndpointIdentity } from './env';
import { admitToolEndpointCall } from './limits';

const NOT_FOUND = (): Response =>
  apiError(404, 'tool_endpoint_not_found', 'no tool endpoint by that name.');

const GATEWAY_TIMEOUT_MS = 125_000;
export const TOOL_ENDPOINT_MAX_BODY_BYTES = 1_048_576;
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26'];
/** Methods forwarded to the tool sandbox; the endpoint is stateless and has no other. */
const FORWARDED_METHODS: ReadonlySet<string> = new Set(['tools/list', 'tools/call']);
/** `buildToolSandboxRequest`'s refusals: a misbuilt tool, not an outage, so not a 503. */
const BUILDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'code_tool_unbundled',
  'code_tool_bundle_missing',
  'code_tool_secret_missing',
]);

function unauthenticated(name: string): Response {
  const response = apiError(
    401,
    'unauthenticated',
    'this endpoint requires an API key or an OAuth access token.',
  );
  response.headers.set('WWW-Authenticate', bearerChallenge(mcpResourcePath(name)));
  return response;
}

/** A valid access token presented at a URL it was not issued for (RFC 8707, RFC 9728). */
function wrongAudience(name: string): Response {
  const response = apiError(
    401,
    'invalid_token',
    'the access token is not valid for this endpoint.',
  );
  response.headers.set('WWW-Authenticate', bearerChallenge(mcpResourcePath(name), 'invalid_token'));
  return response;
}

/** The longest method name a -32601 answer echoes back, in characters. */
const MAX_ECHOED_METHOD_LENGTH = 128;

function rpcError(
  status: number,
  id: unknown,
  code: number,
  message: string,
  data?: Readonly<Record<string, string>>,
): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      error: data === undefined ? { code, message } : { code, message, data },
    },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

type Envelope = {
  readonly id: unknown;
  /** No `id`: a notification, which gets no answer. */
  readonly notification: boolean;
  readonly method: string;
  readonly params: unknown;
};

const EnvelopeSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

function envelopeOf(value: unknown): Envelope | null {
  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success) return null;
  const { id, method, params } = parsed.data;
  return { id, notification: !('id' in parsed.data), method, params };
}

type BodyResult =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'rejected'; readonly reason: string };

/** The body as one JSON value: capped by `Content-Length` first, then by the bytes actually read. */
async function readCappedJson(request: Request, max: number): Promise<BodyResult> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return { kind: 'too_large' };
  const mime = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'application/json') {
    return { kind: 'rejected', reason: 'the request Content-Type is not application/json.' };
  }
  if (request.body === null) return { kind: 'rejected', reason: 'the request has no body.' };
  const body = await readCappedBody(request, max);
  if (body.kind === 'too_large') return body;
  const notJson: BodyResult = { kind: 'rejected', reason: 'the request body is not valid JSON.' };
  if (body.kind !== 'ok') return notJson;
  try {
    return { kind: 'ok', value: JSON.parse(body.text) };
  } catch {
    return notJson;
  }
}

/**
 * The tools a client publishes: its agents' bundles, narrowed by `toolNames`. Two agents pinning a
 * tool of one name with different code are refused rather than one picked.
 */
export function selectToolBundles(
  bundles: readonly AgentVersionToolBundle[],
  toolNames: readonly string[] | null,
): { readonly bundles: readonly AgentVersionToolBundle[] } | { readonly conflict: string } {
  const allowed = toolNames === null ? null : new Set(toolNames);
  const chosen = new Map<string, AgentVersionToolBundle>();
  for (const bundle of bundles) {
    if (allowed !== null && !allowed.has(bundle.tool)) continue;
    const existing = chosen.get(bundle.tool);
    if (existing === undefined) chosen.set(bundle.tool, bundle);
    else if (existing.digest !== bundle.digest) return { conflict: bundle.tool };
  }
  return { bundles: [...chosen.values()] };
}

export function toolCallName(params: unknown): string | null {
  const name = (params as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export async function serveToolEndpoint(request: Request, name: string): Promise<Response> {
  if (request.method !== 'POST') {
    const response = apiError(405, 'method_not_allowed', 'this endpoint accepts POST only.');
    response.headers.set('Allow', 'POST');
    return response;
  }
  if (request.headers.get('Authorization') === null && request.headers.get('Cookie') === null) {
    return unauthenticated(name);
  }
  const context = applicationContext();
  if (context === null || context.toolEndpoint.kind !== 'serving') {
    return apiError(503, 'tool_endpoint_not_configured', 'the tool endpoint is not configured.');
  }
  const env = context.toolEndpoint.environment;
  const clients = context.endpointClients;

  const identity: ToolEndpointIdentity | null = await env.identify(request);
  if (identity === null) return unauthenticated(name);
  if (identity.via !== 'api-key' && identity.via !== 'oauth-token') {
    return apiError(
      403,
      'tool_endpoint_credential_not_accepted',
      'this endpoint accepts an endpoint-scoped API key or an OAuth access token only.',
    );
  }
  const { principal } = identity;
  const admission = admitToolEndpointCall(endpointCredentialKey(identity), env.now());
  if (!admission.admitted) {
    const response = apiError(429, 'tool_endpoint_rate_limited', 'too many requests; retry later.');
    response.headers.set('Retry-After', String(admission.retryAfterSeconds));
    return response;
  }
  if (identity.oauth !== null && identity.oauth.audience !== resourceUrl(mcpResourcePath(name))) {
    return wrongAudience(name);
  }
  const disabled = await featureRefusalResponse(request, principal.workspaceId);
  if (disabled !== null) return disabled;
  if (request.headers.get('Origin') !== null) {
    return apiError(403, 'origin_not_allowed', 'browser origins cannot call this endpoint.');
  }
  if (principal.scope?.kind !== 'mcp-project') {
    return apiError(
      403,
      'tool_endpoint_scope_required',
      'this endpoint accepts an mcp-project-scoped API key only.',
    );
  }
  const client = NAME_KEY_PATTERN.test(name)
    ? await clients.get(principal.workspaceId, principal.scope.id)
    : null;
  if (
    client === null ||
    client.kind !== 'mcp-project' ||
    client.revokedAt !== null ||
    client.name !== name
  ) {
    return NOT_FOUND();
  }

  const call = await readCall(request);
  if (call instanceof Response) return call;
  const local = answerLocally(call);
  if (local !== null) return local;

  const runnable = await runnableAgentIds(env, request, principal, client.agentIds);
  const selected = selectToolBundles(
    await env.productionToolBundles(principal.workspaceId, runnable),
    client.toolNames,
  );
  if ('conflict' in selected) {
    return rpcError(
      200,
      call.id,
      -32603,
      'two agents of this endpoint pin different code for one tool name.',
      { code: 'tool_name_conflict', tool: selected.conflict },
    );
  }
  if (call.method === 'tools/list' && selected.bundles.length === 0) {
    return Response.json({ jsonrpc: '2.0', id: call.id ?? null, result: { tools: [] } });
  }

  if (call.method === 'tools/call') {
    const tool = toolCallName(call.params);
    if (tool === null || !selected.bundles.some((bundle) => bundle.tool === tool)) {
      return rpcError(200, call.id, -32602, 'the tool is not published by this endpoint.');
    }
    await clients.audit(
      { ...principal, label: identity.label },
      {
        action: 'endpoint-tool-called',
        subjectId: client.id,
        subjectLabel: `${client.name}/${tool}`,
      },
    );
  }

  return forwardToGateway(env, request, {
    id: call.id,
    workspaceId: principal.workspaceId,
    clientId: client.id,
    clientName: client.name,
    bundles: selected.bundles,
    body: call.body,
  });
}

/** The body, capped at 1 MiB, as one JSON-RPC message in a protocol version this endpoint speaks. */
export async function readCall(
  request: Request,
): Promise<(Envelope & { readonly body: unknown }) | Response> {
  const body = await readCappedJson(request, TOOL_ENDPOINT_MAX_BODY_BYTES);
  if (body.kind === 'too_large') {
    return apiError(
      413,
      'tool_endpoint_body_too_large',
      `the request body exceeds ${String(TOOL_ENDPOINT_MAX_BODY_BYTES)} bytes.`,
    );
  }
  if (body.kind !== 'ok') return rpcError(400, null, -32700, body.reason);
  const protocol = request.headers.get('MCP-Protocol-Version');
  if (protocol !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)) {
    return apiError(
      400,
      'mcp_protocol_version_unsupported',
      `this endpoint speaks MCP ${SUPPORTED_PROTOCOL_VERSIONS.join(' or ')}.`,
    );
  }
  const call = envelopeOf(body.value);
  if (call === null) {
    return apiError(400, 'invalid_mcp_message', 'the body is not one JSON-RPC 2.0 request.');
  }
  return { ...call, body: body.value };
}

/**
 * Notifications, `ping`, `initialize` and unsupported methods, answered here so connecting a
 * client never starts a sandbox; `null` for a method the sandbox answers.
 */
export function answerLocally(call: Envelope): Response | null {
  if (call.notification) return new Response(null, { status: 202 });
  if (call.method === 'ping') {
    return Response.json({ jsonrpc: '2.0', id: call.id ?? null, result: {} });
  }
  if (call.method === 'initialize') {
    const asked = (call.params as { protocolVersion?: unknown } | null | undefined)
      ?.protocolVersion;
    return Response.json({
      jsonrpc: '2.0',
      id: call.id ?? null,
      result: {
        protocolVersion:
          typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-workspace-tools', version: '1.0.0' },
      },
    });
  }
  return FORWARDED_METHODS.has(call.method)
    ? null
    : rpcError(
        200,
        call.id,
        -32601,
        `the method ${call.method.slice(0, MAX_ECHOED_METHOD_LENGTH)} is not supported.`,
      );
}

/**
 * The key acts for a member, so an agent they may not run (or that is gone) leaves the union
 * rather than taking the endpoint down; `scope` is dropped because it gates `/api` route shapes,
 * and the endpoint has checked it against the client already.
 */
async function runnableAgentIds(
  env: ToolEndpointEnvironment,
  request: Request,
  principal: ToolEndpointIdentity['principal'],
  agentIds: readonly string[],
): Promise<readonly string[]> {
  const unscoped = { ...principal, scope: null };
  const runnable: string[] = [];
  for (const agentId of agentIds) {
    const ownership = await env.agentOwnership(unscoped, agentId);
    const denied = requireRunPermission(
      new Request(new URL(`/api/agents/${agentId}/runs`, request.url), { method: 'POST' }),
      unscoped,
      ownership,
    );
    if (ownership !== 'unknown' && denied === null) runnable.push(agentId);
  }
  return runnable;
}

async function forwardToGateway(
  env: ToolEndpointEnvironment,
  request: Request,
  call: {
    readonly id: unknown;
    readonly workspaceId: string;
    readonly clientId: string;
    readonly clientName: string;
    readonly bundles: readonly AgentVersionToolBundle[];
    readonly body: unknown;
  },
): Promise<Response> {
  try {
    const route = await env.route({
      workspaceId: call.workspaceId,
      clientId: call.clientId,
      bundles: call.bundles,
    });
    const accept = request.headers.get('Accept');
    const protocol = request.headers.get('MCP-Protocol-Version');
    const upstream = await env.fetch(route.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.grant}`,
        'Content-Type': 'application/json',
        'x-aw-agent': encodeURIComponent(call.clientName),
        ...(accept === null ? {} : { Accept: accept }),
        ...(protocol === null ? {} : { 'MCP-Protocol-Version': protocol }),
      },
      body: JSON.stringify(call.body),
      redirect: 'error',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const contentType = upstream.headers.get('content-type');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Cache-Control': 'no-store',
        ...(contentType === null ? {} : { 'Content-Type': contentType }),
      },
    });
  } catch (error) {
    if (error instanceof DomainError && BUILDER_ERROR_CODES.has(error.code)) {
      return rpcError(200, call.id, -32603, 'a tool of this endpoint cannot be served.', {
        code: error.code,
      });
    }
    // Only the error's class is logged: its text may name the sandbox's address or a secret name.
    log.error('[tool-endpoint] the tool sandbox call failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return apiError(503, 'tool_endpoint_unavailable', 'the tool sandbox did not answer.');
  }
}
