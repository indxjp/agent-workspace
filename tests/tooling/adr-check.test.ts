import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { indexFailures, validateAdrs } from '../../scripts/check-adrs.mjs';

const roots: string[] = [];

async function adrDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-workspace-adr-gate-'));
  roots.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(path.join(dir, name), body)),
  );
  return dir;
}

const record = (status = 'accepted') =>
  `# ADR-0001 — A decision\n\nStatus: ${status}\nDate: 2026-01-01\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('validateAdrs', () => {
  it('passes a clean directory', async () => {
    const dir = await adrDir({
      '0001-first.md': record(),
      '0002-second.md': record('proposed'),
      'W1-X-01-task-record.md': '# W1-X-01 — t\n\n- **Status:** accepted\n',
      'README.md': '# index\n',
    });
    expect(await validateAdrs(dir)).toEqual([]);
  });

  it('fails on a duplicate ADR number', async () => {
    const dir = await adrDir({ '0001-first.md': record(), '0001-other.md': record() });
    expect(await validateAdrs(dir)).toEqual([expect.stringContaining('duplicate ADR number 0001')]);
  });

  it('fails on a malformed filename', async () => {
    const dir = await adrDir({ '001-short.md': record(), '0002-Upper_Case.md': record() });
    expect(await validateAdrs(dir)).toHaveLength(2);
  });

  it('fails on a missing or unknown status', async () => {
    const dir = await adrDir({
      '0001-none.md': '# ADR-0001 — x\n\nDate: 2026-01-01\n',
      '0002-odd.md': record('maybe'),
    });
    expect(await validateAdrs(dir)).toHaveLength(2);
  });

  it('fails when the index generator cannot read a title or a date', async () => {
    const dir = await adrDir({
      '0001-good.md': record(),
      '0002-no-date.md': '# ADR-0002 — x\n\nStatus: accepted\n',
      '0003-no-title.md': '\nStatus: accepted\nDate: 2026-01-01\n',
    });
    expect(await indexFailures(dir)).toEqual([
      '0002-no-date.md: the index generator found no Date',
      '0003-no-title.md: the index generator found no title',
    ]);
  });
});
