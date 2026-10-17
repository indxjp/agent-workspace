/** Run ⇄ A2A v0.3 mapping: a run is a task, a session is a context (ADR-0135). */
import {
  type A2aAgentMessage,
  type A2aArtifact,
  type A2aTask,
  type A2aTaskState,
} from '@indx-workspace/contracts/a2a';
import { AgentMessageFrameSchema } from '@indx-workspace/contracts/run-events';

import type { RunRecord, RunStatus } from '../../runs/store';

export const ARTIFACT_ID = 'response';

export function taskState(status: RunStatus): A2aTaskState {
  switch (status) {
    case 'queued':
      return 'submitted';
    case 'running':
      return 'working';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default: {
      const unhandled: never = status;
      throw new Error(`unmapped run status ${String(unhandled)}`);
    }
  }
}

export function agentMessage(
  contextId: string,
  taskId: string,
  text: string,
  role: 'agent' | 'user' = 'agent',
): A2aAgentMessage {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role,
    parts: [{ kind: 'text', text }],
    contextId,
    taskId,
  };
}

export function textArtifact(text: string): A2aArtifact {
  return { artifactId: ARTIFACT_ID, name: ARTIFACT_ID, parts: [{ kind: 'text', text }] };
}

/** The prose of one stored `agent.message` frame the assistant spoke; `''` for any other frame. */
export function assistantText(type: string, data: unknown): string {
  if (type !== 'agent.message') return '';
  const frame = AgentMessageFrameSchema.safeParse(data);
  if (!frame.success || frame.data.role !== 'assistant') return '';
  return frame.data.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

/** A later chunk of the answer is separated from the earlier ones by one blank line. */
export function chunkText(index: number, text: string): string {
  return index === 0 ? text : `\n\n${text}`;
}

/** The failure text a client may see: what the run row records, which the run API already serves. */
export function failureText(run: RunRecord): string {
  return run.error ?? 'the run failed';
}

export function runTimestamp(run: RunRecord): string {
  return (run.endedAt ?? run.startedAt ?? run.createdAt).toISOString();
}

/** `answer` is the whole reply of a finished run, or `null` when it is not (yet) known. */
export function buildTask(run: RunRecord, answer: string | null, historyLength: number): A2aTask {
  const state = taskState(run.status);
  const message =
    state === 'failed' ? agentMessage(run.sessionId, run.id, failureText(run)) : undefined;
  return {
    kind: 'task',
    id: run.id,
    contextId: run.sessionId,
    status: {
      state,
      ...(message === undefined ? {} : { message }),
      timestamp: runTimestamp(run),
    },
    ...(answer === null || answer === '' ? {} : { artifacts: [textArtifact(answer)] }),
    ...(answer === null || answer === '' || historyLength === 0
      ? {}
      : { history: [agentMessage(run.sessionId, run.id, answer)] }),
  };
}
