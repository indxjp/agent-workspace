import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolInvocation, ToolRunner } from './runner.js';
import { projectFixture, temporary, deploy } from './project.fixture.test-support.js';
export function defineVercelCases(): void {
  describe('the vercel target (#830)', () => {
    const vercelEnv = { VERCEL_TOKEN: 'tok-not-printed', VERCEL_TEAM_ID: 'team_acme' };

    /** Vercel answering that no project exists yet; every call is recorded. */
    function vercel() {
      const calls: ToolInvocation[] = [];
      const runner: ToolRunner = (invocation) => {
        calls.push(invocation);
        return Promise.resolve(
          invocation.args[1] === 'inspect'
            ? { status: 1, stdout: '', stderr: 'Error: Project not found' }
            : { status: 0, stdout: '', stderr: '' },
        );
      };
      return { runner, calls };
    }

    const inspected = (calls: readonly ToolInvocation[]) =>
      calls.filter(({ args }) => args[1] === 'inspect').map(({ args }) => args[2]);

    it('plans AW_PUBLIC_URL for the control plane alone (#955)', async () => {
      const { runner } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
      });

      await run();

      const lines = vi
        .spyOn(process.stdout, 'write')
        .mock.calls.map(([text]) => String(text))
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('Vercel project '));
      const carrying = lines.filter((line) => line.includes('AW_PUBLIC_URL'));
      expect(carrying).toHaveLength(1);
      expect(carrying[0]).toContain('Vercel project acme-ai (control plane');
    });

    it('names the Vercel projects after the project, not the state directory', async () => {
      const { runner, calls } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
      });

      await run();

      expect(inspected(calls)).toEqual(['acme-ai-gateway', 'acme-ai-manager', 'acme-ai']);
    });

    it('deploys the web/ frontend as a project of its own, wired to the project url', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-project-'));
      temporary.push(directory);
      await mkdir(path.join(directory, 'web'));
      await writeFile(path.join(directory, 'web', 'package.json'), '{}\n');
      const { runner, calls } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
        projectDirectory: directory,
      });

      await run();

      expect(inspected(calls)).toEqual([
        'acme-ai-gateway',
        'acme-ai-manager',
        'acme-ai',
        'acme-ai-web',
      ]);
      const output = vi
        .spyOn(process.stdout, 'write')
        .mock.calls.map(([text]) => String(text))
        .join('');
      expect(output).toContain('VITE_AW_BASE_URL');
    });

    it('names the frontend origin to allow only when the project has a web/ frontend', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-project-'));
      temporary.push(directory);
      const project = await projectFixture('production-vercel.project.yaml');
      const allowed = (steps: readonly string[]) =>
        steps.some((step) => step.includes('allowedOrigins'));

      const without = await deploy({
        project,
        runner: vercel().runner,
        env: vercelEnv,
        projectDirectory: directory,
      });
      expect(allowed((await without.run()).nextSteps)).toBe(false);

      await mkdir(path.join(directory, 'web'));
      await writeFile(path.join(directory, 'web', 'package.json'), '{}\n');
      const withFrontend = await deploy({
        project,
        runner: vercel().runner,
        env: vercelEnv,
        projectDirectory: directory,
      });
      const [first] = (await withFrontend.run()).nextSteps;
      expect(first).toContain('the control plane allows https://acme-ai-web.vercel.app;');
    });

    it('refuses --infra by name, since it deploys the checkout in AGENT_WORKSPACE_SOURCE', async () => {
      const { runner, calls } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
        infraDirectory: '/somewhere/infra',
      });

      await expect(run()).rejects.toThrow('--infra is for the gcp-cloudrun and kubernetes targets');
      expect(calls).toEqual([]);
    });
  });
}
