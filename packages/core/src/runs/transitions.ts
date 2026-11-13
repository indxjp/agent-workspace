/**
 * Which run status may follow which: the one written rule both run stores read (refactoring
 * plan part 09, step 1; RF-301 step 1).
 *
 * The PostgreSQL repository uses it as the `where status in (…)` of every conditional update, so
 * a lost race is a no-op and not an overwrite; the test-only in-memory store asks the same
 * question before it moves a run. Pure and free of imports with a run-time cost, so the web app
 * can load it through `@agent-workspace/core/run-transitions` without reaching the database layer.
 */
import type { RunStatus } from '@indx-workspace/contracts/runs';

/**
 * The statuses a run may move to `to` from.
 *
 * A paused run (`awaiting_approval`) never goes back to `running`: the continuation is a new run in
 * the same session (ADR-0145 D1). `failed` is not reachable from it either — a decision resolves a
 * pause to `completed` or `cancelled`.
 */
export function runStatusesThatMayMoveTo(to: RunStatus): readonly RunStatus[] {
  switch (to) {
    case 'running':
      return ['queued'];
    case 'awaiting_approval':
      return ['running'];
    case 'completed':
    case 'cancelled':
      return ['queued', 'running', 'awaiting_approval'];
    case 'failed':
      return ['queued', 'running'];
    case 'queued':
      return [];
    default: {
      const unreachable: never = to;
      throw new Error(`unhandled run status ${String(unreachable)}`);
    }
  }
}

/** Whether a run at `from` may move to `to`. */
export function runMayMove(from: RunStatus, to: RunStatus): boolean {
  return runStatusesThatMayMoveTo(to).includes(from);
}
