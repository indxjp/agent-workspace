import type { EvaluationResource } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it } from 'vitest';

import { UsageError } from '../io.js';
import { diffAgainst, diffLines, junit, parseMinScore, scoreOf } from './eval-report.js';

/** Issue #799: the pure parts of `aw eval run --min-score --junit --baseline`. */

const RUN = '66666666-6666-4666-8666-666666666666';

function evaluation(
  id: string,
  results: readonly (readonly [name: string, failures: readonly string[]])[],
): EvaluationResource {
  const passed = results.filter(([, failures]) => failures.length === 0).length;
  return {
    id,
    agentId: '33333333-3333-4333-8333-333333333333',
    version: 7,
    score: passed / results.length,
    passed,
    total: results.length,
    results: results.map(([name, failures]) => ({
      name,
      passed: failures.length === 0,
      runId: RUN,
      failures,
    })),
    createdAt: '2026-10-07T00:00:00.000Z',
  };
}

describe('parseMinScore', () => {
  it.each([
    ['0', 0],
    ['0.8', 0.8],
    [' 1 ', 1],
  ])('takes %s', (raw, expected) => {
    expect(parseMinScore(raw)).toBe(expected);
  });

  it.each(['', ' ', 'abc', '-0.1', '1.01', 'NaN', 'Infinity', '80%'])('refuses %j', (raw) => {
    expect(() => parseMinScore(raw)).toThrow(UsageError);
  });
});

describe('scoreOf', () => {
  it('is passed over total, not the rounded stored score', () => {
    expect(
      scoreOf({
        ...evaluation('a', [
          ['x', []],
          ['y', []],
          ['z', ['no']],
        ]),
        score: 0.6667,
      }),
    ).toBe(2 / 3);
  });
});

describe('diffAgainst', () => {
  const baseline = evaluation('11111111-1111-4111-8111-111111111111', [
    ['stays', []],
    ['regresses', []],
    ['gets fixed', ['contains: "x"']],
    ['stays failing', ['no']],
    ['goes away', []],
  ]);
  const current = evaluation('22222222-2222-4222-8222-222222222222', [
    ['stays', []],
    ['regresses', ['notContains: "refund"']],
    ['gets fixed', []],
    ['stays failing', ['no']],
    ['is new', []],
  ]);

  it('names the regressed, fixed, added and removed cases', () => {
    expect(diffAgainst(baseline, current)).toEqual({
      baseline: baseline.id,
      baselineVersion: 7,
      baselinePassed: 3,
      baselineTotal: 5,
      regressed: ['regresses'],
      fixed: ['gets fixed'],
      added: ['is new'],
      removed: ['goes away'],
    });
  });

  it('prints a line per change, or says nothing changed', () => {
    expect(diffLines(diffAgainst(baseline, current), current)).toEqual([
      `baseline ${baseline.id} · v7 · 3/5 passed → 3/5`,
      '  regressed  regresses',
      '  fixed      gets fixed',
      '  added      is new',
      '  removed    goes away',
      '',
    ]);
    expect(diffLines(diffAgainst(baseline, baseline), baseline)[1]).toBe('  no case changed');
  });
});

describe('junit', () => {
  it('writes a suite per agent and a failure per failed case, with XML escaped', () => {
    const tricky = evaluation('33333333-3333-4333-8333-333333333333', [
      ['plain', []],
      ['a <b> & "c" \'d\'', ['contains: "<ok>" & more', 'tool: x was not called']],
    ]);
    expect(junit([{ name: 'Support & Sales', evaluation: tricky }])).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuites name="aw eval" tests="2" failures="1">',
        '  <testsuite name="Support &amp; Sales" tests="2" failures="1" timestamp="2026-10-07T00:00:00.000Z">',
        '    <testcase classname="Support &amp; Sales" name="plain"/>',
        '    <testcase classname="Support &amp; Sales" name="a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;">',
        '      <failure message="contains: &quot;&lt;ok&gt;&quot; &amp; more; tool: x was not called">contains: &quot;&lt;ok&gt;&quot; &amp; more',
        'tool: x was not called</failure>',
        '    </testcase>',
        '  </testsuite>',
        '</testsuites>',
        '',
      ].join('\n'),
    );
  });

  it('drops control characters XML cannot carry and totals every suite', () => {
    const one = evaluation('44444444-4444-4444-8444-444444444444', [['a\u0001b', ['x\u0000y']]]);
    const xml = junit([
      { name: 'One', evaluation: one },
      { name: 'Two', evaluation: one },
    ]);
    expect(xml).toContain('<testsuites name="aw eval" tests="2" failures="2">');
    expect(xml).toContain('name="ab"');
    expect(xml).toContain('<failure message="xy">xy</failure>');
  });
});
