// Fitness test for the storage size limits (the storage design, §04 "Size limits"): each limit is
// defined in exactly one place, and a copy anywhere else in the storage scope fails here. The
// allowlist holds today's copies and may only shrink; #1626 deletes them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { trackedTextFiles } from '../scripts/ci/debt-review.mjs';

import {
  STORAGE_LIMITS,
  findLimitCopies,
  findMissingOwners,
  inStorageScope,
} from './fitness/storage-limits.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ALLOWLIST = 'tests/fitness/storage-limits-allowlist.json';

function allowlist(): Record<string, string> {
  return JSON.parse(readFileSync(root + ALLOWLIST, 'utf8')) as Record<string, string>;
}

/** Shared by the real scan and the fixtures: (new violations, stale allowlist entries). */
function compare(found: readonly string[], allowed: readonly string[]) {
  return {
    added: found.filter((key) => !allowed.includes(key)),
    stale: allowed.filter((key) => !found.includes(key)),
  };
}

const owners = [...new Set(STORAGE_LIMITS.map((limit) => limit.owner))].map((path) => ({
  path,
  text: STORAGE_LIMITS.filter((limit) => limit.owner === path)
    .map((limit) => `export const ${limit.name} = ${limit.bytes};`)
    .join('\n'),
}));

describe('storage size limits are defined once', () => {
  it('flags a planted copy', () => {
    const files = [
      { path: 'apps/web/server/files/x.ts', text: 'const LIMIT = 64 * 1024 * 1024;' },
      { path: 'apps/runner/src/y.ts', text: 'export const RAW = 134_217_728;' },
      {
        path: 'apps/runner/src/z.ts',
        text: 'const SHIFTED = 1 << 25;\nconst OTHER = 5 * 1024;\nconst POW = 2 ** 26;',
      },
    ];
    expect(findLimitCopies(files)).toEqual([
      'apps/runner/src/y.ts::RAW',
      'apps/runner/src/z.ts::POW',
      'apps/runner/src/z.ts::SHIFTED',
      'apps/web/server/files/x.ts::LIMIT',
    ]);
  });

  it('does not flag a limit inside its owner', () => {
    expect(findLimitCopies(owners)).toEqual([]);
  });

  it('ignores files outside the storage scope', () => {
    const text = 'const LIMIT = 64 * 1024 * 1024;';
    const files = [
      'packages/gateway/src/x.ts',
      'apps/web/server/files/x.test.ts',
      'apps/web/server/files/x.d.ts',
      'packages/core/src/storage/x.live.acceptance.ts',
      'apps/web/app/x.ts',
      'packages/core/src/db/x.ts',
    ].map((path) => ({ path, text }));
    expect(findLimitCopies(files)).toEqual([]);
    expect(inStorageScope('packages/core/src/storage/x.ts')).toBe(true);
    expect(inStorageScope('apps/web/server/surfaces/a/b.ts')).toBe(true);
  });

  it('each owner exports its limit', () => {
    expect(findMissingOwners(owners)).toEqual([]);
    const wrong = owners.map((o) =>
      o.path === 'packages/contracts/src/files.ts'
        ? { ...o, text: 'export const MAX_UPLOAD_BYTES = 1;\nconst MAX_OTHER = 64 * 1024 * 1024;' }
        : o,
    );
    expect(findMissingOwners(wrong)).toEqual([
      'packages/contracts/src/files.ts::MAX_UPLOAD_BYTES',
      'packages/contracts/src/files.ts::SIGNED_UPLOAD_HARD_MAX_BYTES',
    ]);
    expect(findMissingOwners([])).toHaveLength(STORAGE_LIMITS.length);
  });

  it('allowlist has no stale entry', () => {
    expect(compare(['a::X'], ['a::X', 'b::Y'])).toEqual({ added: [], stale: ['b::Y'] });
    expect(compare(['a::X', 'c::Z'], ['a::X'])).toEqual({ added: ['c::Z'], stale: [] });

    const files = trackedTextFiles();
    const found = [...findLimitCopies(files), ...findMissingOwners(files)].sort();
    const { added, stale } = compare(found, Object.keys(allowlist()));
    const ownedBy = STORAGE_LIMITS.map((limit) => `${limit.name} (${limit.owner})`).join(', ');
    expect(added, `new copy of a storage size limit: import it from its owner: ${ownedBy}`).toEqual(
      [],
    );
    expect(stale, 'allowlist entries the scan no longer finds: delete them').toEqual([]);
  });
});
