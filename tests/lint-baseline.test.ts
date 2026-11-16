import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CLOCK_CALLS_CEILING,
  clockConfig,
  measure as measureClockCalls,
  verdict as clockVerdict,
} from '../scripts/check-clock-ceiling.mjs';
import { grown as clockGrown, parseCeiling } from '../scripts/clock-ceiling.mjs';
import {
  DURATION_CEILING,
  durationConfig,
  measure as measureDurations,
  verdict as durationVerdict,
} from '../scripts/check-duration-ceiling.mjs';
import { grown as durationGrown } from '../scripts/duration-ceiling.mjs';
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

/**
 * Refactoring plan §07: direct clock and random-id calls in server code can only go down. The
 * selectors are run on code planted at real paths, so the scope is exercised as CI applies it.
 */
describe('the clock ratchet', { timeout: 120_000 }, () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: clockConfig() });
  const counted = async (code: string, file = 'apps/web/server/runs/service.ts') => {
    const [report] = await eslint.lintText(code, { filePath: path.resolve(file) });
    // A file outside the scope gets ESLint's "no matching configuration" notice, not a count.
    return (report?.messages ?? []).filter(
      (m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'clock/aliased-random-id',
    ).length;
  };

  it('holds only when the ceiling equals the calls counted', () => {
    expect(clockVerdict(90, 90)).toBeNull();
    expect(clockVerdict(90, 91)).toContain('above the ceiling 90');
    expect(clockVerdict(90, 91)).toContain('IdGenerator');
    expect(clockVerdict(90, 89)).toContain('lower the ceiling in scripts/clock-ceiling.json to 89');
  });

  it('refuses a ceiling raised above the base, and allows one equal, lower or new', () => {
    expect(clockGrown(90, 91)).toContain('grew from 90 to 91');
    expect(clockGrown(90, 90)).toBeNull();
    expect(clockGrown(90, 89)).toBeNull();
    expect(clockGrown(undefined, 90)).toBeNull();
  });

  it('reads only a non-negative integer ceiling', () => {
    expect(parseCeiling('{"ceiling": 90}')).toBe(90);
    for (const bad of ['{}', '{"ceiling": "90"}', '{"ceiling": -1}', '{"ceiling": 1.5}']) {
      expect(() => parseCeiling(bad)).toThrow('non-negative integer');
    }
  });

  it('runs the comparison as CI does, with no base file when the base has no ceiling', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clock-ceiling-'));
    const file = (name: string, ceiling: number) => {
      writeFileSync(path.join(dir, name), JSON.stringify({ ceiling }));
      return path.join(dir, name);
    };
    const run = (base: string, head: string) =>
      spawnSync(process.execPath, ['scripts/clock-ceiling.mjs', base, head], { encoding: 'utf8' });
    const raised = run(file('base.json', 90), file('raised.json', 91));
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain('grew from 90 to 91');
    expect(run(path.join(dir, 'base.json'), file('equal.json', 90)).status).toBe(0);
    expect(run(path.join(dir, 'base.json'), file('lower.json', 89)).status).toBe(0);
    const introduced = run(path.join(dir, 'missing.json'), file('new.json', 90));
    expect(introduced.status).toBe(0);
    expect(introduced.stdout).toContain('this change introduces it');
  });

  it.each([
    ['Date.now()', 'export const f = (): number => Date.now();\n'],
    ['Date.now passed as a default', 'export const f = (now = Date.now): number => now();\n'],
    ['new Date()', 'export const f = (): Date => new Date();\n'],
    ['Math.random()', 'export const f = (): number => Math.random();\n'],
    [
      'randomUUID() imported',
      "import { randomUUID } from 'node:crypto';\nexport const f = (): string => randomUUID();\n",
    ],
    [
      'randomBytes() imported',
      "import { randomBytes } from 'node:crypto';\nexport const f = (): Buffer => randomBytes(8);\n",
    ],
    ['crypto.randomUUID()', 'export const f = (): string => crypto.randomUUID();\n'],
  ])('counts %s', async (_name, code) => {
    expect(await counted(code)).toBe(1);
  });

  it('counts each use of a renamed randomUUID or randomBytes import, and an unrenamed one once', async () => {
    const renamed =
      "import { randomUUID as mint } from 'node:crypto';\n" +
      'export const f = (): string => mint();\nexport const g = (): string => mint();\n';
    expect(await counted(renamed)).toBe(2);
    const bytes =
      "import { randomBytes as bytes } from 'node:crypto';\nexport const f = () => bytes(8);\n";
    expect(await counted(bytes)).toBe(1);
    const plain =
      "import { randomUUID } from 'node:crypto';\nexport const f = (): string => randomUUID();\n";
    expect(await counted(plain)).toBe(1);
  });

  it('does not count the secret-making randomInt and crypto.getRandomValues', async () => {
    const randomIntCode =
      "import { randomInt } from 'node:crypto';\nexport const f = (): number => randomInt(10);\n";
    expect(await counted(randomIntCode)).toBe(0);
    const values = 'export const f = () => crypto.getRandomValues(new Uint8Array(32));\n';
    expect(await counted(values)).toBe(0);
    const renamedInt =
      "import { randomInt as pick } from 'node:crypto';\nexport const f = (): number => pick(10);\n";
    expect(await counted(renamedInt)).toBe(0);
  });

  it('counts a file whose name only contains "store", such as restore-*.ts', async () => {
    const code = 'export const f = (): number => Date.now();\n';
    expect(await counted(code, 'apps/web/server/agents/restore-capability.ts')).toBe(1);
  });

  it('does not count parsing a date or a call that only shares a name', async () => {
    expect(await counted('export const f = (ms: number): Date => new Date(ms);\n')).toBe(0);
    expect(await counted("export const f = (): number => Date.parse('2026-11-06');\n")).toBe(0);
    expect(await counted('export const f = (ids: { newId(): string }) => ids.newId();\n')).toBe(0);
  });

  it.each([
    'apps/web/server/clock.ts',
    'apps/web/server/ids.ts',
    'apps/web/server/composition/services.ts',
    'apps/web/server/runs/store.ts',
    'apps/web/server/agent-versions/memory-store/state.ts',
    'apps/web/server/rbac/testing.ts',
    'apps/web/server/runs/service.test.ts',
    'apps/web/server/sessions/acceptance/resume.acceptance.ts',
  ])('leaves %s out, as the plan counts', async (file) => {
    expect(await counted('export const f = (): number => Date.now();\n', file)).toBe(0);
  });

  it('matches the ceiling on the real tree', async () => {
    expect((await measureClockCalls()).length).toBe(CLOCK_CALLS_CEILING);
  });
});

/**
 * Refactoring part 03, step 8: a duration, size or limit of 1_000 or more gets a name, and the bare
 * ones left in server code can only go down. Planted at real paths, as for the clock.
 */
describe('the duration ratchet', { timeout: 120_000 }, () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: durationConfig() });
  const counted = async (code: string, file = 'apps/web/server/runs/service.ts') => {
    const [report] = await eslint.lintText(code, { filePath: path.resolve(file) });
    return (report?.messages ?? []).filter((m) => m.ruleId === 'durations/bare').length;
  };

  it('holds only when the ceiling equals the bare durations counted', () => {
    expect(durationVerdict(12, 12)).toBeNull();
    expect(durationVerdict(12, 13)).toContain('above the ceiling 12');
    expect(durationVerdict(12, 11)).toContain(
      'lower the ceiling in scripts/duration-ceiling.json to 11',
    );
  });

  it('refuses a ceiling raised above the base, and allows one equal, lower or new', () => {
    expect(durationGrown(12, 13)).toContain('grew from 12 to 13');
    expect(durationGrown(12, 12)).toBeNull();
    expect(durationGrown(12, 11)).toBeNull();
    expect(durationGrown(undefined, 12)).toBeNull();
  });

  it('runs the comparison as CI does, with no base file when the base has no ceiling', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'duration-ceiling-'));
    const file = (name: string, ceiling: number) => {
      writeFileSync(path.join(dir, name), JSON.stringify({ ceiling }));
      return path.join(dir, name);
    };
    const run = (base: string, head: string) =>
      spawnSync(process.execPath, ['scripts/duration-ceiling.mjs', base, head], {
        encoding: 'utf8',
      });
    const raised = run(file('base.json', 12), file('raised.json', 13));
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain('grew from 12 to 13');
    expect(run(path.join(dir, 'base.json'), file('equal.json', 12)).status).toBe(0);
    expect(run(path.join(dir, 'base.json'), file('lower.json', 11)).status).toBe(0);
    const introduced = run(path.join(dir, 'missing.json'), file('new.json', 12));
    expect(introduced.status).toBe(0);
    expect(introduced.stdout).toContain('this change introduces it');
    const badHead = run(path.join(dir, 'base.json'), file('bad.json', -1));
    expect(badHead.status).not.toBe(0);
    expect(badHead.stderr).toContain('non-negative integer');
  });

  it.each([
    ['a call argument', 'export const f = (g: (ms: number) => void) => g(60_000);\n'],
    ['a fallback', 'export const f = (ms?: number): number => ms ?? 30_000;\n'],
    ['a default parameter', 'export const f = (ms = 10_000): number => ms;\n'],
    ['a bound', 'export const f = (n: number): boolean => n > 3_600;\n'],
    ['a let', 'export let ttl = 60_000;\n'],
    ['arithmetic outside a const', 'export const f = (now: number): number => now - 3_600_000;\n'],
    ['a day in milliseconds', 'export const f = (days: number): number => days * 86_400_000;\n'],
    ['a number with no separator', 'export const f = (ms?: number): number => ms ?? 30000;\n'],
    ['a bound with no separator', 'export const f = (port: number): boolean => port > 65535;\n'],
  ])('counts a bare duration in %s', async (_name, code) => {
    expect(await counted(code)).toBe(1);
  });

  it.each([
    ['a const', 'export const LEASE_TTL_MS = 60_000;\n'],
    ['const arithmetic', 'const MARGIN_MS = 5 * 60_000;\nexport { MARGIN_MS };\n'],
    [
      'a const table',
      'export const RETRY = { first: 10_000, last: [60_000, 120_000] } as const;\n',
    ],
    ['a class field', 'export class Limits {\n  static readonly MAX = 1_024;\n}\n'],
    ['seconds to milliseconds', 'export const f = (s: number): number => s * 1_000;\n'],
    ['milliseconds to seconds', 'export const f = (ms: number): number => ms / 1_000;\n'],
    [
      'a hexadecimal bit pattern',
      'export const f = (h: number): number => Math.imul(h, 0x01000193);\n',
    ],
    ['a negated protocol code', 'export const f = (code: number): boolean => code <= -32000;\n'],
    ['a Date.UTC calendar field', 'export const END = (): number => Date.UTC(9999, 11, 31);\n'],
    ['under 1_000', 'export const f = (n?: number): number => n ?? 9_99;\n'],
  ])('does not count %s', async (_name, code) => {
    expect(await counted(code)).toBe(0);
  });

  it('counts a power of ten that is not a factor, and a factor that is not a power of ten', async () => {
    expect(await counted('export const f = (ms?: number): number => ms ?? 10_000;\n')).toBe(1);
    expect(await counted('export const f = (s: number): number => s * 3_600;\n')).toBe(1);
  });

  it.each(['apps/runner/src/manager.ts', 'packages/gateway/src/index.ts'])(
    'counts in %s too',
    async (file) => {
      expect(await counted('export const f = (ms?: number): number => ms ?? 30_000;\n', file)).toBe(
        1,
      );
    },
  );

  it.each([
    'apps/web/server/composition/services.ts',
    'apps/web/server/runs/store.ts',
    'apps/web/server/runs/service.test.ts',
    'apps/runner/src/manager.fixture.test-support.ts',
    'apps/web/app/api/runs/route.ts',
  ])('leaves %s out', async (file) => {
    expect(await counted('export const f = (ms?: number): number => ms ?? 30_000;\n', file)).toBe(
      0,
    );
  });

  it('matches the ceiling on the real tree', async () => {
    expect((await measureDurations()).length).toBe(DURATION_CEILING);
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
