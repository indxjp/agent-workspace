import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const BUILDER_ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = /\b(promoteAgent|rollbackAgent|deleteAgent)\b/u;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('the Builder write path', () => {
  it('matches the names it forbids', () => {
    expect(FORBIDDEN.test('await store.promoteAgent(ctx)')).toBe(true);
    expect(FORBIDDEN.test('rollbackAgent')).toBe(true);
    expect(FORBIDDEN.test('deleteAgent()')).toBe(true);
    expect(FORBIDDEN.test('saveDraft')).toBe(false);
  });

  it('never names a production-pointer or delete operation in non-test source', () => {
    const sources = sourcesUnder(BUILDER_ROOT);
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(BUILDER_ROOT, file))).toEqual([]);
  });
});
