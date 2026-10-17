/**
 * The `release` vectors (issue #614): step sequences over the one release model in
 * `formal/AgentWorkspace/Concepts/Release.lean`, and the state after each step.
 *
 * 80-07, 80-08 and 80-12 add the replay against the pure functions they export
 * (`resolveSessionVersion`, `decideRollback`, `decidePromote`); `docs/formal/domains/release.md`
 * lists the rows each adds. 80-08's rows replay in `apps/web/formal/release.test.ts`. This suite
 * checks the vectors themselves, and pins the scenario set so no scenario is dropped silently. A disagreement with the model is a failing test,
 * and the fix is never to edit a vector (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { describe, expect, it } from 'vitest';

import { asRecord, loadVectors } from './vectors.js';

const FAMILY = 'release';
const vectors = loadVectors(FAMILY, 'steps.json');

function stepsOf(expected: unknown, id: string): readonly Record<string, unknown>[] {
  const steps = asRecord(expected, id)['steps'];
  if (!Array.isArray(steps)) throw new Error(`${id}: steps must be an array`);
  return steps.map((step: unknown, index) => asRecord(step, `${id}.steps[${String(index)}]`));
}

const SCENARIOS = [
  'promote-without-a-bar-needs-no-evaluation',
  'promote-passes-the-gate',
  'promote-without-a-score-is-not-evaluated',
  'promote-below-the-bar-fails-the-gate',
  'point-production-passes-the-gate-too',
  'point-at-a-missing-version-is-refused',
  'promote-then-rollback-is-identity',
  'rollback-twice-steps-back-twice',
  'rollback-needs-a-previous-version',
  'a-conversation-keeps-its-version',
];

describe('release: the vectors', () => {
  it('emits exactly the scenarios the replay rows in docs/formal/domains/release.md name', () => {
    expect(vectors.map(({ id }) => id)).toStrictEqual(SCENARIOS);
  });

  it.each(vectors)('$id: a refused step leaves the state as it was', ({ id, input, expected }) => {
    const ops = asRecord(input, id)['ops'];
    const steps = stepsOf(expected, id);
    expect(Array.isArray(ops) ? ops.length : -1).toBe(steps.length);
    steps.forEach((step, index) => {
      if (step['problem'] !== null && index > 0) {
        expect(step['state']).toStrictEqual(steps[index - 1]?.['state']);
      }
    });
  });

  it.each(vectors)('$id: every pointer names a saved version', ({ id, expected }) => {
    for (const step of stepsOf(expected, id)) {
      const state = asRecord(step['state'], id);
      const versions = state['versions'];
      for (const pointer of Object.values(asRecord(state['pointer'], id))) {
        if (pointer !== null) {
          expect(pointer).toBeGreaterThanOrEqual(1);
          expect(pointer).toBeLessThanOrEqual(Number(versions));
        }
      }
    }
  });

  it('covers both refusal codes 80-12 (#619) returns, and an unset bar', () => {
    const problems = vectors.flatMap(({ id, expected }) =>
      stepsOf(expected, id).map((step) => step['problem']),
    );
    expect(problems).toContain('promotion_not_evaluated');
    expect(problems).toContain('promotion_gate_failed');
    expect(vectors.some(({ id, input }) => asRecord(input, id)['bar'] === null)).toBe(true);
  });

  it('cites a Release theorem from every vector', () => {
    for (const { witnesses } of vectors) {
      expect(witnesses.some((w) => w.includes('.Release.'))).toBe(true);
    }
  });
});
