// scripts/ci/check-osv-baseline.mjs (audit F-03): new findings and stale baseline entries fail.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compare, verdict } from '../../scripts/ci/check-osv-baseline.mjs';

const report = (...ids: string[]) => ({
  results: [
    {
      packages: ids.map((id) => ({
        package: { name: 'pkg', version: '1.0.0' },
        vulnerabilities: [{ id }],
      })),
    },
  ],
});

describe('osv baseline', () => {
  it('passes when findings equal the baseline', () => {
    expect(compare(report('A'), { findings: ['pkg@1.0.0 A'] })).toEqual({ added: [], stale: [] });
  });

  it('fails on a new finding', () => {
    expect(compare(report('A', 'B'), { findings: ['pkg@1.0.0 A'] }).added).toEqual(['pkg@1.0.0 B']);
  });

  it('fails on a stale entry so the baseline only shrinks', () => {
    expect(compare(report(), { findings: ['pkg@1.0.0 A'] }).stale).toEqual(['pkg@1.0.0 A']);
  });

  it('warns and exits 0 for a PR that does not touch the lockfile', () => {
    const result = compare(report('B'), { findings: ['pkg@1.0.0 A'] });
    const { lines, code } = verdict(result, '.osv-baseline.json', true);
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('::warning'))).toBe(true);
  });

  it('errors and exits 1 in strict mode', () => {
    const result = compare(report('B'), { findings: [] });
    const { lines, code } = verdict(result, '.osv-baseline.json', false);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^::error/u);
  });

  it('the committed baseline is well formed', () => {
    const baseline = JSON.parse(readFileSync('.osv-baseline.json', 'utf8')) as {
      findings: string[];
    };
    expect(baseline.findings.every((f) => /^\S+@\S+ \S+$/u.test(f))).toBe(true);
  });
});
