import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { countFiles } from './layout.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
});

// @story US-STO-13
describe('doctor storage layout: local count', () => {
  it('[US-STO-13][api][cli] doctor stops counting local files at the cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-count-'));
    created.push(root);
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    for (const name of ['1', 'a/2', 'a/b/3', 'a/b/4', 'a/b/5']) {
      await writeFile(path.join(root, name), 'x');
    }

    expect(await countFiles(root, 100)).toBe(5);
    expect(await countFiles(root, 3)).toBe(3);
    expect(await countFiles(path.join(root, 'absent'), 3)).toBe(0);
  });
});
