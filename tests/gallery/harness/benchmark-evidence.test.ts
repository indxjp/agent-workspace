import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import contractReview from '../contract-review/benchmark.ts';
import excelConsolidation from '../excel-consolidation/benchmark.ts';
import manualSearch from '../manual-search/benchmark.ts';
import { assertContractEvidence } from './benchmark-evidence.ts';

const GALLERY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractOwner = 'contract-review.definition.test-support.ts';

describe('gallery contract evidence owners', () => {
  it.each([excelConsolidation, contractReview, manualSearch])(
    'resolves $id evidence in its assertion module, retaining the default root filename',
    async (benchmark) => {
      const cell = benchmark.cells.agent;
      if (cell === null) throw new Error('the gallery fixture has no agent evidence');
      await expect(
        assertContractEvidence({
          directory: path.join(GALLERY, benchmark.id),
          id: benchmark.id,
          capability: 'agent',
          cell,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('refuses an owner that exists but does not contain the required title', async () => {
    await expect(
      assertContractEvidence({
        directory: path.join(GALLERY, 'contract-review'),
        id: 'contract-review',
        capability: 'agent',
        cell: { testFile: contractOwner, ref: 'missing contract evidence title' },
      }),
    ).rejects.toThrow('has no test titled "missing contract evidence title"');
  });

  it('refuses a missing assertion module', async () => {
    await expect(
      assertContractEvidence({
        directory: path.join(GALLERY, 'contract-review'),
        id: 'contract-review',
        capability: 'agent',
        cell: { testFile: 'missing.test-support.ts', ref: 'required title' },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    `../${contractOwner}`,
    `..\\${contractOwner}`,
    `subdirectory/${contractOwner}`,
    `subdirectory\\${contractOwner}`,
    `/tmp/${contractOwner}`,
    `C:\\tests\\${contractOwner}`,
    'contract-review..definition.test-support.ts',
    'benchmark.ts',
    '',
  ])('refuses the invalid evidence owner %j', async (testFile) => {
    await expect(
      assertContractEvidence({
        directory: path.join(GALLERY, 'contract-review'),
        id: 'contract-review',
        capability: 'agent',
        cell: { testFile, ref: 'required title' },
      }),
    ).rejects.toThrow('must be a same-gallery test module filename');
  });
});
