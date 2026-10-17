// aw imports @indx-workspace/platforms from dist, so a workflow that builds aw from source must
// build platforms too (or build aw's whole dependency closure with `aw...`).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = path.resolve(import.meta.dirname, '../../.github/workflows');
const AW = '@indx-workspace/aw';
const PLATFORMS = '@indx-workspace/platforms';

describe('workflow builds of aw', () => {
  it('build @indx-workspace/platforms alongside aw', () => {
    const missing: string[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
      readFileSync(path.join(WORKFLOWS, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!/\bbuild\b/.test(line) || !new RegExp(`${AW}(?![\\w/-])`).test(line)) return;
          if (line.includes(`${AW}...`) || line.includes(PLATFORMS)) return;
          missing.push(`${file}:${index + 1}`);
        });
    }
    expect(missing).toEqual([]);
  });
});
