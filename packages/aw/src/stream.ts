import { ContractViolationError } from '@indx-workspace/sdk';
import { toAgentEvent, type AgentEvent, type RunEventFrame } from '@indx-workspace/sdk/events';
import { stripControlSequences } from '@indx-workspace/sdk/portable';

import type { CliIo } from './io.js';
import type { OutputMode } from './output.js';

/**
 * The engine's own estimate, labelled as `aw runs trace` labels it (BH061-074): it is not the
 * run's accounted cost, which `aw runs get` reports from the price table once accounting settles.
 */
function money(cost: number | null): string {
  return cost === null ? '' : ` engine-cost=$${cost.toFixed(4)} (estimate)`;
}

/**
 * The one-line human rendering of a neutral event; a message's text keeps its own lines.
 *
 * A total switch over `@indx-workspace/contracts`' `AGENT_FRAME_NAMES`, with a `never` default: a
 * frame added to the vocabulary and not to this switch stops the CLI compiling rather than printing
 * nothing for an event the stream carried.
 */
function renderAgentEvent(event: AgentEvent): string {
  switch (event.frame) {
    case 'agent.session':
      return `session ${event.engineSessionId}${event.model === null ? '' : ` model=${event.model}`}`;
    case 'agent.message': {
      const text = event.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []));
      if (text.length === 0) return '';
      return event.role === 'assistant' ? text.join('\n') : `user: ${text.join('\n')}`;
    }
    case 'agent.message.delta':
      return event.text;
    case 'agent.tool.call':
      return `tool ${event.name} (${event.kind}) ${JSON.stringify(event.input)}`;
    case 'agent.tool.result':
      return `tool result ${event.toolCallId} ${event.status}${event.isError ? ' (error)' : ''}: ${event.output}`;
    case 'agent.usage':
      return `tokens=${String(event.inputTokens)}/${String(event.outputTokens)}`;
    case 'agent.result':
      return `result: ${event.stopReason}${money(event.engineCostUsd)}`;
    case 'agent.native':
      return `engine event: ${event.type}`;
    case 'agent.malformed':
      return `engine sent an unreadable event: ${event.reason}`;
    case 'agent.approval.requested':
      return `approval needed: ${event.toolName} ${event.canonicalCall}`;
    case 'agent.handoff':
      return event.reason === undefined
        ? 'handed to a person'
        : `handed to a person: ${event.reason}`;
    default:
      return unreachable(event);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled event ${JSON.stringify(value)}`);
}

function renderPlatformFrame(frame: Exclude<RunEventFrame, { kind: 'runtime' }>): string {
  switch (frame.kind) {
    case 'run-status':
      return `run: ${frame.data.status}${frame.data.error === null ? '' : ` (${frame.data.error})`}`;
    case 'run-warning':
      return `warning: ${frame.data.message ?? frame.data.code}`;
    case 'run-failed':
      return `run failed: ${frame.data.message} (status ${frame.data.status})`;
    case 'stream-reset':
      return `stream reset: ${frame.data.reason}`;
    case 'done':
      return '';
    default:
      return unreachable(frame);
  }
}

/**
 * The lines one frame produces on stdout.
 *
 * `--raw` prints the engine-native payload — an agent frame's `raw`, which is what the engine itself
 * said, and a platform frame as itself because it has no engine behind it. `--json`/`--jsonl` print
 * each `AgentEvent` (a platform frame, which has no neutral view, prints as itself and is told apart
 * by its `kind`); the default is the human rendering.
 */
export function renderFrame(frame: RunEventFrame, mode: OutputMode): readonly string[] {
  if (frame.kind !== 'runtime') {
    if (mode.raw) return [JSON.stringify(frame)];
    if (mode.json || mode.jsonl) return frame.kind === 'done' ? [] : [JSON.stringify(frame)];
    const line = stripControlSequences(renderPlatformFrame(frame));
    return line === '' ? [] : [line];
  }
  if (mode.raw) {
    // `--raw` is the diagnostic mode, so it must survive a payload the parser refuses: that payload
    // is exactly what its user is trying to look at. It prints the undecoded frame data instead of
    // aborting the stream; every other error still propagates.
    try {
      const parsed = toAgentEvent(frame);
      return parsed === null ? [] : [JSON.stringify(parsed.raw)];
    } catch (error) {
      if (error instanceof ContractViolationError) return [JSON.stringify(frame.data)];
      throw error;
    }
  }
  const event = toAgentEvent(frame);
  if (event === null) return [];
  if (mode.json || mode.jsonl) return [JSON.stringify(event)];
  // A model, a tool or the server wrote this text: a terminal must not act on it.
  const line = stripControlSequences(renderAgentEvent(event));
  return line === '' ? [] : [line];
}

/** Drain a frame stream to stdout, one rendered frame at a time, until it ends. */
export async function printStream(
  io: CliIo,
  mode: OutputMode,
  frames: AsyncIterable<RunEventFrame>,
): Promise<void> {
  for await (const frame of frames) {
    for (const line of renderFrame(frame, mode)) io.stdout(`${line}\n`);
  }
}
