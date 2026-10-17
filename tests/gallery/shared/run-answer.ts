/**
 * The backend half every gallery use case shares: start a run, follow its stream, and come back
 * with the answer text and the tool calls the agent made.
 *
 * This is the code a developer writes today, and it is longer than it should be. `RunResource`
 * carries status, usage and cost but no answer, so the answer is rebuilt from the neutral `agent.*`
 * events: an assistant message is a snapshot that a later frame with the same `messageId`
 * replaces, and only the last message of the turn is the answer. The gallery records that as the
 * "structured output" gap (see `../harness/probes.ts`).
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import { runFailure, type AgentWorkspaceClient, type StartRunInput } from '@indx-workspace/sdk';
import { assistantResponseFromAgentEvent, toAgentEvent } from '@indx-workspace/sdk/events';

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly output: string | null;
  readonly isError: boolean;
}

export interface RunReading {
  /** The settled run: its terminal status, usage and cost. */
  readonly run: RunResource;
  /** The text of the last assistant message, the agent's answer. Empty when it said nothing. */
  readonly answer: string;
  /** Every tool call in the order the agent made it, paired with its result. */
  readonly toolCalls: readonly ToolCall[];
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
 * Start `agentId` with `input`, follow the run to its end, and read what the agent said and did.
 *
 * @throws {RunDidNotComplete} when the run settles as anything but `completed`.
 */
export async function runAndRead(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: StartRunInput,
): Promise<RunReading> {
  const { run } = await aw.runs.start(agentId, input);
  const messages = new Map<string, string>();
  const calls = new Map<string, { name: string; input: unknown }>();
  const results = new Map<string, { output: string; isError: boolean }>();

  for await (const frame of aw.runs.follow(run.id)) {
    const event = toAgentEvent(frame);
    if (event === null) continue;
    if (event.frame === 'agent.tool.call') {
      calls.set(event.toolCallId, { name: event.name, input: event.input });
    } else if (event.frame === 'agent.tool.result') {
      results.set(event.toolCallId, { output: event.output, isError: event.isError });
    }
    const response = assistantResponseFromAgentEvent(event);
    if (response !== null) {
      // Re-inserting moves the message to the end, so the last one written is the last one said.
      messages.delete(response.id);
      messages.set(response.id, response.text.join('\n'));
    }
  }

  const settled = await aw.runs.get(run.id);
  if (settled.status !== 'completed') throw new RunDidNotComplete(settled);
  const toolCalls = [...calls].map(([id, call]) => ({
    name: call.name,
    input: call.input,
    output: results.get(id)?.output ?? null,
    isError: results.get(id)?.isError ?? false,
  }));
  return { run: settled, answer: [...messages.values()].at(-1) ?? '', toolCalls };
}
