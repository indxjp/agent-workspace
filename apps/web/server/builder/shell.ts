import { randomUUID } from 'node:crypto';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  BUILDER_DEFAULT_LIMITS,
  BUILDER_REFUSAL_CODES,
  BUILDER_TOOLS,
  BUILDER_TOOL_NAMES,
  BuilderToolInputSchemas,
  BuilderToolOutputSchemas,
  type BuilderDecision,
  type BuilderRefusalCode,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import { z } from 'zod';

import { log } from '../telemetry/logger';
import { callDigest } from './call-digest';
import type { ToolCall } from './core/call';
import { decide } from './core/decide';
import { approvalQuestion } from './core/rules';
import { startOfUtcDay, type Facts, type JournalRow } from './core/facts';
import type { CallContext } from './ports';
import { execute } from './tools/index';
import type { BuilderPorts, ToolFailure, ToolResult } from './tools/types';

/** The MCP `tools/call` params plus the engine's tool-use id; not strict, since MCP may add `_meta`. */
const EnvelopeSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
  callId: z.string().min(1).max(128),
});

const INTERNAL_ERROR: ToolFailure = {
  ok: false,
  code: 'internal_error',
  message: 'The tool failed. Try again or stop.',
};

type Row = {
  readonly callId: string;
  readonly tool: BuilderToolName | null;
  readonly decision: BuilderDecision['kind'];
  readonly input: unknown;
  readonly result: ToolResult;
};

/** Parse, gather facts, decide, run, journal once, cap. Expected failures are results, never thrown. */
export async function handleToolCall(
  raw: unknown,
  ctx: CallContext,
  ports: BuilderPorts,
  signal?: AbortSignal,
): Promise<ToolResult> {
  // A malformed envelope writes no journal row: there is no call id to key it. An unknown tool does,
  // with a null tool and none of the model's arguments.
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) return refusal('invalid_arguments', issuesOf(envelope.error));
  const { name, callId } = envelope.data;
  const args = envelope.data.arguments ?? {};
  const tool = BUILDER_TOOL_NAMES.find((known) => known === name);
  if (tool === undefined) {
    const result = refusal('unknown_tool');
    const row = { callId, tool: null, decision: 'refuse' as const, input: undefined, result };
    return finish(ctx, ports, row, BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes);
  }

  const parsed = parseCall(tool, callId, args);
  if (parsed instanceof z.ZodError) {
    const result = refusal('invalid_arguments', issuesOf(parsed));
    const row = { callId, tool, decision: 'refuse' as const, input: args, result };
    return finish(ctx, ports, row, BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes);
  }

  let decision: BuilderDecision['kind'] = 'refuse';
  let maxBytes: number = BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes;
  let result: ToolResult;
  try {
    const replayed = await replayOf(tool, callId, ctx, ports);
    if (replayed !== null) return replayed;
    const facts = await gatherFacts(parsed, envelope.data.arguments, ctx, ports, signal);
    if ('unresolved' in facts) {
      // The door names no caller the deployment can resolve: refused, never run as the Builder. A
      // switched-off feature is still the answer first, as `featureOff` is the first rule.
      result = refusal(facts.enabled ? 'not_permitted' : 'builder_disabled');
    } else {
      maxBytes = facts.limits.toolOutputMaxBytes;
      const decided = decide(parsed, facts);
      decision = decided.kind;
      const claimed =
        decided.kind !== 'run' ||
        (await claimApproval(parsed, envelope.data.arguments, ctx, ports));
      if (claimed) result = await resultOf(decided, parsed, ctx, ports, facts.creator);
      else {
        decision = 'ask';
        const question = approvalQuestion(parsed.tool);
        result = refusal('approval_required', question === null ? undefined : [question]);
      }
    }
  } catch (err) {
    // An abort is the caller going away, not an adapter failure: logged at info with its own op.
    if (signal?.aborted === true) logAbort(ctx, tool);
    else logFailure(ctx, tool, err);
    result = INTERNAL_ERROR;
  }
  return finish(ctx, ports, { callId, tool, decision, input: parsed.input, result }, maxBytes);
}

function parseCall(tool: BuilderToolName, callId: string, args: unknown): ToolCall | z.ZodError {
  const schemas = BuilderToolInputSchemas;
  switch (tool) {
    case 'catalog_list':
      return made(schemas[tool].safeParse(args), (input) => ({ tool, input, callId }));
    case 'examples_get':
      return made(schemas[tool].safeParse(args), (input) => ({ tool, input, callId }));
    case 'draft_check':
      return made(schemas[tool].safeParse(args), (input) => ({ tool, input, callId }));
    case 'draft_save':
      return made(schemas[tool].safeParse(args), (input) => ({ tool, input, callId }));
    case 'evals_run':
      return made(schemas[tool].safeParse(args), (input) => ({ tool, input, callId }));
    case 'trial_run':
      return made(schemas[tool].safeParse(args), (input) => ({ tool, input, callId }));
    default: {
      const unhandled: never = tool;
      return unhandled;
    }
  }
}

function made<T>(parsed: z.ZodSafeParseResult<T>, build: (input: T) => ToolCall) {
  return parsed.success ? build(parsed.data) : parsed.error;
}

/** Short `path: message` lines; zod messages name keys and expected types, never the values. */
function issuesOf(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const at = (path: readonly PropertyKey[]) => path.map(String).join('.') || '(root)';
    return issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => `${at([...issue.path, key])}: Unrecognized key`)
      : [`${at(issue.path)}: ${issue.message}`];
  });
}

/**
 * A retry of a write that already succeeded gets the first result back, unchanged and unjournaled,
 * so it counts as no new tool call. The stored JSON is untrusted until the tool's output schema
 * accepts it.
 */
async function replayOf(
  tool: BuilderToolName,
  callId: string,
  ctx: CallContext,
  ports: BuilderPorts,
): Promise<ToolResult | null> {
  if (BUILDER_TOOLS[tool].kind === 'read') return null;
  const stored = await ports.audit.replay(ctx, callId, tool);
  if (stored === null) return null;
  const output = BuilderToolOutputSchemas[tool].safeParse(stored.result);
  if (!output.success) throw new Error('The stored result of a replayed call is not valid.');
  return output.data;
}

async function gatherFacts(
  call: ToolCall,
  rawArguments: unknown,
  ctx: CallContext,
  ports: BuilderPorts,
  signal: AbortSignal | undefined,
): Promise<Facts | { readonly unresolved: true; readonly enabled: boolean }> {
  signal?.throwIfAborted();
  const agentId = 'agentId' in call.input ? call.input.agentId : undefined;
  const [enabled, access, limits, run, approval, localVersion, creator, creationsToday] =
    await untilAborted(
      Promise.all([
        ports.feature.enabled(ctx),
        ports.authorization.access(ctx, BUILDER_TOOLS[call.tool].kind, agentId),
        ports.policy.limits(ctx),
        ports.audit.runCounts(ctx),
        approvalOf(call, rawArguments, ctx, ports),
        call.tool === 'draft_save' && call.input.agentId !== undefined
          ? ports.store.localVersion(ctx, call.input.agentId)
          : Promise.resolve(null),
        ports.authorization.creator(ctx),
        // Only a save of a new agent is held to the quota, so only that call counts.
        call.tool === 'draft_save' && call.input.agentId === undefined
          ? ports.store.creationsSince(ctx, startOfUtcDay(ports.clock()))
          : Promise.resolve(0),
      ]),
      signal,
    );
  const caller: Facts['caller'] =
    ctx.caller.kind === 'person'
      ? { kind: 'person', role: ctx.caller.principal.role }
      : { kind: 'none' };
  if (creator === null) return { unresolved: true, enabled };
  // Only an agent creator is held to what it runs, so only then is the named version looked up.
  const target =
    creator.kind === 'agent' && (call.tool === 'trial_run' || call.tool === 'evals_run')
      ? await untilAborted(
          ports.authorization.target(ctx, call.input.agentId, call.input.version),
          signal,
        )
      : null;
  return {
    enabled,
    caller,
    access,
    limits,
    run,
    approval,
    local: { version: localVersion },
    creator,
    creationsToday,
    target,
  };
}

/**
 * Takes the approval of an approved write or spend, once, before it runs. The claim is a journal row
 * with a fixed id per tool and raw arguments, so the journal's unique key lets one concurrent call
 * win and answers `false` to the rest. The row is a `refused` call of the tool: it counts as one
 * tool call in the run's tally, and it is never replayable as a result.
 */
async function claimApproval(
  call: ToolCall,
  rawArguments: unknown,
  ctx: CallContext,
  ports: BuilderPorts,
): Promise<boolean> {
  if (approvalQuestion(call.tool) === null) return true;
  return ports.audit.record(ctx, {
    callId: `approval:${call.tool}:${callDigest(call.tool, rawArguments ?? {})}`,
    tool: call.tool,
    decision: 'ask',
    outcome: 'refused',
    code: 'approval_required',
    input: {},
    result: null,
  });
}

/**
 * The approval record is keyed by the model's raw arguments, as the gateway canonicalised them,
 * never the parsed input. It is good for one use: once this run journaled a call of the same tool with
 * the same input that ended `ok` or `error` (a failed write may still have happened), the approval is
 * spent, so a holder of the run token who posts the approved arguments again, under a new call id, is
 * asked again. An input the journal cut short is matched by its digest; one it could not serialise, or
 * a cut-short one without a digest, counts as the same.
 */
async function approvalOf(
  call: ToolCall,
  rawArguments: unknown,
  ctx: CallContext,
  ports: BuilderPorts,
): Promise<Facts['approval']> {
  if (approvalQuestion(call.tool) === null) return 'not_needed';
  const status = await ports.approval.status(ctx, { tool: call.tool, arguments: rawArguments });
  if (status !== 'granted') return status;
  const spent = (await ports.audit.spentInputs(ctx, call.tool)).some((input) =>
    sameInput(call.tool, input, call.input),
  );
  return spent ? 'missing' : 'granted';
}

function sameInput(tool: BuilderToolName, journaled: unknown, input: unknown): boolean {
  // The journal's own stand-ins for an input it could not keep whole; a tool input never has these keys.
  if (typeof journaled === 'object' && journaled !== null) {
    if ('unserialisable' in journaled) return true;
    if ('truncated' in journaled) {
      const { sha256 } = journaled as { sha256?: unknown };
      // Without a digest nothing tells it apart, so it counts as the same.
      return typeof sha256 !== 'string' || sha256 === callDigest(tool, input);
    }
  }
  try {
    return canonicalCall(tool, journaled) === canonicalCall(tool, input);
  } catch {
    return true;
  }
}

/** The ports take no signal, so an abort rejects the wait instead; the port calls are left to settle. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('The request was aborted.', { cause: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function resultOf(
  decision: BuilderDecision,
  call: ToolCall,
  ctx: CallContext,
  ports: BuilderPorts,
  creator: Facts['creator'],
): Promise<ToolResult> {
  switch (decision.kind) {
    case 'run':
      return execute(call, ctx, ports, creator);
    case 'refuse':
      return { ...refusal(decision.code, decision.details), message: decision.message };
    case 'ask':
      return refusal('approval_required', [decision.question]);
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

function refusal(code: BuilderRefusalCode, details?: readonly string[]): ToolFailure {
  const fix = BUILDER_REFUSAL_CODES[code].fix;
  return { ok: false, code, message: fix, ...(details === undefined ? {} : { details }), fix };
}

/** Journals the call once, then caps it. A journal failure is an internal error, logged once in all. */
async function finish(
  ctx: CallContext,
  ports: BuilderPorts,
  row: Row,
  maxBytes: number,
): Promise<ToolResult> {
  const { result } = row;
  const code = result.ok ? null : result.code;
  try {
    const entry = { ...row, outcome: outcomeOf(result), code };
    // The call id comes from the client, so a repeated id must still count: journal it again.
    if (!(await ports.audit.record(ctx, entry))) {
      await ports.audit.record(ctx, { ...entry, callId: `${row.callId}:${randomUUID()}` });
    }
  } catch (err) {
    if (result !== INTERNAL_ERROR) logFailure(ctx, row.tool, err);
    return INTERNAL_ERROR;
  }
  return capped(result, maxBytes);
}

function outcomeOf(result: ToolResult): JournalRow['outcome'] {
  if (result.ok) return 'ok';
  if (result.code === INTERNAL_ERROR.code) return 'error';
  return Object.hasOwn(BUILDER_REFUSAL_CODES, result.code) ? 'refused' : 'check_failed';
}

function logFailure(ctx: CallContext, tool: BuilderToolName | null, err: unknown): void {
  const { runId, workspaceId, traceId } = ctx;
  // The name only: an adapter error's message can carry a credential too short for redaction to match.
  const errorName = err instanceof Error ? err.name : typeof err;
  log.error('builder tool failed', {
    op: 'builder.tool',
    tool,
    runId,
    workspaceId,
    traceId,
    errorName,
  });
}

function logAbort(ctx: CallContext, tool: BuilderToolName): void {
  const { runId, workspaceId, traceId } = ctx;
  log.info('builder tool call aborted', {
    op: 'builder.tool.aborted',
    tool,
    runId,
    workspaceId,
    traceId,
  });
}

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Cuts a result over `maxBytes` by shortening its longest top-level array until it fits, and marks
 * it `truncated: true`; keys and types stay the same. A result whose arrays are all empty and still
 * too big is returned as it is: the cap never turns a result into an error.
 */
export function capped(result: ToolResult, maxBytes: number): ToolResult {
  if (sizeOf(result) <= maxBytes) return result;
  const cut: ToolResult = { ...result, truncated: true };
  for (let size = sizeOf(cut); size > maxBytes; size = sizeOf(cut)) {
    const [longest] = Object.entries(cut)
      .flatMap(([key, value]) => (Array.isArray(value) && value.length > 0 ? [{ key, value }] : []))
      .sort((a, b) => b.value.length - a.value.length);
    if (longest === undefined) break;
    const keep = Math.min(
      longest.value.length - 1,
      Math.floor((longest.value.length * maxBytes) / size),
    );
    // A shorter copy of the same array under the same key: the result's type is unchanged.
    Reflect.set(cut, longest.key, longest.value.slice(0, keep));
  }
  return cut;
}
