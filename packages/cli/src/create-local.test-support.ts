import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANSWERS } from './create.js';
import { CLI_VERSION } from './version.js';
import { created, images, create, captureStdout } from './create-test-fixtures.test-support.js';

export function describeCreateLocal(): void {
  describe('--cloud local, the v1 Compose project (S1-16 regression)', () => {
    // The default moved to the v2 project; `--cloud local` keeps writing exactly what the bare
    // command wrote before: the template files, then the rendered artefacts, and a package.json that
    // depends on the published CLI alone.
    it('writes the same file list and package.json dependencies as the bare command did', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-v1-'));
      created.push(parent);
      const target = path.join(parent, 'acme-ai');
      const output = captureStdout();

      await create([target, '--cloud', 'local'], { images, answers: DEFAULT_ANSWERS });

      const templates = (await readdir(new URL('../templates/', import.meta.url))).sort();
      const listed = output()
        .split('\n')
        .filter((line) => line.startsWith('  '))
        .map((line) => line.trim());
      expect(listed).toEqual([...templates, 'agent-workspace.yaml', '.env', '.gitignore']);
      const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies).toEqual({ '@indx-workspace/cli': CLI_VERSION });
      expect(output()).toContain(
        `Next: cd ${target} && pnpm install --frozen-lockfile=false && pnpm start\n`,
      );
    });
  });
}
