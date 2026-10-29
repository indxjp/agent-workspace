/**
 * `POST /api/builder/mcp` — the `aw-control` door (Builder design §04, issue #1846 slice 2a).
 *
 * The one route that takes a run token: a running agent's calls arrive here as a `run-caller` and
 * nothing else is accepted, so a session cookie or an API key is refused. `tools/list` publishes the
 * six Builder tools; `tools/call` refuses a write or spend tool with `no_caller` when no person is
 * behind the run, and otherwise runs the core (`handleToolCall`) as the run's caller (#1846 slice 4).
 * The call id is the engine's tool-use id (`params._meta["claudecode/toolUseId"]`, which the engine
 * sets and the model cannot), so a gateway retry of one tool call is the same call; without one it is
 * minted here. A refusal never echoes the token or its claims.
 */
import {
  BUILDER_REFUSAL_CODES,
  BUILDER_TOOL_NAMES,
  BUILDER_TOOLS,
  BuilderToolInputSchemas,
  type BuilderRefusalCode,
} from '@indx-workspace/contracts/builder';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { apiError } from '../../runs/http';
import { log } from '../../telemetry/logger';
import { answerLocally, readCall, toolCallName } from '../../tool-endpoint/handler';
import { handleToolCall } from '../shell';
import type { BuilderPorts, ToolResult } from '../tools/types';
import { toCallContext, type BuilderRun, type BuilderRunReader } from './call-context';
import { verifyRunCaller, type RunCallerDeps, type RunCallerRefusal } from './run-caller';

type BuilderCallerVerification = Awaited<ReturnType<typeof verifyRunCaller>>;

/** Turns the `Authorization` header into a run-caller; the composition root builds it once. */
export type BuilderCallerVerifier = (
  authorization: string | null,
  request: Request,
) => Promise<BuilderCallerVerification>;

/** What the door is composed of; the composition root builds it once (`composition/wiring/builder.ts`). */
export interface BuilderDoor {
  readonly verifyCaller: BuilderCallerVerifier;
  /** `null` when the deployment lacks a store the tools read: every call is `builder_disabled`. */
  readonly ports: BuilderPorts | null;
  readonly readRun: BuilderRunReader;
}

const ToolUseMetaSchema = z.object({
  _meta: z.object({ 'claudecode/toolUseId': z.string().min(1).max(128) }),
});

function callIdOf(params: unknown): string {
  return ToolUseMetaSchema.safeParse(params).data?._meta['claudecode/toolUseId'] ?? randomUUID();
}

const REFUSED: RunCallerRefusal = { ok: false, code: 'not_permitted', reads: false };

/** `null` deps (no `GATEWAY_TOKEN_SECRET`) refuses every call, as an invalid token does. */
export function createBuilderCallerVerifier<Scope>(
  deps: RunCallerDeps<Scope> | null,
): BuilderCallerVerifier {
  return async (authorization, request) =>
    deps === null ? REFUSED : verifyRunCaller(authorization, deps, request);
}

// One schema per tool, rendered once: the input side is what a client sends.
export const TOOL_LIST = BUILDER_TOOL_NAMES.map((name) => ({
  name,
  description: `${BUILDER_TOOLS[name].display} (${BUILDER_TOOLS[name].kind})`,
  inputSchema: z.toJSONSchema(BuilderToolInputSchemas[name], {
    io: 'input',
    unrepresentable: 'any',
  }),
}));

export async function serveBuilderMcp(request: Request, deps: BuilderDoor): Promise<Response> {
  if (request.method !== 'POST') {
    const response = apiError(405, 'method_not_allowed', 'this endpoint accepts POST only.');
    response.headers.set('Allow', 'POST');
    return response;
  }
  const verified = await deps.verifyCaller(request.headers.get('authorization'), request);
  if ('refused' in verified) return verified.refused;
  if (!verified.ok && !verified.reads) {
    const refusal = BUILDER_REFUSAL_CODES[verified.code];
    return apiError(refusal.status, verified.code, refusal.fix);
  }
  const call = await readCall(request);
  if (call instanceof Response) return call;
  const local = answerLocally(call);
  if (local !== null) return local;
  if (call.method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id: call.id ?? null, result: { tools: TOOL_LIST } });
  }
  // answerLocally leaves only tools/list and tools/call to this point.
  const result = await callTool(request, call.params, verified, deps);
  return Response.json({ jsonrpc: '2.0', id: call.id ?? null, result: toolAnswer(result) });
}

const INTERNAL_ERROR: ToolResult = {
  ok: false,
  code: 'internal_error',
  message: 'The tool failed. Try again or stop.',
};

/**
 * A write or spend tool needs a person behind the run: without one it is refused with the reason
 * the caller check gave, before any port. A run without a model or pinned version is not answered.
 */
async function callTool(
  request: Request,
  params: unknown,
  verified: Exclude<BuilderCallerVerification, { readonly reads: false }>,
  deps: BuilderDoor,
): Promise<ToolResult> {
  const known = BUILDER_TOOL_NAMES.find((name) => name === toolCallName(params));
  if (!verified.ok && known !== undefined && BUILDER_TOOLS[known].kind !== 'read') {
    return refusal(verified.code);
  }
  if (deps.ports === null) return refusal('builder_disabled');
  const identity = verified.ok ? verified.caller : verified.run;
  let run: BuilderRun | null;
  try {
    run = await deps.readRun(identity);
  } catch {
    // Only the run's ids are logged: never the error, the token or its claims.
    const { runId, workspaceId } = identity;
    log.error('builder run read failed', { op: 'builder.transport', runId, workspaceId });
    return INTERNAL_ERROR;
  }
  if (run === null) return refusal('not_permitted');
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const raw = { name, arguments: args, callId: callIdOf(params) };
  return handleToolCall(raw, toCallContext(identity, run), deps.ports, request.signal);
}

export function refusal(code: BuilderRefusalCode): ToolResult {
  const fix = BUILDER_REFUSAL_CODES[code].fix;
  return { ok: false, code, message: fix, fix };
}

export function toolAnswer(result: ToolResult) {
  const content = [{ type: 'text', text: JSON.stringify(result) }];
  return result.ok ? { content, isError: false } : { content, isError: true };
}
