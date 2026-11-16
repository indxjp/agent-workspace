/**
 * The one way a run's event frames become a {@link RecordedTurn} (P5): the recordings generator
 * (`tests/store/recordings.test.ts`) uses it on runs against the scripted model, and the real-model
 * harness (`tests/store/live-verify/`) on runs against real Claude, so both are judged by
 * `judgeMoment` on the same shape. It lives with the tests, not in the store app: the app only reads
 * the recorded result.
 *
 * Each frame payload is parsed with the contract's `AgentFrameSchema`, as the SDK and the Try tab
 * parse it; a malformed or unknown frame changes nothing.
 */
import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

import type { RecordedStep, RecordedTurn } from '../../../examples/store/catalog/recording.ts';

/** One run of the turn, in order: the question's, then each approval continuation's. */
export interface RecordedRun {
  readonly frames: readonly RunEventFrame[];
  /** What the person decided on the call this run stopped at for approval, if it did. */
  readonly decision?: 'approved' | 'rejected';
}

/** The turn `runs` make for `prompt`. */
export function recordTurn(prompt: string, runs: readonly RecordedRun[]): RecordedTurn {
  const steps: RecordedStep[] = [];
  let stopReason: string | null = null;
  for (const run of runs) {
    // Tool steps of this run by the engine's call id, so a result fills its own call.
    const calls = new Map<string, number>();
    // An answer the engine repeats under the same id replaces its earlier text.
    const answers = new Map<string, number>();
    for (const frame of run.frames) {
      if (frame.kind !== 'runtime') continue;
      const parsed = AgentFrameSchema.safeParse(frame.data);
      if (!parsed.success || parsed.data.frame !== frame.name) continue;
      const event = parsed.data;
      switch (event.frame) {
        case 'agent.tool.call':
          calls.set(event.toolCallId, steps.length);
          steps.push({
            kind: 'tool',
            name: event.name,
            input: event.input,
            output: null,
            isError: false,
          });
          break;
        case 'agent.tool.result': {
          const at = calls.get(event.toolCallId);
          const step = at === undefined ? undefined : steps[at];
          if (at !== undefined && step?.kind === 'tool') {
            steps[at] = {
              ...step,
              output: event.output,
              isError: event.isError || event.status === 'failed',
            };
          }
          break;
        }
        case 'agent.approval.requested':
          steps.push({
            kind: 'approval',
            toolName: event.toolName,
            decision: run.decision ?? null,
          });
          break;
        case 'agent.message': {
          if (event.role !== 'assistant') break;
          const text = event.blocks
            .flatMap((block) =>
              block.type === 'text' && block.text.trim() !== '' ? [block.text] : [],
            )
            .join('\n\n');
          if (text === '') break;
          const known = event.messageId === null ? undefined : answers.get(event.messageId);
          if (known === undefined) {
            if (event.messageId !== null) answers.set(event.messageId, steps.length);
            steps.push({ kind: 'answer', text });
          } else {
            steps[known] = { kind: 'answer', text };
          }
          break;
        }
        case 'agent.result':
          stopReason = event.stopReason;
          break;
        default:
          break;
      }
    }
  }
  return { prompt, steps, stopReason };
}
