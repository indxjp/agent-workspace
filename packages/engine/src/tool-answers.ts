/**
 * The tool answers one run received, so `run_skill_script` can hand one to a script by reference
 * (ADR-0176).
 *
 * Every adapter maps its engine's events to the neutral `agent.tool.call` and `agent.tool.result`
 * frames, and every frame passes through `createEngineAdapter`'s loop. The kit records each answer
 * there, so the three adapters share one source and none parses its engine's events twice. What is
 * recorded is the frame's `output`: the text the model received, not a value anyone restated.
 *
 * An answer reaches this record when the run's consumer reads its frame. The engine has already
 * received it — the model can only name a call whose answer it has seen — but the frame may still
 * be queued behind the consumer when the script's call arrives. {@link ToolAnswers.find} therefore
 * waits, at most {@link TOOL_ANSWERS_LIMITS}.waitMs, for an id it has not seen yet.
 */
import type { EngineFrame } from './frames.js';

/** One answer, as the model received it. */
export type ToolAnswer = {
  readonly toolCallId: string;
  /** The tool's name as the engine called it (`mcp__<server>__<tool>` on Claude). */
  readonly name: string;
  readonly output: string;
  readonly isError: boolean;
};

export const TOOL_ANSWERS_LIMITS = {
  /** How long {@link ToolAnswers.find} waits for an id the record has not seen yet. */
  waitMs: 5_000,
  /** The most answer text one run keeps; the oldest answers are dropped past it. */
  maxRetainedBytes: 24 * 1024 * 1024,
} as const;

export type ToolAnswersLimits = { readonly waitMs: number; readonly maxRetainedBytes: number };

/** A run's record of the answers it received. */
export type ToolAnswers = {
  /** Record an `agent.tool.call` (its name) or an `agent.tool.result` (its answer); ignore the rest. */
  observe(frame: EngineFrame): void;
  /**
   * The answer to `toolCallId`, waiting for it up to the limit, or `null` when the run has not
   * received one (or dropped it under the byte limit). An aborted `signal` ends the wait with `null`.
   */
  find(toolCallId: string, signal?: AbortSignal): Promise<ToolAnswer | null>;
  /** The calls whose answers the record holds, oldest first, to name in a refusal. */
  held(): readonly { readonly toolCallId: string; readonly name: string }[];
};

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function createToolAnswers(limits: ToolAnswersLimits = TOOL_ANSWERS_LIMITS): ToolAnswers {
  const names = new Map<string, string>();
  const answers = new Map<string, { readonly answer: ToolAnswer; readonly bytes: number }>();
  const waiting = new Map<string, Set<() => void>>();
  let retained = 0;

  function keep(answer: ToolAnswer): void {
    const bytes = byteLength(answer.output);
    const previous = answers.get(answer.toolCallId);
    if (previous !== undefined) {
      retained -= previous.bytes;
      answers.delete(answer.toolCallId);
    }
    answers.set(answer.toolCallId, { answer, bytes });
    retained += bytes;
    for (const [id, oldest] of answers) {
      if (retained <= limits.maxRetainedBytes) break;
      answers.delete(id);
      retained -= oldest.bytes;
    }
    for (const wake of waiting.get(answer.toolCallId) ?? []) wake();
  }

  return {
    observe(frame) {
      if (frame.frame === 'agent.tool.call') {
        names.set(frame.toolCallId, frame.name);
        return;
      }
      if (frame.frame !== 'agent.tool.result') return;
      keep({
        toolCallId: frame.toolCallId,
        name: names.get(frame.toolCallId) ?? '',
        output: frame.output,
        isError: frame.isError || frame.status === 'failed',
      });
    },

    async find(toolCallId, signal) {
      const known = answers.get(toolCallId)?.answer;
      if (known !== undefined || signal?.aborted === true) return known ?? null;
      await new Promise<void>((resolve) => {
        const wakers = waiting.get(toolCallId) ?? new Set<() => void>();
        waiting.set(toolCallId, wakers);
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          wakers.delete(done);
          if (wakers.size === 0) waiting.delete(toolCallId);
          resolve();
        };
        const timer = setTimeout(done, limits.waitMs);
        wakers.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
      return answers.get(toolCallId)?.answer ?? null;
    },

    held() {
      return [...answers.values()].map(({ answer }) => ({
        toolCallId: answer.toolCallId,
        name: answer.name,
      }));
    },
  };
}
