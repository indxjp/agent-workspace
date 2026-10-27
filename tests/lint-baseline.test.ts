import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { verdict } from '../scripts/check-complexity-ceiling.mjs';

/**
 * `eslint-suppressions.json` is the committed known-violation baseline (F-04, F-06, F-07, F-23).
 * ESLint refuses a new violation and a stale entry; the script refuses a regenerated, larger
 * baseline. Both halves are exercised here against real ESLint and the real script.
 */
const entry = (count: number) => ({ 'no-console': { count } });

function gate(base: object, head: object) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lint-baseline-'));
  writeFileSync(path.join(dir, 'base.json'), JSON.stringify(base));
  writeFileSync(path.join(dir, 'head.json'), JSON.stringify(head));
  return spawnSync(
    process.execPath,
    ['scripts/check-lint-baseline.mjs', path.join(dir, 'base.json'), path.join(dir, 'head.json')],
    { encoding: 'utf8' },
  );
}

describe('the baseline gate', () => {
  it('passes when counts are equal or lower, and when an entry disappears', () => {
    expect(gate({ 'a.ts': entry(3), 'b.ts': entry(1) }, { 'a.ts': entry(2) }).status).toBe(0);
  });

  it('fails when a count grows or a file is added', () => {
    const grown = gate({ 'a.ts': entry(1) }, { 'a.ts': entry(2) });
    expect(grown.status).toBe(1);
    expect(grown.stderr).toContain('a.ts  no-console  1 -> 2');
    expect(gate({}, { 'new.ts': entry(1) }).status).toBe(1);
  });
});

describe('the complexity ratchet', () => {
  it('holds only when the ceiling equals the measured maximum', () => {
    expect(verdict(32, 32)).toBeNull();
    expect(verdict(33, 32)).toContain('lower complexity.max in eslint.config.mjs to 32');
    expect(verdict(32, 33)).toContain('above the ceiling 32');
  });
});

describe('the ESLint rules', { timeout: 120_000 }, () => {
  const eslint = new ESLint({ suppressionsLocation: 'does-not-exist.json' });
  const lint = async (code: string, file: string) => {
    const [report] = await eslint.lintText(code, { filePath: path.resolve(file) });
    return (report?.messages ?? []).map((m) => m.ruleId);
  };

  it.each([
    [
      'console in web server code',
      'console.error("x");\n',
      'apps/web/server/errors.ts',
      'no-console',
    ],
    [
      'process.env outside a composition root',
      'export const v = process.env.HOME;\n',
      'apps/web/server/errors.ts',
      'no-restricted-properties',
    ],
    [
      'a discarded destroy failure',
      'export async function f(d: { destroy(): Promise<void> }) { await d.destroy().catch(() => undefined); }\n',
      'apps/runner/src/manager.ts',
      'no-restricted-syntax',
    ],
    [
      'an empty catch around a cleanup call',
      'export async function f(d: { close(): Promise<void> }) { try { await d.close(); } catch { /* ignored */ } }\n',
      'apps/runner/src/manager.ts',
      'no-restricted-syntax',
    ],
    [
      'a raw API fetch in a browser component',
      'export async function f() { return fetch("/api/agents"); }\n',
      'apps/web/components/agents/model.ts',
      'no-restricted-syntax',
    ],
    [
      'a production function above the complexity ceiling',
      `export function f(a: number) { ${'if (a === 1) a++; '.repeat(32)}return a; }
`,
      'apps/web/server/errors.ts',
      'complexity',
    ],
  ])('refuses %s', async (_name, code, file, rule) => {
    expect(await lint(code, file)).toContain(rule);
  });

  it('accepts process.env in a composition root and a reported cleanup', async () => {
    expect(
      await lint('export const v = process.env.HOME;\n', 'apps/web/server/composition/config.ts'),
    ).not.toContain('no-restricted-properties');
    expect(
      await lint(
        'export async function f(d: { destroy(): Promise<void> }) { await d.destroy().catch((e: unknown) => { throw e; }); }\n',
        'apps/runner/src/manager.ts',
      ),
    ).not.toContain('no-restricted-syntax');
  });
});
