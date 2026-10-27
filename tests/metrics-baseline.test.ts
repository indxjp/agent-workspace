import { describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  complexityBuckets,
  countConsoleCalls,
  countCoreDbSpecifiers,
  countLines,
  countRawApiFetches,
  duplicateVocabularies,
  isTestFile,
  sizesByWorkspace,
  validateBaseline,
} from '../scripts/metrics/baseline.mjs';

describe('metrics baseline counting', () => {
  it('counts lines without a phantom trailing line', () => {
    expect([countLines(''), countLines('a\nb\n'), countLines('a\nb')]).toEqual([0, 2, 2]);
  });

  it('splits production from test lines per workspace', () => {
    const sizes = sizesByWorkspace({
      'packages/core/src/a.ts': 'x\ny\n',
      'packages/core/src/a.test.ts': 'x\n',
      'packages/core/src/types.d.ts': 'ignored\n',
      'tests/b.test.ts': 'x\n',
    });
    expect(sizes['packages/core']).toMatchObject({ productionLines: 2, testLines: 1 });
    expect(sizes['tests']).toMatchObject({ productionLines: 0, testLines: 1 });
    expect(isTestFile('apps/web/lib/testing/x.ts')).toBe(true);
  });

  it('counts core/db specifiers, raw api fetches and console calls', () => {
    expect(
      countCoreDbSpecifiers(
        "import a from '@agent-workspace/core/db';\nimport('@agent-workspace/core/db/schema');\nimport c from '@agent-workspace/core';",
      ),
    ).toBe(2);
    expect(
      countRawApiFetches("fetch('/api/a'); fetch(`/api/b`); fetch(url); sdk.fetch('/x')"),
    ).toBe(2);
    expect(countConsoleCalls("// console.log('no')\nconsole.error('x'); console.warn('y');")).toBe(
      2,
    );
  });

  it('finds a contracts vocabulary re-declared elsewhere', () => {
    const found = duplicateVocabularies({
      'packages/contracts/src/runs.ts':
        "export const RUN_STATUSES = ['queued', 'running'] as const;",
      'apps/web/store.ts': "type S = 'running' | 'queued';",
      'apps/web/other.ts': "type S = 'running' | 'done';",
      'apps/web/store.test.ts': "type S = 'running' | 'queued';",
    });
    expect(found).toEqual({ RUN_STATUSES: ['apps/web/store.ts'] });
  });

  it('buckets complexity and validates the committed shape', () => {
    expect(complexityBuckets([11, 16, 25, 34])).toMatchObject({
      '11-15': 1,
      '16-20': 1,
      '21-33': 1,
      '>33': 1,
      max: 34,
    });
    expect(validateBaseline({})).not.toEqual([]);
    expect(validateBaseline({ schemaVersion: SCHEMA_VERSION })).not.toEqual([]);
    expect(validateBaseline(null)).toEqual(['not an object']);
  });
});
