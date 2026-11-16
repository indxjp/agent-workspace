import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorkspace, DEFAULT_ANSWERS, shellArgument } from './create.js';
import { created, images, options } from './create-test-fixtures.test-support.js';

export function describeCreatePrompts(): void {
  describe('no person, no prompt (#879)', () => {
    const sourceEntry = fileURLToPath(new URL('./create.ts', import.meta.url));
    const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const generatorEnvironment = {
      ...process.env,
      AW_WEB_IMAGE: images.web,
      AW_GATEWAY_IMAGE: images.gateway,
      AW_RUNNER_IMAGE: images.runner,
      AW_RUNTIME_IMAGE: images.runtime,
      AW_POSTGRES_IMAGE: images.postgres,
      AW_SEAWEEDFS_IMAGE: images.seaweedfs,
    };
    /** Far under the 10 s silence the old piped-answers reader waited out. */
    const FAST_MS = 5_000;

    async function freshTarget(): Promise<string> {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-stdin-'));
      created.push(parent);
      return path.join(parent, 'generated');
    }

    /**
     * Runs `create` as a process whose stdin is a pipe the parent holds open and never writes to or
     * closes, as a CI step or an agent harness does. It must finish by itself.
     */
    async function runWithStdinHeldOpen(
      args: readonly string[],
      env: Readonly<Record<string, string | undefined>> = {},
    ) {
      const child = spawn(process.execPath, [sourceEntry, ...args], {
        cwd: repositoryRoot,
        env: { ...generatorEnvironment, CI: 'true', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const started = Date.now();
      const status = await new Promise<number | null>((resolve) => {
        const giveUp = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.once('close', (code) => {
          clearTimeout(giveUp);
          resolve(code);
        });
      });
      return { status, stdout, stderr, elapsed: Date.now() - started };
    }

    /** The defaults generate the local-filesystem Compose project, with no object-store profile. */
    async function expectDefaultProject(target: string): Promise<void> {
      const env = await readFile(path.join(target, '.env'), 'utf8');
      expect(env).not.toMatch(/^COMPOSE_PROFILES=.*object-storage/mu);
      expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
    }

    it('labels the defaults as what the Compose project runs, and still accepts the old wording', async () => {
      expect(DEFAULT_ANSWERS).toMatchObject({
        database: 'PostgreSQL 18 (container)',
        storage: 'local filesystem (Docker volume)',
      });
      const legacy = await freshTarget();
      await createWorkspace(
        legacy,
        { ...DEFAULT_ANSWERS, database: 'PostgreSQL', storage: 'local filesystem' },
        options,
      );
      await expectDefaultProject(legacy);
    });

    // ADR-0159: a new deployment runs 18, and giving 18 to an operator who asked for 17 would be a
    // data migration they never agreed to.
    it.each(['PostgreSQL 17', 'PostgreSQL 17 (container)', 'embedded PostgreSQL 17'])(
      'refuses the PostgreSQL 17 answer %j by name instead of deploying 18',
      async (database) => {
        const target = await freshTarget();
        await expect(
          createWorkspace(target, { ...DEFAULT_ANSWERS, database }, options),
        ).rejects.toThrow(/New Compose deployments run PostgreSQL 18/u);
        expect(existsSync(path.join(target, 'compose.yaml'))).toBe(false);
      },
    );

    it('--cloud local --yes finishes with stdin held open and CI set, reading none of it', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target, '--cloud', 'local', '--yes']);
      expect(run.status, run.stderr).toBe(0);
      expect(run.elapsed).toBeLessThan(FAST_MS);
      await expectDefaultProject(target);
    }, 20_000);

    it('--cloud local without --yes takes the flags and the defaults with stdin held open', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([
        target,
        '--cloud',
        'local',
        '--storage',
        'SeaweedFS',
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.elapsed).toBeLessThan(FAST_MS);
      expect(await readFile(path.join(target, '.env'), 'utf8')).toMatch(
        /^COMPOSE_PROFILES=.*object-storage/mu,
      );
    }, 20_000);

    it('does not read piped answers any more: the lines are not answers', async () => {
      const target = await freshTarget();
      const result = spawnSync(process.execPath, [sourceEntry, target, '--cloud', 'local'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...generatorEnvironment, CI: 'true' },
        input: 'PostgreSQL\nSeaweedFS\ndocker\nlocal administrator\n',
      });
      expect(result.status, result.stderr).toBe(0);
      await expectDefaultProject(target);
    }, 20_000);

    it('takes its answers from the flags: --storage SeaweedFS changes the profile', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([
        target,
        '--cloud',
        'local',
        '--yes',
        '--database',
        'PostgreSQL',
        '--storage',
        'SeaweedFS',
        '--runtime',
        'docker',
        '--auth',
        'local administrator',
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(await readFile(path.join(target, '.env'), 'utf8')).toMatch(
        /^COMPOSE_PROFILES=.*object-storage/mu,
      );
    }, 20_000);

    it.each([
      ['--storage', 'MinIO', /no longer bundles MinIO/u],
      ['--storage', 'tape', /Unsupported storage "tape"/u],
      ['--database', 'mysql', /Unsupported database "mysql"/u],
      ['--runtime', 'kubernetes', /Unsupported runtime "kubernetes"/u],
      ['--auth', 'sso', /Unsupported authentication "sso"/u],
    ])(
      '%s %s exits 2 and writes nothing',
      async (flag, value, message) => {
        const target = await freshTarget();
        const run = await runWithStdinHeldOpen([target, '--cloud', 'local', '--yes', flag, value]);
        expect(run.status).toBe(2);
        expect(run.stderr).toMatch(message);
        expect(existsSync(target)).toBe(false);
      },
      20_000,
    );

    it('--cloud gcp --storage x is refused before anything is generated', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target, '--cloud', 'gcp', '--storage', 'x']);
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/answer the questions of --cloud local/u);
      expect(existsSync(target)).toBe(false);
    }, 20_000);

    it('<dir> --yes finishes with stdin held open and CI set, and asks nothing', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target, '--yes', '--no-install']);
      expect(run.status, run.stderr).toBe(0);
      expect(run.elapsed).toBeLessThan(FAST_MS);
      expect(run.stdout).not.toContain('?');
      expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
    }, 20_000);

    it('<dir> with no flag finishes with stdin held open, using the recommended answers', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.elapsed).toBeLessThan(FAST_MS);
      expect(run.stderr).toContain('no terminal: used the recommended answers');
    }, 20_000);

    it('--yes with an endpoint provider and no URL exits 2 naming the flag, and writes nothing', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target, '--yes', '--provider', 'openai-compatible']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('--model-base-url');
      expect(run.stderr).toContain('fix: add --model-base-url <url>');
      expect(existsSync(target)).toBe(false);
    }, 20_000);

    it('the same without --yes and without a person exits 2 as well', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target, '--provider', 'azure-openai']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('fix: add --model-base-url <url>');
      expect(existsSync(target)).toBe(false);
    }, 20_000);

    it('writes the project once the endpoint is given', async () => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([
        target,
        '--yes',
        '--no-install',
        '--provider',
        'openai-compatible',
        '--model-base-url',
        'https://models.example.com/v1',
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).toContain(
        'https://models.example.com/v1',
      );
    }, 20_000);

    // `script` allocates a pseudo-terminal, which is what a CI runner with `tty: true` hands a job.
    it.skipIf(process.platform !== 'linux')(
      'asks nothing on a pseudo-terminal when CI is set',
      async () => {
        const target = await freshTarget();
        const result = spawnSync(
          'script',
          [
            '-qec',
            `${shellArgument(process.execPath, 'linux')} ${shellArgument(sourceEntry, 'linux')} ${shellArgument(target, 'linux')} --yes --no-install`,
            '/dev/null',
          ],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: { ...process.env, CI: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toMatch(/\? /u);
        expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
      },
      30_000,
    );

    // Without --yes the pseudo-terminal reaches terminalFor, so this fails if it ignores CI.
    it.skipIf(process.platform !== 'linux')(
      'uses the recommended answers on a pseudo-terminal when CI is set, even without --yes',
      async () => {
        const target = await freshTarget();
        const result = spawnSync(
          'script',
          [
            '-qec',
            `${shellArgument(process.execPath, 'linux')} ${shellArgument(sourceEntry, 'linux')} ${shellArgument(target, 'linux')} --no-install --no-start`,
            '/dev/null',
          ],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: { ...process.env, CI: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toMatch(/\? /u);
        // Under `script`, stderr is merged into the pseudo-terminal output on stdout.
        expect(result.stdout + result.stderr).toContain(
          'no terminal: used the recommended answers',
        );
        expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
      },
      30_000,
    );
  });
}
