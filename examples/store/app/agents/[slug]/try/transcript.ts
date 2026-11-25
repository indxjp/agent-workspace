/**
 * What one demo turn looks like as its run's events arrive: the tool steps, the approval wait, the
 * answer and the cap it stopped at. Pure (no React), so `tests/store/try-*.test.ts` runs it. A
 * turn is one question; an approval's continuation run carries on the same turn.
 */
import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import type { RunApprovalCall, RunStatus } from '@indx-workspace/contracts/runs';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

/** One tool call and, once the tool answered, its output. */
export interface ToolStep {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output: string | null;
  readonly isError: boolean;
}

export interface Turn {
  /** The run now being followed: the question's, then each approval continuation's. */
  readonly runId: string;
  readonly prompt: string;
  readonly status: RunStatus;
  readonly tools: readonly ToolStep[];
  /** The assistant's answers by the engine's message id, in order; a repeated id replaces. */
  readonly answers: readonly { readonly id: string; readonly text: string }[];
  /** The tool call the run waits for a person's decision on, while it does. */
  readonly pendingApproval: RunApprovalCall | null;
  /** The engine's stop reason once it reported one, such as `max_turns`. */
  readonly stopReason: string | null;
  /** The run's typed answer once read (`run.output.structured`), which the result charts draw. */
  readonly structured: unknown;
}

export function beginTurn(runId: string, prompt: string): Turn {
  return {
    runId,
    prompt,
    status: 'queued',
    tools: [],
    answers: [],
    pendingApproval: null,
    stopReason: null,
    structured: null,
  };
}

/** The same turn, now following the continuation run an approval decision started. */
export function continueTurn(turn: Turn, runId: string): Turn {
  return { ...turn, runId, status: 'running', pendingApproval: null, stopReason: null };
}

/** `turn` after `frame`; a frame this view does not draw, or a malformed one, changes nothing. */
export function applyFrame(turn: Turn, frame: RunEventFrame): Turn {
  if (frame.kind === 'run-status') {
    return { ...turn, status: frame.data.status };
  }
  if (frame.kind !== 'runtime') return turn;
  // The same check the SDK makes: the payload must be a valid agent frame of the name it came as.
  const parsed = AgentFrameSchema.safeParse(frame.data);
  if (!parsed.success || parsed.data.frame !== frame.name) return turn;
  const event = parsed.data;
  switch (event.frame) {
    case 'agent.tool.call':
      return {
        ...turn,
        tools: [
          ...turn.tools,
          {
            id: event.toolCallId,
            name: event.name,
            input: event.input,
            output: null,
            isError: false,
          },
        ],
      };
    case 'agent.tool.result':
      return {
        ...turn,
        tools: turn.tools.map((step) =>
          step.id === event.toolCallId
            ? { ...step, output: event.output, isError: event.isError || event.status === 'failed' }
            : step,
        ),
      };
    case 'agent.approval.requested':
      return {
        ...turn,
        pendingApproval: { toolName: event.toolName, canonicalCall: event.canonicalCall },
      };
    case 'agent.result':
      return { ...turn, stopReason: event.stopReason };
    case 'agent.message': {
      // Only an assistant message with an id and some text is an answer; reasoning stays out.
      if (event.role !== 'assistant' || event.messageId === null) return turn;
      const id = event.messageId;
      const text = event.blocks
        .flatMap((block) => (block.type === 'text' && block.text.trim() !== '' ? [block.text] : []))
        .join('\n\n');
      if (text === '') return turn;
      const known = turn.answers.some((answer) => answer.id === id);
      return {
        ...turn,
        answers: known
          ? turn.answers.map((answer) => (answer.id === id ? { id, text } : answer))
          : [...turn.answers, { id, text }],
      };
    }
    default:
      return turn;
  }
}
