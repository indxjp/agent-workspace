import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findBrokenLinks } from '../../scripts/docs/check-links.mjs';

let root: string | undefined;

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('findBrokenLinks', () => {
  it('reports only the link whose target does not exist, with its line', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-check-links-'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'real.md'), '# real\n');
    await writeFile(path.join(root, 'docs', 'with space.md'), '# spaced\n');
    await writeFile(
      path.join(root, 'docs', 'index.md'),
      [
        '[ok](real.md)',
        '[missing](gone.md)',
        '```',
        '[fenced](fenced-gone.md)',
        '```',
        'inline `[code](code-gone.md)` text',
        '[web](https://example.com/x.md) [anchor](#top) [frag](real.md#a)',
        '[encoded](with%20space.md) [titled](real.md "Title")',
      ].join('\n'),
    );
    expect(findBrokenLinks(root, ['docs/index.md'])).toEqual([
      { file: 'docs/index.md', line: 2, target: 'gone.md' },
    ]);
  });
});
