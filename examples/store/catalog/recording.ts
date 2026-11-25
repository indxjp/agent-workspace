/**
 * A live entry's recording (spec, "How Try it works"): one turn of its suggested prompt, made by
 * running the entry's real agent against the platform's scripted model, never written by hand. The
 * Try tab replays it when a cap stops the live chat, and the home page shows the featured entry's.
 * `recordedWith` says honestly how it was made, and the page shows that label.
 *
 * The same shape is what the real-model harness (R1) builds from a real run, so one rule,
 * {@link judgeMoment}, decides for both whether the entry's moment happened.
 *
 * Imports nothing but `zod` and this folder's files, like the rest of the catalog.
 */
import { z } from 'zod';

import type { MomentCheck } from './define.ts';

/** How a recording was made. Only the scripted model today; a real-model recording needs R1. */
export const RECORDED_WITH = ['scripted-model'] as const;

const toolStep = z.strictObject({
  kind: z.literal('tool'),
  /** The name the run reported, such as `mcp__crm__contact_update`. */
  name: z.string().min(1),
  input: z.unknown(),
  /** The tool's answer; `null` when it never answered. */
  output: z.string().nullable(),
  isError: z.boolean(),
});

const approvalStep = z.strictObject({
  kind: z.literal('approval'),
  /** The tool whose call waited for a person, as the run reported it. */
  toolName: z.string().min(1),
  /** What the person decided; `null` when the turn ended still waiting. */
  decision: z.enum(['approved', 'rejected']).nullable(),
});

const answerStep = z.strictObject({ kind: z.literal('answer'), text: z.string().min(1) });

export const recordedStepSchema = z.discriminatedUnion('kind', [
  toolStep,
  approvalStep,
  answerStep,
]);
export type RecordedStep = z.infer<typeof recordedStepSchema>;

/** One question and everything its runs did, in order, across an approval's continuation. */
export const recordedTurnSchema = z.strictObject({
  prompt: z.string().trim().min(1),
  steps: z.array(recordedStepSchema).readonly(),
  /** The engine's stop reason of the last run, such as `end_turn` or `max_turns`. */
  stopReason: z.string().nullable(),
  /**
   * The last run's typed answer (`run.output.structured`, ADR-0143), present only when the run was
   * asked for the entry's `demo.outputSchema` and answered it; the replay charts it.
   */
  structured: z.record(z.string(), z.json()).readonly().optional(),
});
export type RecordedTurn = z.infer<typeof recordedTurnSchema>;

export const recordingSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  lang: z.enum(['ja', 'en']),
  recordedWith: z.enum(RECORDED_WITH),
  turn: recordedTurnSchema,
});
export type Recording = z.infer<typeof recordingSchema>;

/** `recordings`' entry for `slug` in `lang`, or `null` when it has none. */
export function recordingFor(
  recordings: readonly Recording[],
  slug: string,
  lang: 'ja' | 'en',
): Recording | null {
  return recordings.find((entry) => entry.slug === slug && entry.lang === lang) ?? null;
}

/** Whether a reported tool name is `name`: equal, or `name` after a `__` prefix. */
export function isTool(reported: string, name: string): boolean {
  return reported === name || reported.endsWith(`__${name}`);
}

export type MomentVerdict =
  { readonly pass: true } | { readonly pass: false; readonly reason: string };

/**
 * Whether `turn` shows the moment `check` states: every tool in `check.tools` was called and
 * answered without error, and, when `check.approval` names a tool, its call waited for a person,
 * was approved, and then ran and answered without error. The reason names the first thing missing.
 */
export function judgeMoment(turn: RecordedTurn, check: MomentCheck): MomentVerdict {
  const tools = turn.steps.filter((step) => step.kind === 'tool');
  for (const name of check.tools) {
    const answered = tools.some(
      (step) => isTool(step.name, name) && step.output !== null && !step.isError,
    );
    if (!answered) return { pass: false, reason: `${name} was not called and answered` };
  }
  if (check.approval === null) return { pass: true };
  const approval = check.approval;
  const at = turn.steps.findIndex(
    (step) => step.kind === 'approval' && isTool(step.toolName, approval),
  );
  if (at === -1) {
    // A write that ran unasked and answered (a gate that did not hold), one that was called but
    // refused or failed, and one never reached (an agent that stopped early) are told apart.
    const calls = tools.filter((step) => isTool(step.name, approval));
    const ran = calls.some((step) => step.output !== null && !step.isError);
    const how = ran
      ? 'it ran without one'
      : calls.length > 0
        ? 'it was called but refused or failed'
        : 'it was never called';
    return { pass: false, reason: `${approval} did not wait for approval: ${how}` };
  }
  const waited = turn.steps[at];
  if (waited?.kind !== 'approval' || waited.decision !== 'approved') {
    return { pass: false, reason: `${approval} was not approved` };
  }
  const ran = turn.steps
    .slice(at + 1)
    .some(
      (step) =>
        step.kind === 'tool' &&
        isTool(step.name, approval) &&
        step.output !== null &&
        !step.isError,
    );
  return ran ? { pass: true } : { pass: false, reason: `${approval} did not run after approval` };
}
