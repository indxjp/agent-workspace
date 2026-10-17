/**
 * `POST /v1/tool-sandbox/mcp` (ADR-0118 TS3): forwards a run's MCP request to the session's tool
 * sandbox. The run token is the caller's only credential. The gateway recomputes the sandbox's own
 * per-run bearer, reads the sandbox origin from the run record rather than from the request, and
 * never reaches the model resolver or the usage recorder. The agent sandbox therefore never holds
 * a tool token and cannot choose where the gateway dials.
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { terminalRunStatuses } from '@agent-workspace/core/db';
import { TOOL_GATEWAY_PROBLEM_CODES } from '@indx-workspace/contracts/tool-connectors';

import { verifyRunToken } from '../auth.js';
import { endpointSandboxRunId, type EndpointGrantCodec } from '../tokens/endpoint-grant.js';
import {
  toolSandboxRunToken,
  type RunTokenClaims,
  type RunTokenCodec,
} from '../tokens/run-token.js';
import type { ToolRefusal } from './authorize.js';

type ToolSandboxResolution = { readonly ok: true; readonly origin: string } | ToolRefusal;

/** Authorises a verified run token for its own run's tool sandbox, on every request. */
export interface ToolSandboxResolver {
  resolve(claims: RunTokenClaims, tokenHash: string): Promise<ToolSandboxResolution>;
}

type ToolSandboxForwardDependencies = {
  readonly tokenSecret: string;
  /**
   * `RUNNER_MANAGER_TOKEN`, for a sandbox the runner manager serves (`/tool-sandboxes/<id>`):
   * that route requires it beside the run token (ADR-0132). Never sent to any other origin.
   */
  readonly managerToken?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

export type ToolSandboxEndpointDependencies = ToolSandboxForwardDependencies & {
  readonly tokens: RunTokenCodec;
  readonly sandbox: ToolSandboxResolver;
};

export type EndpointToolSandboxDependencies = ToolSandboxForwardDependencies & {
  readonly grants: EndpointGrantCodec;
};

const TERMINAL: ReadonlySet<string> = new Set(terminalRunStatuses);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A manager-served sandbox origin's path; a container origin (Docker) has none. */
const MANAGER_ROUTE = /^\/tool-sandboxes\/[^/]+\/mcp$/u;
/** The manager route's header for the run token: its `authorization` is the manager's (`apps/runner`). */
const MANAGER_RUN_AUTHORIZATION = 'x-aw-tool-authorization';
/** The only request headers that reach the sandbox besides the two it is given. */
const FORWARDED_HEADERS = ['content-type', 'accept', 'mcp-protocol-version', 'x-aw-agent'] as const;

const MESSAGES = {
  tool_run_not_active: 'The run named by this gateway token is not active.',
  tool_not_in_run: 'This run has no tool sandbox.',
  tool_upstream_failed: 'The tool sandbox did not answer.',
  tool_upstream_timeout: 'The tool sandbox did not answer in time.',
} as const;

function problem(code: keyof typeof MESSAGES): Response {
  const status = TOOL_GATEWAY_PROBLEM_CODES[code];
  return Response.json(
    {
      type: 'error',
      error: {
        type:
          status === 401
            ? 'authentication_error'
            : status === 403
              ? 'permission_error'
              : 'api_error',
        code,
        message: MESSAGES[code],
      },
    },
    { status },
  );
}

function tooLarge(): Response {
  return Response.json(
    {
      type: 'error',
      error: { type: 'request_too_large', message: 'The tool request body is too large.' },
    },
    { status: 413 },
  );
}

/** C16's shape for the sandbox: the token is live, the run is not over and a sandbox was recorded. */
export function createDatabaseToolSandboxResolver(database: DatabaseRoot): ToolSandboxResolver {
  return {
    async resolve(claims, tokenHash): Promise<ToolSandboxResolution> {
      const refuse = (code: ToolRefusal['code']): ToolRefusal => ({
        ok: false,
        status: TOOL_GATEWAY_PROBLEM_CODES[code],
        code,
      });
      const scope = await database.scopes.forWorkspaceId(claims.workspaceId);
      if (scope === null) return refuse('tool_run_not_active');
      const tokenActive = await database.runTokens
        .forScope(scope)
        .isActive(claims.tokenId, claims.runId, tokenHash);
      const run = tokenActive ? await database.runs.forScope(scope).get(claims.runId) : null;
      if (run === null || TERMINAL.has(run.status)) return refuse('tool_run_not_active');
      return run.toolSandboxOrigin === null || run.toolSandboxOrigin === undefined
        ? refuse('tool_not_in_run')
        : { ok: true, origin: run.toolSandboxOrigin };
    },
  };
}

/**
 * The forwarding step both sandbox routes share, after their own authorisation: caps the body,
 * forwards the header allow-list, adds the sandbox's derived bearer (and the manager token for a
 * manager-served origin) and answers with the sandbox's status and content type only.
 */
async function forwardToToolSandbox(
  request: Request,
  target: { readonly origin: string; readonly sandboxRunId: string },
  dependencies: ToolSandboxForwardDependencies,
): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return tooLarge();

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const runAuthorization = `Bearer ${await toolSandboxRunToken(dependencies.tokenSecret, target.sandboxRunId)}`;
  headers.set('x-aw-run-id', target.sandboxRunId);

  try {
    // Appended, not resolved against the origin: a hosted sandbox's origin carries a path.
    const url = new URL(`${target.origin.replace(/\/+$/u, '')}/mcp`);
    if (dependencies.managerToken !== undefined && MANAGER_ROUTE.test(url.pathname)) {
      headers.set('authorization', `Bearer ${dependencies.managerToken}`);
      headers.set(MANAGER_RUN_AUTHORIZATION, runAuthorization);
    } else {
      headers.set('authorization', runAuthorization);
    }
    const upstream = await (dependencies.fetch ?? fetch)(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const contentType = upstream.headers.get('content-type');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: contentType === null ? {} : { 'content-type': contentType },
    });
  } catch (error) {
    // The error text may name the sandbox's address, so only its class decides the answer.
    return problem(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'tool_upstream_timeout'
        : 'tool_upstream_failed',
    );
  }
}

function methodNotAllowed(request: Request): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: 'method_not_allowed',
        message: `${request.method} is not allowed for the tool sandbox; this endpoint is stateless.`,
      },
    },
    { status: 405, headers: { allow: 'POST' } },
  );
}

/** Serve one MCP request for the run named by the token. */
export async function handleToolSandboxRequest(
  request: Request,
  dependencies: ToolSandboxEndpointDependencies,
): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return methodNotAllowed(request);
  const verified = await verifyRunToken(request, dependencies.tokens);
  if (!verified.ok) return verified.response;
  const { claims } = verified;
  const resolved = await dependencies.sandbox.resolve(claims, verified.tokenHash);
  if (!resolved.ok) return problem(resolved.code);
  return forwardToToolSandbox(
    request,
    { origin: resolved.origin, sandboxRunId: claims.runId },
    dependencies,
  );
}

function endpointRefusal(status: 400 | 401, code: string, message: string): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: status === 401 ? 'authentication_error' : 'invalid_request_error',
        code,
        message,
      },
    },
    { status },
  );
}

/**
 * `POST /v1/tool-sandbox/endpoint/mcp` (ADR-0134 part 2): forwards a public tool endpoint call to
 * the client's endpoint tool sandbox. The caller is the control plane, whose 60-second grant names
 * the sandbox origin; the gateway recomputes the sandbox bearer from the client id, so no secret
 * travels in the request and only the gateway ever dials a tool sandbox (ADR-0118 TS3).
 */
export async function handleEndpointToolSandboxRequest(
  request: Request,
  dependencies: EndpointToolSandboxDependencies,
): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return methodNotAllowed(request);
  const token = /^Bearer\s+([^\s]+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
  const verification = token === undefined ? null : await dependencies.grants.verify(token);
  if (verification === null || !verification.ok) {
    return endpointRefusal(
      401,
      'tool_endpoint_grant_invalid',
      'The tool endpoint grant is missing, invalid or expired.',
    );
  }
  const { origin, clientId } = verification.claims;
  if (!/^https?:\/\//iu.test(origin) || !URL.canParse(origin)) {
    return endpointRefusal(
      400,
      'tool_endpoint_origin_invalid',
      'The tool endpoint grant names an origin the gateway will not dial.',
    );
  }
  return forwardToToolSandbox(
    request,
    { origin, sandboxRunId: endpointSandboxRunId(clientId) },
    dependencies,
  );
}
