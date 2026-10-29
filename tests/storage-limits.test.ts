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
  scanFootprint,
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

  it('flags a copy written through an identifier, let/var, a property, a default or Math.pow', () => {
    const files = [
      {
        path: 'apps/web/server/files/units.ts',
        text: [
          'const MIB = 1024 * 1024;',
          'const VIA_IDENTIFIER = 128 * MIB;',
          'let VIA_LET = 64 * MIB;',
          'var VIA_VAR = 16 * MIB;',
          'const options = { maxBytes: 32 * MIB, label: "x", nested: { attachments: 10 * MIB } };',
          'class Limits { readonly field = 50 * MIB; }',
          'function upload(body: Blob, limit = 64 * MIB) {}',
          'const arrow = (cap = Math.pow(2, 27)) => cap;',
          'const POWER = Math.pow(1024, 2) * 5 * 1024;',
          'const LATER = 16 * EARLY;',
          'const EARLY = MIB;',
          'const SMALL = 5 * MIB;',
        ].join('\n'),
      },
    ];
    expect(findLimitCopies(files)).toEqual([
      'apps/web/server/files/units.ts::LATER',
      'apps/web/server/files/units.ts::POWER',
      'apps/web/server/files/units.ts::VIA_IDENTIFIER',
      'apps/web/server/files/units.ts::VIA_LET',
      'apps/web/server/files/units.ts::VIA_VAR',
      'apps/web/server/files/units.ts::attachments',
      'apps/web/server/files/units.ts::cap',
      'apps/web/server/files/units.ts::field',
      'apps/web/server/files/units.ts::limit',
      'apps/web/server/files/units.ts::maxBytes',
    ]);
  });

  it('resolves a unit imported from another file in scope', () => {
    const files = [
      { path: 'packages/runtime/src/units.ts', text: 'export const MiB = 1024 * 1024;' },
      {
        path: 'packages/runtime/src/use.ts',
        text: "import { MiB } from './units.js';\nconst CAP = 128 * MiB;\nconst unknown = 2 * other;",
      },
    ];
    expect(findLimitCopies(files)).toEqual(['packages/runtime/src/use.ts::CAP']);
  });

  it('does not flag a use of a limit imported from its owner', () => {
    const use = {
      path: 'apps/web/server/runs/use.ts',
      text: [
        "import { RUN_FILES_MAX_BYTES as RUN_CAP } from '@agent-workspace/runtime';",
        'const ALIAS = RUN_CAP;',
        'run({ maxBytes: RUN_CAP, budget: ALIAS });',
        'function read(limit = RUN_CAP) {}',
      ].join('\n'),
    };
    expect(findLimitCopies([...owners, use])).toEqual([]);
  });

  it('resolves each identifier through its own scope, not the last same-named binding', () => {
    const files = [
      {
        path: 'apps/web/server/files/scopes.ts',
        text: [
          'const MIB = 1024 * 1024;',
          'function small() { const limit = 2 * MIB; return limit; }',
          'function large() { const limit = 8 * MIB; return limit; }',
          'function shadowed(unit: number, cap = 64 * unit) { return cap; }',
          'function unit() { const unit = MIB; return unit; }',
          'function outer() { const scale = 128; { const scale = 1; } const SCALED = scale * MIB; }',
        ].join('\n'),
      },
    ];
    expect(findLimitCopies(files)).toEqual(['apps/web/server/files/scopes.ts::SCALED']);
  });

  it('reads imported units from non-test exporters only', () => {
    const files = [
      { path: 'packages/runtime/src/units.ts', text: 'export const MiB = 1024 * 1024;' },
      { path: 'packages/runtime/src/units.test.ts', text: 'export const MiB = 1000 * 1000;' },
      {
        path: 'packages/runtime/src/use.ts',
        text: "import { MiB } from './units.js';\nconst CAP = 128 * MiB;",
      },
    ];
    expect(findLimitCopies(files)).toEqual(['packages/runtime/src/use.ts::CAP']);
  });

  it('does not flag a test-support module that only tests import', () => {
    const fixture = {
      path: 'apps/web/server/runs/load-fixtures.ts',
      text: 'const MiB = 1024 * 1024;\nexport const RSS_BOUND = 64 * MiB;',
    };
    const test = {
      path: 'apps/web/server/runs/load.test.ts',
      text: "import { RSS_BOUND } from './load-fixtures';",
    };
    const outside = {
      path: 'tests/load/x.ts',
      text: "import { RSS_BOUND } from '../../apps/web/server/runs/load-fixtures.js';",
    };
    expect(findLimitCopies([fixture, test, outside])).toEqual([]);
    expect(findLimitCopies([fixture])).toEqual([
      'apps/web/server/runs/load-fixtures.ts::RSS_BOUND',
    ]);
    const production = [
      {
        path: 'apps/web/server/runs/service.ts',
        text: "import { RSS_BOUND } from './load-fixtures.js';",
      },
      { path: 'apps/web/server/runs/barrel.ts', text: "export * from './load-fixtures';" },
      {
        path: 'apps/web/server/files/pkg.ts',
        text: "import { RSS_BOUND } from '@agent-workspace/web/runs/load-fixtures';",
      },
    ];
    for (const importer of production) {
      expect(findLimitCopies([fixture, test, importer]), importer.path).toEqual([
        'apps/web/server/runs/load-fixtures.ts::RSS_BOUND',
      ]);
    }
  });

  it('keeps a shipping module in scope even when only tests import it', () => {
    const text = 'const MiB = 1024 * 1024;\nexport const CAP = 64 * MiB;';
    const importedByTests = (path: string) => [
      { path, text },
      {
        path: 'tests/x.test.ts',
        text: `import { CAP } from '../${path.replace(/\.ts$/u, '.js')}';`,
      },
    ];
    // A published subpath, a package export, a fixture-named file: all of packages/*/src ships.
    for (const path of [
      'packages/sdk/src/testing.ts',
      'packages/core/src/storage/backends.ts',
      'packages/runtime/src/load-fixtures.ts',
    ]) {
      expect(findLimitCopies(importedByTests(path)), path).toEqual([`${path}::CAP`]);
    }
    // A framework-loaded file is not test support by its name, whoever imports it.
    const loaded = 'apps/web/server/surfaces/loader/test-runtime.ts';
    expect(findLimitCopies(importedByTests(loaded))).toEqual([`${loaded}::CAP`]);
    // An app's package.json export ships even under a test-support name.
    const exported = 'apps/web/server/files/export-fixtures.ts';
    const manifest = {
      path: 'apps/web/package.json',
      text: JSON.stringify({
        exports: { './fixtures': { types: './server/files/export-fixtures.ts' } },
      }),
    };
    expect(findLimitCopies(importedByTests(exported))).toEqual([]);
    expect(findLimitCopies([...importedByTests(exported), manifest])).toEqual([`${exported}::CAP`]);
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

    // Bounded by the scope: parsing every apps/packages source took the scan to 4 s of vitest's 5.
    const { inScope, exporters } = scanFootprint(files);
    expect(exporters, `exporters parsed for ${inScope} files in scope`).toBeLessThan(inScope);
  });

  it('parses only the exporters of the units a fold imports', () => {
    const unrelated = Array.from({ length: 5 }, (_, index) => ({
      path: `packages/core/src/other-${index}.ts`,
      text: `export const VALUE_${index} = ${index};`,
    }));
    const files = [
      ...unrelated,
      { path: 'packages/core/src/units.ts', text: 'export const MiB = 1024 * 1024;' },
      { path: 'packages/runtime/src/units.test.ts', text: 'export const MiB = 1;' },
      {
        path: 'packages/runtime/src/use.ts',
        text: "import { MiB } from '@agent-workspace/core';\nimport { VALUE_1 } from 'x';\nconst CAP = 2 * MiB;\nlabel(VALUE_1);",
      },
    ];
    expect(scanFootprint(files)).toEqual({ inScope: 1, exporters: 1 });
  });
});
