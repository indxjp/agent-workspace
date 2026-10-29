// Fitness test for the storage-bridge marker (the storage design, §06 Phase 6 and §09): every
// temporary bridge carries a greppable marker naming the issue that deletes it, and the last
// phase fails if any remain. The format is in ENGINEERING_GUIDELINES.md.
import console from 'node:console';

import { describe, expect, it } from 'vitest';

import { bridgeViolations, findBridges, trackedTextFiles } from '../scripts/ci/debt-review.mjs';

/** Flipped to `false` by the Phase 6 removal issue (#1703); the real tree must then hold none. */
export const BRIDGES_MAY_REMAIN = true;

const where = (b: { path: string; line: number; text: string }) => `${b.path}:${b.line} ${b.text}`;

const real = findBridges(trackedTextFiles());

describe('storage-bridge markers', () => {
  it('rejects a marker without a removal issue', () => {
    const found = findBridges([
      { path: 'fixture.ts', text: 'const a = 1;\n// storage-bridge: no issue\n' },
    ]);
    expect(found.malformed.map(where)).toEqual(['fixture.ts:2 // storage-bridge: no issue']);
    expect(bridgeViolations(found, true)).toHaveLength(1);
  });

  it('accepts the documented forms in code and markdown', () => {
    const found = findBridges([
      { path: 'a.ts', text: '// storage-bridge(#1234): translate the old root setting' },
      { path: 'b.md', text: '<!-- storage-bridge(#1698): old naming -->' },
    ]);
    expect(found.malformed).toEqual([]);
    expect(found.bridges.map((b) => b.path)).toEqual(['a.ts', 'b.md']);
  });

  it('ignores a line that names the fitness test', () => {
    const found = findBridges([{ path: 'a.md', text: 'see tests/storage-bridges.test.ts' }]);
    expect(found).toEqual({ bridges: [], malformed: [] });
  });

  it(`lists every marker (${real.bridges.length})`, () => {
    for (const b of real.bridges) console.info(where(b));
    expect(real.malformed.map(where)).toEqual([]);
    expect(bridgeViolations(real, BRIDGES_MAY_REMAIN)).toEqual([]);
  });

  // One kind of bridge has one removal issue (the table in ENGINEERING_GUIDELINES.md), so closing
  // it leaves no marker of that kind behind.
  it('gives every marker waiting on the hand-written file-catalog fakes one removal issue', () => {
    const issues = real.bridges
      .filter((b) => /file-catalog fakes/u.test(b.text))
      .map((b) => /storage-bridge\(#(\d+)\)/u.exec(b.text)?.[1]);
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues)).toEqual(new Set(['1634']));
  });

  it('allows none once BRIDGES_MAY_REMAIN is false', () => {
    const one = findBridges([{ path: 'a.ts', text: '// storage-bridge(#1698): demo' }]);
    expect(bridgeViolations(one, true)).toEqual([]);
    expect(bridgeViolations(one, false).map(where)).toEqual([
      'a.ts:1 // storage-bridge(#1698): demo',
    ]);
  });
});
