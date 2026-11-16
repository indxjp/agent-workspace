import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMainModule } from './create.js';
import { created, images } from './create-test-fixtures.test-support.js';

export function describeCreateEntry(): void {
  describe('create command entry point', () => {
    const sourceEntry = fileURLToPath(new URL('./create.ts', import.meta.url));

    it('recognizes direct and package-bin-style symlink invocations', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-entry-'));
      created.push(parent);
      const symlinkEntry = path.join(parent, 'create-agent-workspace.ts');
      const target = path.join(parent, 'generated');
      await symlink(sourceEntry, symlinkEntry, 'file');

      expect(isMainModule(sourceEntry, new URL('./create.ts', import.meta.url).href)).toBe(true);
      expect(isMainModule(symlinkEntry, new URL('./create.ts', import.meta.url).href)).toBe(true);

      const result = spawnSync(
        process.execPath,
        [symlinkEntry, target, '--cloud', 'local', '--yes'],
        {
          cwd: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
          encoding: 'utf8',
          env: {
            ...process.env,
            AW_WEB_IMAGE: images.web,
            AW_GATEWAY_IMAGE: images.gateway,
            AW_RUNNER_IMAGE: images.runner,
            AW_RUNTIME_IMAGE: images.runtime,
            AW_POSTGRES_IMAGE: images.postgres,
            AW_SEAWEEDFS_IMAGE: images.seaweedfs,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
    }, 20_000);

    /**
     * The process-level half of `cli-failure.ts`: the guard this file ends with is what stops Node's
     * default handler from printing a rejected top-level `await`. That handler renders the whole
     * `cause` chain and a stack trace, which for a probe refusal is the driver's own text — so what
     * matters here is not only the exit code but that nothing beneath the message is written.
     */
    it('exits 1 with the refusal alone, and no stack or cause chain, on stderr', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-refusal-'));
      created.push(parent);

      // The parent exists and the generator will not write into a directory it did not create, so
      // this refuses before any probe — no socket, and the same failure every time.
      const result = spawnSync(process.execPath, [sourceEntry, parent, '--cloud', 'gcp'], {
        cwd: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
        encoding: 'utf8',
        env: {
          ...process.env,
          AW_WEB_IMAGE: images.web,
          AW_GATEWAY_IMAGE: images.gateway,
          AW_RUNNER_IMAGE: images.runner,
          AW_RUNTIME_IMAGE: images.runtime,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('EEXIST');
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).not.toContain('[cause]');
      expect(result.stderr).not.toMatch(/\n\s+at /u);
    }, 20_000);

    it('runs the generator when the source module is invoked directly', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-direct-'));
      created.push(parent);
      const target = path.join(parent, 'generated');
      const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      const result = spawnSync(
        process.execPath,
        [sourceEntry, target, '--cloud', 'local', '--yes'],
        {
          cwd: repository,
          encoding: 'utf8',
          env: {
            ...process.env,
            AW_WEB_IMAGE: images.web,
            AW_GATEWAY_IMAGE: images.gateway,
            AW_RUNNER_IMAGE: images.runner,
            AW_RUNTIME_IMAGE: images.runtime,
            AW_POSTGRES_IMAGE: images.postgres,
            AW_SEAWEEDFS_IMAGE: images.seaweedfs,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
    }, 20_000);
  });
}
