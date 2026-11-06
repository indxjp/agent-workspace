import { AgentFrameSchema, RunStatusEventDataSchema } from '@indx-workspace/contracts/run-events';
import type { RunResource } from '@indx-workspace/contracts/runs';
import {
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
} from '@indx-workspace/contracts/runs';
import type { ScriptAnswer } from './scripted-workspace-types.ts';

const ENGINE = 'claude-agent-sdk';

export function frame(name: string, fields: Record<string, unknown>): string {
  const data = AgentFrameSchema.parse({ frame: name, engine: ENGINE, raw: null, ...fields });
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function statusFrame(
  id: number,
  status: RunResource['status'],
  error: string | null = null,
): string {
  const data = RunStatusEventDataSchema.parse({ status, error });
  return `event: run.status\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function scriptedCompletion(
  runId: string,
  scripted: ScriptAnswer,
  outputSchema: Readonly<Record<string, unknown>> | null,
  handoff: string | null,
) {
  const events: string[] = [];
  // The platform stores `structured: null` for a run that asked for no schema (runs/store.ts).
  const text = typeof scripted === 'string' ? scripted : scripted.text;
  const structured =
    typeof scripted === 'string' || outputSchema === null ? null : scripted.structured;
  const unsatisfied = outputSchema !== null && structured === null;
  const output = unsatisfied ? null : { text, structured };
  events.push(
    frame('agent.message', {
      messageId: `msg_${runId}`,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
    }),
  );
  events.push(
    frame('agent.usage', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      reasoningTokens: null,
    }),
  );
  events.push(
    frame('agent.result', {
      stopReason: 'end_turn',
      turns: 1,
      engineCostUsd: null,
      ...(output === null ? {} : { output }),
    }),
  );
  if (handoff !== null) events.push(frame('agent.handoff', { reason: handoff }));
  const error = unsatisfied
    ? `${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`
    : null;
  const status = unsatisfied ? 'failed' : 'completed';
  events.push(statusFrame(2, status, error), 'event: done\ndata: null\n\n');

  return { events, status, output, error } as const;
}
