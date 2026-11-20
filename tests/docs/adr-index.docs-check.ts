/**
 * docs/adr/ is indexed whole by `scripts/docs/adr-index.mjs`, and the index is never committed into
 * docs/adr/README.md. The renderer's own cases are tests/docs/adr-index.test.ts.
 *
 * A static check of the `docs-check` lane (tests/static-checks/vitest.config.ts): `pnpm docs:check`
 * runs it on every change, in fast-checks.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderAdrIndex } from '../../scripts/docs/adr-index.mjs';

const adrDir = path.resolve(import.meta.dirname, '../../docs/adr');

describe('the ADR index of docs/adr', () => {
  it('indexes every record in docs/adr, so nothing needs committing', async () => {
    const records = (await readdir(adrDir)).filter((f) => f.endsWith('.md') && f !== 'README.md');
    const rows = (await renderAdrIndex(adrDir)).split('\n').filter((l) => l.startsWith('| ['));
    expect(rows).toHaveLength(records.length);
  });

  it('is not committed into docs/adr/README.md, where every ADR PR would conflict on it', async () => {
    const readme = await readFile(path.join(adrDir, 'README.md'), 'utf8');
    expect(readme).not.toMatch(/GENERATED INDEX|^\| \[[^\]]+\]\([^)]+\.md\) \|/mu);
  });
});
