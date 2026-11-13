import { RUN_STATUSES, type RunStatus } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { runMayMove, runStatusesThatMayMoveTo } from './transitions.js';

/** Every allowed move, written out by hand: `from → to`. */
const ALLOWED = new Set([
  'queued → running',
  'running → awaiting_approval',
  'queued → completed',
  'running → completed',
  'awaiting_approval → completed',
  'queued → cancelled',
  'running → cancelled',
  'awaiting_approval → cancelled',
  'queued → failed',
  'running → failed',
]);

describe('the run transition rule', () => {
  for (const from of RUN_STATUSES) {
    for (const to of RUN_STATUSES) {
      const allowed = ALLOWED.has(`${from} → ${to}`);
      it(`${allowed ? 'allows' : 'refuses'} ${from} → ${to}`, () => {
        expect(runMayMove(from, to)).toBe(allowed);
        expect(runStatusesThatMayMoveTo(to).includes(from)).toBe(allowed);
      });
    }
  }

  it('lets no run leave a terminal status or come back to queued', () => {
    const terminal: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];
    for (const to of RUN_STATUSES) {
      for (const from of terminal) expect(runMayMove(from, to)).toBe(false);
      expect(runMayMove(to, 'queued')).toBe(false);
    }
  });

  it('is the rule the PostgreSQL repository reads', async () => {
    const rows = await import('../db/repositories/runs/rows.js');
    expect(rows.runStatusesThatMayMoveTo).toBe(runStatusesThatMayMoveTo);
  });
});
