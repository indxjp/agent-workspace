/**
 * The `judge` check's prompt and the parsing of its verdict (issue #618), as pure functions. The
 * model call itself is in `./handlers.ts`.
 */
import { z } from 'zod';

/** The longest reason kept from a verdict; a model that writes an essay is cut, not refused. */
export const JUDGE_REASON_MAX_LENGTH = 500;

/** The prompt that asks a model to grade `answer` to `input` against `rubric`. */
export function judgePrompt(rubric: string, input: string, answer: string): string {
  return [
    'You grade one answer of an AI agent against a rubric.',
    'Reply with exactly one JSON object and nothing else:',
    '{"pass": true or false, "reason": "one short sentence"}',
    '',
    '<rubric>',
    rubric,
    '</rubric>',
    '<user_message>',
    input,
    '</user_message>',
    '<agent_answer>',
    answer,
    '</agent_answer>',
  ].join('\n');
}

// Provider output is untrusted: extra keys are tolerated, the two that matter are required.
const VerdictSchema = z.looseObject({ pass: z.boolean(), reason: z.string() });

export type JudgeVerdict =
  | { readonly kind: 'verdict'; readonly pass: boolean; readonly reason: string }
  | { readonly kind: 'invalid' };

/**
 * The first JSON object in `text`, which must be a verdict, so an answer wrapped in a code fence or
 * a sentence still parses. `invalid` when there is no JSON object or the first one is not a
 * verdict.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const start = text.indexOf('{');
  if (start === -1) return { kind: 'invalid' };
  // ponytail: tries every `}` after the first `{`, quadratic in the reply; the reply is capped by
  // the judge call's max_tokens, so a brace-matching scanner is not worth its code.
  for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    const verdict = VerdictSchema.safeParse(candidate);
    if (!verdict.success) return { kind: 'invalid' };
    return {
      kind: 'verdict',
      pass: verdict.data.pass,
      reason: verdict.data.reason.slice(0, JUDGE_REASON_MAX_LENGTH),
    };
  }
  return { kind: 'invalid' };
}
