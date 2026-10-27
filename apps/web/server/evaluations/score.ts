/**
 * Scoring an evaluation case (issue #618): pure functions over a run's agent frames, with no clock,
 * no store and no model. The `judge` check needs a model call and lives in `./handlers.ts`.
 */
import type { EvalExpect } from '@indx-workspace/contracts/evaluations';
import type { AgentFrame } from '@indx-workspace/contracts/run-events';
import { z } from 'zod';

/**
 * The run's answer: the text of its last assistant message. An engine re-sends a growing turn under
 * the same message id, so the last frame is the whole of that turn. `''` when it said nothing.
 */
export function finalAnswer(frames: readonly AgentFrame[]): string {
  const last = frames.findLast(
    (frame) => frame.frame === 'agent.message' && frame.role === 'assistant',
  );
  if (last?.frame !== 'agent.message') return '';
  return last.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** Every tool the run called, in call order, with the arguments it called it with. */
export function toolCalls(frames: readonly AgentFrame[]): readonly ToolCall[] {
  return frames.flatMap((frame) =>
    frame.frame === 'agent.tool.call' ? [{ name: frame.name, input: frame.input }] : [],
  );
}

const CanonicalCallSchema = z.object({ input: z.unknown() });

/**
 * The call a run paused on (ADR-0145), as a tool call: its name, and its input read back from the
 * canonical call text (`{"input":…,"name":…}`). The run row is persisted JSON, so a text that does
 * not parse still yields the name, with no input. `[]` when the run waits on nothing.
 */
export function pausedCall(
  pending: { readonly toolName: string; readonly canonicalCall: string } | null | undefined,
): readonly ToolCall[] {
  if (pending === null || pending === undefined) return [];
  let input: unknown;
  try {
    const parsed = CanonicalCallSchema.safeParse(JSON.parse(pending.canonicalCall));
    if (parsed.success) input = parsed.data.input;
  } catch {
    // Not JSON: the name alone still lets `tool` match.
  }
  return [{ name: pending.toolName, input }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `actual` contains `expected`: objects match key by key (extra keys in `actual` are
 * ignored), everything else, arrays included, must be equal.
 */
function containsValue(actual: unknown, expected: unknown): boolean {
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) => containsValue(actual[key], value))
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => containsValue(actual[index], value))
    );
  }
  return actual === expected;
}

/**
 * Why the answer fails `contains`, `notContains`, `tool`, `toolInput` and `output`; empty when it
 * passes all that are set. Substrings are case-sensitive and `tool` is one exact name. With
 * `toolInput`, one call of that tool must have arguments that contain it; `output` must be contained
 * in `structured`, the run's structured output (`null` when it has none). `judge` is not checked here.
 */
export function checkCase(
  expect: EvalExpect,
  answer: string,
  calls: readonly ToolCall[],
  structured: unknown,
): readonly string[] {
  const named = expect.tool === undefined ? [] : calls.filter((call) => call.name === expect.tool);
  const toolFailure = (): readonly string[] => {
    if (expect.tool === undefined) return [];
    if (named.length === 0) return [`tool: ${expect.tool} was not called`];
    if (
      expect.toolInput !== undefined &&
      !named.some((call) => containsValue(call.input, expect.toolInput))
    ) {
      return [`toolInput: no call of ${expect.tool} had ${JSON.stringify(expect.toolInput)}`];
    }
    return [];
  };
  return [
    ...(expect.contains ?? [])
      .filter((needle) => !answer.includes(needle))
      .map((needle) => `contains: ${JSON.stringify(needle)} is not in the answer`),
    ...(expect.notContains ?? [])
      .filter((needle) => answer.includes(needle))
      .map((needle) => `notContains: ${JSON.stringify(needle)} is in the answer`),
    ...toolFailure(),
    ...(expect.output === undefined || containsValue(structured, expect.output)
      ? []
      : [`output: the structured output did not have ${JSON.stringify(expect.output)}`]),
  ];
}

/**
 * `passed / total` over the case results, rounded to 4 decimals as the row stores it. `total` is at
 * least 1: a request has at least one case.
 */
export function score(results: readonly { readonly passed: boolean }[]): {
  readonly score: number;
  readonly passed: number;
  readonly total: number;
} {
  const passed = results.filter((result) => result.passed).length;
  const total = results.length;
  return {
    score: total === 0 ? 0 : Math.round((passed / total) * 10_000) / 10_000,
    passed,
    total,
  };
}
