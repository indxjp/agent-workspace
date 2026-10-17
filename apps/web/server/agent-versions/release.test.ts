import { describe, expect, it } from 'vitest';

import { decidePromote, decideRollback, rollbackHistory, type LatestEvaluation } from './release';

/** Issue #615: the pure release decisions. `apps/web/formal/release.test.ts` replays the model too. */
describe('decidePromote', () => {
  const exists = (number: number): boolean => number >= 1 && number <= 3;
  const ungated = { bar: null, evaluationOf: (): null => null };

  it("promotes the source environment's version by default", () => {
    expect(decidePromote({ requested: undefined, source: 2, exists, ...ungated })).toEqual({
      to: 2,
    });
  });

  it('refuses no_pointer when the source points at nothing', () => {
    expect(decidePromote({ requested: undefined, source: null, exists, ...ungated })).toEqual({
      problem: 'no_pointer',
    });
  });

  it('promotes an explicit version, even with no source pointer', () => {
    expect(decidePromote({ requested: 3, source: null, exists, ...ungated })).toEqual({ to: 3 });
  });

  it('refuses agent_version_not_found for a version the agent does not have', () => {
    expect(decidePromote({ requested: 4, source: 2, exists, ...ungated })).toEqual({
      problem: 'agent_version_not_found',
    });
  });
});

describe('decidePromote: the promotion gate (issue #619)', () => {
  const exists = (number: number): boolean => number >= 1 && number <= 3;
  const scored = (passed: number, total: number, failing: string[] = []): LatestEvaluation => ({
    score: Math.round((passed / total) * 10_000) / 10_000,
    passed,
    total,
    failing,
  });
  const promote = (
    bar: number | null,
    evaluations: Readonly<Record<number, LatestEvaluation>>,
    requested?: number,
  ) =>
    decidePromote({
      requested,
      source: 2,
      exists,
      bar,
      evaluationOf: (number) => evaluations[number] ?? null,
    });

  it('needs no evaluation with no bar', () => {
    expect(promote(null, {})).toEqual({ to: 2 });
  });

  it('refuses promotion_not_evaluated with a bar and no evaluation, even a bar of 0', () => {
    expect(promote(0.9, {})).toEqual({ problem: 'promotion_not_evaluated', version: 2, bar: 0.9 });
    expect(promote(0, {})).toEqual({ problem: 'promotion_not_evaluated', version: 2, bar: 0 });
  });

  it('passes at the bar and refuses just below it with the failing cases', () => {
    expect(promote(0.9, { 2: scored(9, 10, ['tone']) })).toEqual({ to: 2 });
    expect(promote(0.9, { 2: scored(8999, 10_000, ['tone', 'refunds']) })).toEqual({
      problem: 'promotion_gate_failed',
      version: 2,
      bar: 0.9,
      score: 0.8999,
      failing: ['tone', 'refunds'],
    });
  });

  it('gates the unrounded share: 19999 of 20000 does not reach a bar of 1', () => {
    const almost = scored(19_999, 20_000, ['one']);
    expect(almost.score).toBe(1);
    expect(promote(1, { 2: almost })).toMatchObject({ problem: 'promotion_gate_failed', bar: 1 });
    expect(promote(1, { 2: scored(20_000, 20_000) })).toEqual({ to: 2 });
  });

  it("gates the target's own evaluation: version 1's does not unlock version 3", () => {
    expect(promote(0.5, { 1: scored(1, 1) }, 3)).toMatchObject({
      problem: 'promotion_not_evaluated',
      version: 3,
    });
  });

  it('answers no_pointer and agent_version_not_found before the gate', () => {
    expect(
      decidePromote({
        requested: undefined,
        source: null,
        exists,
        bar: 1,
        evaluationOf: () => null,
      }),
    ).toEqual({ problem: 'no_pointer' });
    expect(promote(1, {}, 4)).toEqual({ problem: 'agent_version_not_found' });
  });
});

describe('decideRollback', () => {
  it.each([[[]], [[7]]])('refuses nothing_to_roll_back for the history %j', (history) => {
    expect(decideRollback(history)).toEqual({ problem: 'nothing_to_roll_back' });
  });

  it('moves from the head to the second entry', () => {
    expect(decideRollback([7, 6])).toEqual({ from: 7, to: 6 });
  });
});

describe('rollbackHistory (BH061-004)', () => {
  const move = (number: number, reason: 'set' | 'promote' | 'rollback') => ({ number, reason });

  it('keeps every set and promote, newest first', () => {
    expect(rollbackHistory([move(13, 'promote'), move(12, 'promote'), move(11, 'set')])).toEqual([
      13, 12, 11,
    ]);
  });

  it('takes the version a rollback left off, so a second rollback steps back again', () => {
    const moves = [move(12, 'rollback'), move(13, 'promote'), move(12, 'promote'), move(11, 'set')];
    expect(rollbackHistory(moves)).toEqual([12, 11]);
    expect(decideRollback(rollbackHistory(moves))).toEqual({ from: 12, to: 11 });
    const twice = [move(11, 'rollback'), ...moves];
    expect(decideRollback(rollbackHistory(twice))).toEqual({ problem: 'nothing_to_roll_back' });
  });

  it('keeps a rollback recorded when rolling back alternated as the pointer', () => {
    const moves = [
      move(13, 'rollback'),
      move(12, 'rollback'),
      move(13, 'promote'),
      move(12, 'set'),
    ];
    expect(rollbackHistory(moves)).toEqual([13]);
    const longer = [...moves, move(11, 'set')];
    expect(decideRollback(rollbackHistory(longer))).toEqual({ from: 13, to: 11 });
  });
});
