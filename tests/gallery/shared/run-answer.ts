/**
 * The backend half every gallery use case shares: start a run, follow its stream for the tool calls
 * the agent made, and read its answer.
 *
 * The answer is the platform's (ADR-0143): `runs.result()` returns the run's `text`, and with a Zod
 * `schema` the run is started with it as `outputSchema` and `result()` returns the typed `output`.
 * Only the tool calls are still read from the stream, because they exist nowhere else and a
 * backend that checks the agent's work against what its tools returned needs them.
 */
import type { RunApprovalCall, RunResource } from '@indx-workspace/contracts/runs';
import { runFailure, type AgentWorkspaceClient, type StartRunInput } from '@indx-workspace/sdk';
import { toAgentEvent } from '@indx-workspace/sdk/events';
import { z } from 'zod';

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly output: string | null;
  readonly isError: boolean;
}

export interface RunReading<Output = unknown> {
  /** The settled run: its terminal status, usage and cost. */
  readonly run: RunResource;
  /** The run's answer as text. Empty when the agent said nothing. */
  readonly answer: string;
  /** The structured answer: the `schema`'s parse when one was given, otherwise whatever the run stored. */
  readonly output: Output;
  /** Every tool call in the order the agent made it, paired with its result. */
  readonly toolCalls: readonly ToolCall[];
  /** Why the agent handed the conversation to a person (`agent.handoff`); `null` when it did not. */
  readonly handoff: string | null;
}

export class RunDidNotComplete extends Error {
  // A plain field, not a parameter property: this file runs under Node's type stripping too.
  public readonly run: RunResource;

  public constructor(run: RunResource) {
    super(`run ${run.id} ended ${run.status}: ${runFailure(run)?.message ?? 'no reason given'}`);
    this.name = 'RunDidNotComplete';
    this.run = run;
  }
}

/**
 * What a backend answers for a run that paused on a gated write (ADR-0145): nothing was written
 * yet. A person decides the call with `runs.approve(runId)` / `runs.reject(runId)`, and the
 * decision starts a continuation run in the same session, which {@link readRun} reads.
 */
export interface AwaitingApproval {
  readonly status: 'awaiting_approval';
  readonly runId: string;
  readonly sessionId: string;
  /** The call the run waits on: its tool name and the canonical text a person approves. */
  readonly call: RunApprovalCall;
  /** The calls the run made before it paused; the paused call has no result. */
  readonly toolCalls: readonly ToolCall[];
}

/** The run paused at `awaiting_approval`; {@link RunAwaitingApproval.pending} is the typed result. */
export class RunAwaitingApproval extends RunDidNotComplete {
  public readonly pending: AwaitingApproval;

  public constructor(run: RunResource, call: RunApprovalCall, toolCalls: readonly ToolCall[]) {
    super(run);
    this.name = 'RunAwaitingApproval';
    this.pending = {
      status: 'awaiting_approval',
      runId: run.id,
      sessionId: run.sessionId,
      call,
      toolCalls,
    };
  }
}

/**
 * Start `agentId` with `input`, follow the run to its end, and read what the agent said and did.
 * With `schema` the run asks for that shape and `output` is its typed parse.
 *
 * @throws {RunAwaitingApproval} when the run paused on a gated write.
 * @throws {RunDidNotComplete} when the run settles as anything else but `completed`.
 */
export async function runAndRead<Schema extends z.ZodType>(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: StartRunInput,
  schema: Schema,
): Promise<RunReading<z.output<Schema>>>;
export async function runAndRead(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: StartRunInput,
): Promise<RunReading>;
export async function runAndRead(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: StartRunInput,
  schema?: z.ZodType,
): Promise<RunReading> {
  const { run } = await aw.runs.start(
    agentId,
    schema === undefined ? input : { ...input, outputSchema: schema },
  );
  return schema === undefined ? readRun(aw, run.id) : readRun(aw, run.id, schema);
}

/** The tool call a run stopped at, parsed from `pendingApproval.canonicalCall` (ADR-0145 D2.1). */
export interface PendingCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const PendingCallSchema = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) });

/** The paused call's name and input. The canonical text is the platform's, but untrusted until parsed. */
export function pendingCall(call: RunApprovalCall): PendingCall {
  return PendingCallSchema.parse(JSON.parse(call.canonicalCall));
}

/**
 * Follow a run somebody else started (a trigger's firing) to its end and read it, as
 * {@link runAndRead} does after it starts one. With `schema` the answer is validated against it;
 * the run itself must have asked for a schema, because a run that did not has `output: null`.
 *
 * @throws {RunAwaitingApproval} when the run paused on a gated write.
 * @throws {RunDidNotComplete} when the run settles as anything else but `completed`.
 */
export async function readRun<Schema extends z.ZodType>(
  aw: AgentWorkspaceClient,
  runId: string,
  schema: Schema,
): Promise<RunReading<z.output<Schema>>>;
export async function readRun(aw: AgentWorkspaceClient, runId: string): Promise<RunReading>;
export async function readRun(
  aw: AgentWorkspaceClient,
  runId: string,
  schema?: z.ZodType,
): Promise<RunReading> {
  const followed = await follow(aw, runId, schema);
  return toReading(followed, schema);
}

interface Followed {
  readonly result: Awaited<ReturnType<AgentWorkspaceClient['runs']['result']>>;
  readonly toolCalls: readonly ToolCall[];
  readonly handoff: string | null;
}

async function follow(
  aw: AgentWorkspaceClient,
  runId: string,
  schema?: z.ZodType,
): Promise<Followed> {
  const calls = new Map<string, { name: string; input: unknown }>();
  const results = new Map<string, { output: string; isError: boolean }>();
  let handoff: string | null = null;
  let after: string | null = null;

  for await (const frame of aw.runs.follow(runId)) {
    if ((frame.kind === 'run-status' || frame.kind === 'runtime') && frame.id) after = frame.id;
    const event = toAgentEvent(frame);
    if (event === null) continue;
    if (event.frame === 'agent.tool.call') {
      calls.set(event.toolCallId, { name: event.name, input: event.input });
    } else if (event.frame === 'agent.tool.result') {
      results.set(event.toolCallId, { output: event.output, isError: event.isError });
    } else if (event.frame === 'agent.handoff') {
      handoff ??= event.reason ?? 'no reason given';
    }
  }

  // `after` makes the second follow inside `result()` resume at the end of the stream just read.
  const result =
    schema === undefined
      ? await aw.runs.result(runId, { after })
      : await aw.runs.result(runId, { schema, after });
  const toolCalls = [...calls].map(([id, call]) => ({
    name: call.name,
    input: call.input,
    output: results.get(id)?.output ?? null,
    isError: results.get(id)?.isError ?? false,
  }));
  return { result, toolCalls, handoff };
}

function toReading(followed: Followed, schema?: z.ZodType): RunReading {
  const { result, toolCalls, handoff } = followed;
  const { pendingApproval } = result.run;
  if (result.run.status === 'awaiting_approval' && pendingApproval !== null) {
    throw new RunAwaitingApproval(result.run, pendingApproval, toolCalls);
  }
  if (result.run.status !== 'completed') throw new RunDidNotComplete(result.run);
  if (schema !== undefined && result.output === null) {
    throw new Error(`run ${result.run.id} completed without structured output`);
  }
  return { run: result.run, answer: result.text ?? '', output: result.output, toolCalls, handoff };
}
