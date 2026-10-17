/**
 * The release decisions of issue #615 (80-08): which version a promote or a rollback moves a
 * pointer to, or the typed problem that refuses it. Pure, so `apps/web/formal/release.test.ts` replays
 * the release model's vectors (`formal/AgentWorkspace/Concepts/Release.lean`) against them; the
 * handlers in `./pointers.ts` do the reads and the move.
 *
 * {@link decidePromote} passes the promotion gate (issue #619) after it picks the target, as the
 * model's `gate` does. A rollback is never gated: it returns to a version production already ran.
 */

/** A version's newest evaluation, as the promotion gate reads it (issue #619). */
export interface LatestEvaluation {
  /** `passed / total` rounded to four places: what the evaluation reported, not what is gated. */
  readonly score: number;
  readonly passed: number;
  /** At least 1: the table refuses an evaluation with no cases. */
  readonly total: number;
  /** The names of the cases that did not pass, in case order. */
  readonly failing: readonly string[];
}

/** A promote's target, or why there is none. */
export type PromoteDecision =
  | { readonly to: number }
  | { readonly problem: 'no_pointer' | 'agent_version_not_found' }
  | { readonly problem: 'promotion_not_evaluated'; readonly version: number; readonly bar: number }
  | {
      readonly problem: 'promotion_gate_failed';
      readonly version: number;
      readonly bar: number;
      readonly score: number;
      readonly failing: readonly string[];
    };

/**
 * Promote to `requested` when given (the model's `point`), else to the source environment's
 * pointer (the model's `promote`): `no_pointer` when it has none, `agent_version_not_found` for a
 * version the agent does not have. Then the gate: with a `bar`, the target's newest evaluation
 * must exist (`promotion_not_evaluated`) and pass at least `bar` of its cases
 * (`promotion_gate_failed`). With no bar, no evaluation is needed.
 */
export function decidePromote(input: {
  readonly requested: number | undefined;
  readonly source: number | null;
  readonly exists: (number: number) => boolean;
  readonly bar: number | null;
  readonly evaluationOf: (number: number) => LatestEvaluation | null;
}): PromoteDecision {
  if (input.requested !== undefined && !input.exists(input.requested)) {
    return { problem: 'agent_version_not_found' };
  }
  const to = input.requested ?? input.source;
  if (to === null) return { problem: 'no_pointer' };
  const { bar } = input;
  if (bar === null) return { to };
  const evaluation = input.evaluationOf(to);
  if (evaluation === null) return { problem: 'promotion_not_evaluated', version: to, bar };
  // The unrounded share: the stored score rounds 19999 of 20000 up to 1.0000.
  if (evaluation.passed / evaluation.total >= bar) return { to };
  return {
    problem: 'promotion_gate_failed',
    version: to,
    bar,
    score: evaluation.score,
    failing: evaluation.failing,
  };
}

/** A rollback's move, or why there is none. */
export type RollbackDecision =
  { readonly from: number; readonly to: number } | { readonly problem: 'nothing_to_roll_back' };

/**
 * Roll an environment back to the second entry of its history (newest first), whose head is the
 * pointer. `history` is the stack {@link rollbackHistory} replays, so rolling back twice steps two
 * versions back rather than forward again (BH061-004).
 */
export function decideRollback(history: readonly number[]): RollbackDecision {
  const [from, to] = history;
  return from === undefined || to === undefined
    ? { problem: 'nothing_to_roll_back' }
    : { from, to };
}

/**
 * The model's history (newest first) replayed from an environment's recorded pointer moves (newest
 * first): a `set` or a `promote` goes on top, and a `rollback` takes the version it left off, as
 * the model's `dropPointer` does. The audit table keeps every move; this is the stack a rollback
 * can still step back through. A rollback whose recorded version is not then on top (one recorded
 * before BH061-004, when a rollback pushed the earlier version) puts that version on top, so the
 * head is always the pointer.
 */
export function rollbackHistory(
  moves: readonly { readonly number: number; readonly reason: string }[],
): number[] {
  const stack: number[] = [];
  for (const { number, reason } of moves.toReversed()) {
    if (reason === 'rollback') {
      stack.pop();
      if (stack.at(-1) === number) continue;
    }
    stack.push(number);
  }
  return stack.toReversed();
}
