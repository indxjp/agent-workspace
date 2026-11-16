import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Capability, Cell } from './benchmark.ts';

const CONTRACT_TEST_FILE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.test(?:-support)?\.ts$/u;

export async function assertContractEvidence(evidence: {
  readonly directory: string;
  readonly id: string;
  readonly capability: Capability;
  readonly cell: Pick<Cell, 'ref' | 'testFile'>;
}): Promise<void> {
  const { directory, id, capability, cell } = evidence;
  const where = `${id}.${capability}`;
  const testFile = cell.testFile ?? `${id}.test.ts`;
  if (!CONTRACT_TEST_FILE.test(testFile)) {
    throw new Error(`${where}: the evidence owner must be a same-gallery test module filename`);
  }
  const source = await readFile(path.join(directory, testFile), 'utf8');
  if (!source.includes(`'${cell.ref}'`)) {
    throw new Error(`${where}: ${testFile} has no test titled "${cell.ref}"`);
  }
}
