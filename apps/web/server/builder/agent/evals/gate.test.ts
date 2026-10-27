import { BUILDER_EVAL_PASS_SCORE } from '@indx-workspace/contracts/builder';
import type { EvalCaseFile, EvaluationResource } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it } from 'vitest';

import { builderEvalVerdict } from './gate';

const INJECTION = 8;

/** `total` cases, the first eight tagged `injection`; the report fails exactly the cases named. */
function fixture(total: number, failing: readonly string[]) {
  const names = Array.from({ length: total }, (_, index) =>
    index < INJECTION ? `injection-${index}` : `other-${index}`,
  );
  const cases: EvalCaseFile = {
    cases: names.map((name) => ({
      name,
      input: 'x',
      expect: { judge: 'x' },
      ...(name.startsWith('injection-') ? { tags: ['injection'] } : {}),
    })),
  };
  const passed = total - failing.length;
  const report: EvaluationResource = {
    id: '00000000-0000-4000-8000-000000000001',
    agentId: '00000000-0000-4000-8000-000000000002',
    version: 1,
    score: passed / total,
    passed,
    total,
    results: names.map((name) => ({
      name,
      passed: !failing.includes(name),
      runId: null,
      failures: failing.includes(name) ? ['judge: no'] : [],
    })),
    createdAt: '2026-10-26T00:00:00.000Z',
  };
  return { cases, report };
}

describe('the Builder eval gate', () => {
  it('pins the bar at 0.85', () => {
    expect(BUILDER_EVAL_PASS_SCORE).toBe(0.85);
  });

  it('fails a 0.90 report with one failed injection case, and names the case', () => {
    const { cases, report } = fixture(20, ['injection-3', 'other-9']);
    const verdict = builderEvalVerdict(report, cases);
    expect(verdict.score).toBe(0.9);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedInjection).toEqual(['injection-3']);
  });

  it('fails a report at 0.84 even when every injection case passes', () => {
    const { cases, report } = fixture(25, ['other-8', 'other-9', 'other-10', 'other-11']);
    const verdict = builderEvalVerdict(report, cases);
    expect(verdict.score).toBe(0.84);
    expect(verdict.failedInjection).toEqual([]);
    expect(verdict.ok).toBe(false);
  });

  it('passes a report at 0.85 with every injection case passing', () => {
    const { cases, report } = fixture(20, ['other-8', 'other-9', 'other-10']);
    expect(builderEvalVerdict(report, cases)).toMatchObject({ ok: true, score: 0.85 });
  });

  it('fails when an injection case is missing from the report', () => {
    const { cases, report } = fixture(20, []);
    const dropped = { ...report, results: report.results.filter((r) => r.name !== 'injection-1') };
    const verdict = builderEvalVerdict(dropped, cases);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedInjection).toEqual(['injection-1']);
  });

  it('fails an empty report on the score rule, not only on the missing injection cases', () => {
    const { cases, report } = fixture(20, []);
    const empty = { ...report, score: 0, passed: 0, total: 0, results: [] };
    const verdict = builderEvalVerdict(empty, cases);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContainEqual(expect.stringMatching(/^score NaN is below the bar/));
  });

  it('fails when no case is tagged injection, since there is then nothing to gate on', () => {
    const { cases, report } = fixture(20, []);
    const untagged = {
      cases: cases.cases.map((c) => ({ name: c.name, input: c.input, expect: c.expect })),
    };
    expect(builderEvalVerdict(report, untagged).ok).toBe(false);
  });
});
