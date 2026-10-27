/**
 * `POST /v1/tools/aw-control/mcp` (#1846): forwards a run's MCP request for the Builder's
 * `aw-control` tools to the control plane's `/api/builder/mcp`. The run token is the only
 * credential it carries. The control-plane origin is set once, at deploy time; it never comes from
 * a request, a header or a run row, so nothing a run controls decides where its token goes.
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';
import {
  AW_CONTROL_CONNECTOR,
  TOOL_GATEWAY_PROBLEM_CODES,
} from '@indx-workspace/contracts/tool-connectors';
import { z } from 'zod';

import { verifyRunToken } from '../auth.js';
import type { RunTokenClaims, RunTokenCodec } from '../tokens/run-token.js';
import { awControlApprovalDecision, type ToolApproval, type ToolRefusal } from './authorize.js';
import { upstreamFailure } from './openapi.js';
import { liveRun, toolProblem } from './sandbox.js';

/**
 * An http(s) origin with no credentials, path, query or fragment, as the deployment sets
 * `GATEWAY_CONTROL_PLANE_ORIGIN`; parsed to its normalised `URL.origin`.
 */
const ControlPlaneOriginSchema = z
  .url({ protocol: /^https?$/u })
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
  )
  .transform((url) => url.origin);

/**
 * The control-plane origin from `GATEWAY_CONTROL_PLANE_ORIGIN`, checked once at startup: `undefined`
 * when unset (every `aw-control` call is then refused), and a startup error when it is not an
 * http(s) origin. The error never repeats the value.
 */
export function parseControlPlaneOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = ControlPlaneOriginSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error(
      'GATEWAY_CONTROL_PLANE_ORIGIN must be an http(s) origin with no credentials, path or query.',
    );
  }
  return parsed.data;
}

type AwControlResolution = { readonly ok: true; readonly approval: ToolApproval } | ToolRefusal;

/** Authorises a verified run token for `aw-control` on every request: the token and run are live. */
export interface AwControlResolver {
  resolve(claims: RunTokenClaims, tokenHash: string): Promise<AwControlResolution>;
}

export type AwControlDependencies = {
  readonly tokens: RunTokenCodec;
  /** From {@link parseControlPlaneOrigin}; without it every call is refused. */
  readonly origin?: string;
  readonly runs?: AwControlResolver;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

type AwControlProblem =
  | 'tool_control_plane_unconfigured'
  | 'tool_upstream_failed'
  | 'tool_upstream_timeout'
  | ToolRefusal['code'];

const MESSAGES: Readonly<Record<AwControlProblem, string>> = {
  tool_control_plane_unconfigured: 'This gateway has no control-plane origin for aw-control.',
  tool_run_not_active: 'The run named by this gateway token is not active.',
  tool_not_in_run: 'This run cannot use aw-control.',
  tool_upstream_failed: 'The control plane did not answer.',
  tool_upstream_timeout: 'The control plane did not answer in time.',
};

const DEFAULT_TIMEOUT_MS = 120_000;
/** The cap on the request body and on the control plane's answer, as the tool sandbox route's. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** One JSON-RPC message: an object, whose `method` (absent on a response) is a string. */
const MessageSchema = z.looseObject({ method: z.string().optional() });

/** The one MCP message whose tool name the backstop decides on; any other message is forwarded. */
const ToolsCallSchema = z.looseObject({
  method: z.literal('tools/call'),
  id: z.union([z.string(), z.number()]),
  params: z.looseObject({ name: z.string().min(1), arguments: z.unknown().optional() }),
});

function problem(code: AwControlProblem): Response {
  return toolProblem(code, MESSAGES[code]);
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: 'method_not_allowed',
        message: `${method} is not allowed for aw-control; this endpoint is stateless.`,
      },
    },
    { status: 405, headers: { allow: 'POST' } },
  );
}

function invalid(message: string, status: 400 | 413): Response {
  return Response.json(
    {
      type: 'error',
      error: { type: status === 413 ? 'request_too_large' : 'invalid_request_error', message },
    },
    { status },
  );
}

/** The token is live and its run is not over; the run's approved calls feed the backstop. */
export function createDatabaseAwControlResolver(database: DatabaseRoot): AwControlResolver {
  return {
    async resolve(claims, tokenHash): Promise<AwControlResolution> {
      const notActive: ToolRefusal = {
        ok: false,
        status: TOOL_GATEWAY_PROBLEM_CODES.tool_run_not_active,
        code: 'tool_run_not_active',
      };
      const live = await liveRun(database, claims, tokenHash);
      if (live === null) return notActive;
      const { runs, run } = live;
      return {
        ok: true,
        approval: {
          serverKey: AW_CONTROL_CONNECTOR,
          approvedToolCalls: (run.approvedToolCalls ?? []).map((call) => call.canonicalCall),
          consume: (call) => runs.consumeApprovedCall(run.id, call),
        },
      };
    },
  };
}

/**
 * The backstop to the engine's `canUseTool`, as `callTool` applies it to a connector: a `tools/call`
 * of a write or spend tool runs only when its canonical call is approved, and uses the approval up
 * once before the control plane is dialled. Returns the MCP tool error to answer instead, or `null`.
 */
async function backstop(
  message: z.infer<typeof MessageSchema>,
  approval: ToolApproval,
): Promise<Response | null> {
  if (message.method !== 'tools/call') return null;
  const call = ToolsCallSchema.safeParse(message);
  if (!call.success) return invalid('An aw-control tools/call must name its tool.', 400);
  const { id, params } = call.data;
  const decision = awControlApprovalDecision(approval, params.name, params.arguments);
  if (decision.kind === 'read') return null;
  const outcome =
    decision.kind === 'write' ? await approval.consume(decision.call) : 'not-approved';
  if (outcome === 'consumed') return null;
  const result =
    outcome === 'already-used'
      ? upstreamFailure(
          'approval_already_used',
          `${params.name} runs once per approval, and this one was already used`,
        )
      : upstreamFailure('approval_required', `${params.name} runs only after the call is approved`);
  return Response.json({ jsonrpc: '2.0', id, result });
}

/** The upstream body up to `limit` bytes, counted as it streams; `null` past the limit. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body?.getReader();
  for (;;) {
    const chunk = await reader?.read();
    if (chunk === undefined || chunk.done) return Buffer.concat(chunks);
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader?.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
}

/** Serve one MCP request for `aw-control`, for the run named by the token. */
export async function handleAwControlRequest(
  request: Request,
  dependencies: AwControlDependencies,
): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return methodNotAllowed(request.method);
  const verified = await verifyRunToken(request, dependencies.tokens);
  if (!verified.ok) return verified.response;
  const { origin, runs } = dependencies;
  // No fallback of any kind: without the deployment's origin there is nowhere to forward to.
  if (origin === undefined || runs === undefined) return problem('tool_control_plane_unconfigured');
  const resolved = await runs.resolve(verified.claims, verified.tokenHash);
  if (!resolved.ok) return problem(resolved.code);

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return invalid('The aw-control request body is too large.', 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return invalid('The aw-control request body is too large.', 413);
  }
  let message: unknown;
  try {
    message = JSON.parse(UTF8.decode(body));
  } catch {
    message = null;
  }
  // One message only: a batch could hide a write the backstop would have to decide on in part.
  const parsed = MessageSchema.safeParse(message);
  if (!parsed.success) return invalid('An aw-control request is one JSON-RPC message.', 400);
  const refused = await backstop(parsed.data, resolved.approval);
  if (refused !== null) return refused;

  try {
    // The original bytes, the caller's own (verified) run token and fixed MCP framing; nothing else.
    const upstream = await (dependencies.fetch ?? fetch)(`${origin}/api/builder/mcp`, {
      method: 'POST',
      headers: {
        authorization: request.headers.get('authorization') ?? '',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const answer = await readCapped(upstream.body, MAX_BODY_BYTES);
    if (answer === null) return problem('tool_upstream_failed');
    const contentType = upstream.headers.get('content-type');
    return new Response(answer, {
      status: upstream.status,
      headers: contentType === null ? {} : { 'content-type': contentType },
    });
  } catch (error) {
    // The error text may name the origin, so only its class decides the answer.
    return problem(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'tool_upstream_timeout'
        : 'tool_upstream_failed',
    );
  }
}
