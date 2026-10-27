import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const adapters = fileURLToPath(new URL('.', import.meta.url));
const read = (path: string) => readFileSync(path, 'utf8');

/** The ports a contract suite names: what it imports from `ports.ts`, minus `CallContext` and friends. */
function portsOf(source: string): string[] {
  const imported = /import type \{([^}]*)\} from '\.\.\/\.\.\/ports'/.exec(source)?.[1] ?? '';
  return imported
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^\w+Port$/.test(name));
}

const suites = readdirSync(adapters, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    readdirSync(join(adapters, entry.name))
      .filter((file) => file.endsWith('.contract.ts'))
      .map((file) => ({ dir: join(adapters, entry.name), file })),
  )
  .map(({ dir, file }) => ({
    dir,
    source: read(join(dir, file)),
    ports: portsOf(read(join(dir, file))),
  }));

const declared = [...read(join(adapters, '../ports.ts')).matchAll(/export interface (\w+Port)\b/g)]
  .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
  .sort();

describe('every Builder port has a contract suite run on its production and memory adapters', () => {
  it('has a suite that names exactly one port', () => {
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) expect(suite.ports, suite.dir).toHaveLength(1);
  });

  it('lists a contract suite for each port in ports.ts, and a port for each suite', () => {
    expect(suites.flatMap((suite) => suite.ports).sort()).toEqual(declared);
  });

  it.each(
    suites.map((suite) => ({ port: suite.ports[0] ?? '', dir: suite.dir, source: suite.source })),
  )(
    '$port: a memory and a production adapter, and the suite run at least twice',
    ({ dir, source }) => {
      const files = readdirSync(dir);
      expect(files).toContain('memory.ts');
      expect(files.some((file) => file === 'production.ts' || file === 'store.ts')).toBe(true);
      expect(existsSync(join(dir, 'memory.ts'))).toBe(true);
      const runner = /export function (describe\w+Conformance)\(/.exec(source)?.[1];
      expect(runner).toBeDefined();
      const tests = files
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => read(join(dir, file)));
      expect(tests.some((text) => text.includes("from './memory'"))).toBe(true);
      expect(tests.some((text) => /from '\.\/(production|store)'/.test(text))).toBe(true);
      const calls = tests.map((text) => text.split(`${runner ?? ''}(`).length - 1);
      expect(calls.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(2);
    },
  );
});
