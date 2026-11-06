import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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

/**
 * AGENTS.md hexagonal rule 2: a domain core reads no clock, random value, environment or network.
 * `domain-core-is-pure` refuses the imports (tests/architecture-rules.test.ts); these are the
 * globals, planted into a real core file's path so the type-aware config applies as it does in CI.
 */
describe('the domain core globals ban', { timeout: 120_000 }, () => {
  const eslint = new ESLint({ suppressionsLocation: 'does-not-exist.json' });
  const CORE_FILE = 'apps/web/server/builder/core/facts.ts';
  const lint = async (code: string, file = CORE_FILE) => {
    const [report] = await eslint.lintText(code, { filePath: path.resolve(file) });
    return (report?.messages ?? []).map((m) => `${String(m.ruleId)}: ${m.message}`);
  };
  const configSchema = z.object({ rules: z.record(z.string(), z.unknown()).optional() });
  const appliesTo = async (file: string) =>
    'no-restricted-globals' in
    (configSchema.parse(await eslint.calculateConfigForFile(file)).rules ?? {});

  it.each([
    ['Date.now()', 'export const f = (): number => Date.now();\n', 'no-restricted-properties'],
    ['new Date()', 'export const f = (): Date => new Date();\n', 'no-restricted-syntax'],
    ['Date()', 'export const f = (): string => Date();\n', 'no-restricted-syntax'],
    [
      'Math.random()',
      'export const f = (): number => Math.random();\n',
      'no-restricted-properties',
    ],
    [
      'crypto.randomUUID()',
      'export const f = (): string => crypto.randomUUID();\n',
      'no-restricted-globals',
    ],
    [
      'performance.now()',
      'export const f = (): number => performance.now();\n',
      'no-restricted-globals',
    ],
    ['fetch', "export const f = () => fetch('https://example.com');\n", 'no-restricted-globals'],
    ['process', 'export const f = (): string => process.cwd();\n', 'no-restricted-globals'],
    [
      'setTimeout',
      'export const f = (): unknown => setTimeout(() => 0, 1);\n',
      'no-restricted-globals',
    ],
    [
      'globalThis.fetch',
      "export const f = () => globalThis.fetch('https://example.com');\n",
      'no-restricted-globals',
    ],
    [
      'globalThis.Date.now()',
      'export const f = (): number => globalThis.Date.now();\n',
      'no-restricted-globals',
    ],
    // Ways around a ban on the bare name, found in review.
    [
      'fetch destructured from globalThis',
      "const { fetch: get } = globalThis;\nexport const f = () => get('https://example.com');\n",
      'no-restricted-globals',
    ],
    [
      'an alias of globalThis',
      "const g = globalThis;\nexport const f = () => g.fetch('https://example.com');\n",
      'no-restricted-globals',
    ],
    [
      'window.fetch',
      "export const f = () => window.fetch('https://example.com');\n",
      'no-restricted-globals',
    ],
    [
      'self.crypto',
      'export const f = (): string => self.crypto.randomUUID();\n',
      'no-restricted-globals',
    ],
    [
      'setImmediate',
      'export const f = (): unknown => setImmediate(() => 0);\n',
      'no-restricted-globals',
    ],
    [
      'an alias of Date',
      'const D = Date;\nexport const f = (): number => D.now();\n',
      'no-restricted-syntax',
    ],
    [
      'new Date(...args)',
      'export const f = (args: []): Date => new Date(...args);\n',
      'no-restricted-syntax',
    ],
    [
      'Reflect.construct(Date, [])',
      'export const f = (): Date => Reflect.construct(Date, []);\n',
      'no-restricted-syntax',
    ],
    // Further ways around the Date ban, found in a second review: Date is now an allow-list.
    [
      'Date inside an object',
      'const c = { Date };\nexport const f = (): number => c.Date.now();\n',
      'no-restricted-syntax',
    ],
    ['(0, Date)', 'export const f = (): number => (0, Date).now();\n', 'no-restricted-syntax'],
    ['[Date][0]', 'export const f = (): number => [Date][0]!.now();\n', 'no-restricted-syntax'],
    [
      'Date as an argument',
      'declare function now(d: DateConstructor): number;\nexport const f = (): number => now(Date);\n',
      'no-restricted-syntax',
    ],
    [
      'new WebSocket',
      "export const f = () => new WebSocket('wss://example.com');\n",
      'no-restricted-globals',
    ],
    [
      'new EventSource',
      "export const f = () => new EventSource('/events');\n",
      'no-restricted-globals',
    ],
    ['XMLHttpRequest', 'export const f = () => new XMLHttpRequest();\n', 'no-restricted-globals'],
    ['navigator', 'export const f = (): string => navigator.userAgent;\n', 'no-restricted-globals'],
    [
      'AbortSignal.timeout',
      'export const f = () => AbortSignal.timeout(5);\n',
      'no-restricted-globals',
    ],
  ])('refuses %s in a core', async (_name, code, rule) => {
    const messages = await lint(code);
    expect(messages.some((m) => m.startsWith(`${rule}: `) && m.includes('A domain core'))).toBe(
      true,
    );
  });

  it('keeps the server-wide process.env and module-graph-state rules in a core', async () => {
    expect(await lint("export const v = process.env['HOME'];\n")).toContain(
      "no-restricted-properties: 'process.env' is restricted from being used. Read the environment in a composition root and inject it (F-23).",
    );
    expect(
      await lint(
        'declare const g: { __agentWorkspaceProbe__: number };\nexport const v = g.__agentWorkspaceProbe__;\n',
      ),
    ).toContain(
      'no-restricted-syntax: Declare module-graph state with defineSlot in apps/web/server/runtime-slot.ts.',
    );
  });

  it('accepts a pure date computation and a Date argument, as the Builder core uses', async () => {
    expect(
      await lint(
        'export const f = (now: Date, ms: number): Date =>\n  new Date(Date.UTC(now.getUTCFullYear(), 0, 1) + ms);\n',
      ),
    ).toStrictEqual([]);
    expect(
      await lint(
        "export type T = { at: Date; Date: number };\nexport const p = (): number => Date.parse('2026-01-01');\nexport const d = (x: unknown): boolean => x instanceof Date;\nexport const k = (x: T): number => x.Date;\n",
      ),
    ).toStrictEqual([]);
  });

  it('applies to every domain core, and not to its tests or the code outside a core', async () => {
    await expect(appliesTo('apps/web/server/a-new-domain/core/rules.ts')).resolves.toBe(true);
    await expect(appliesTo('apps/web/server/a-new-domain/core/sub/rules.ts')).resolves.toBe(true);
    await expect(appliesTo('apps/web/server/builder/core/decide.test.ts')).resolves.toBe(false);
    await expect(appliesTo('apps/web/server/builder/core/facts.test-support.ts')).resolves.toBe(
      false,
    );
    await expect(appliesTo('apps/web/server/builder/shell.ts')).resolves.toBe(false);
  });

  it('lets no core file read the clock', async () => {
    const cores = globSync('apps/web/server/*/core/**/*.ts')
      .filter((file) => !/\.(?:test|spec)\.ts$/.test(file))
      .sort();
    expect(cores).toContain('apps/web/server/shares/core/rules.ts');
    const readsClock: string[] = [];
    for (const file of cores) {
      if ((await lint('export const f = (): number => Date.now();\n', file)).length === 0) {
        readsClock.push(file);
      }
    }
    // Part 05 of the refactoring plan emptied the list of core files allowed to read the clock.
    expect(readsClock).toStrictEqual([]);
  });
});
