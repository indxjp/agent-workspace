import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deployProjectEnvironment } from './project.js';
import { docker, deploy, isComposeUp } from './project.fixture.test-support.js';
export function defineLifecycleCases(): void {
  it('plans by default: creates the owner-only state, behind the TLS proxy, and runs no up', async () => {
    const { runner, calls } = docker();
    const { options, run } = await deploy({ runner });

    const outcome = await run();

    expect(outcome).toEqual({
      changes: true,
      applied: false,
      created: true,
      adminEmail: 'owner@acme.example',
      envFile: path.join(options.stateDirectory, '.env'),
      moduleDirectory: null,
      nextSteps: [
        'next: caddy reverse-proxy --from agents.acme.example --to 127.0.0.1:3000',
        'next: aw login --url https://agents.acme.example',
        `the Owner is owner@acme.example; the password is BOOTSTRAP_ADMIN_PASSWORD in ${path.join(options.stateDirectory, '.env')}`,
      ],
    });
    expect(calls.some(isComposeUp)).toBe(false);
    const env = await readFile(outcome.envFile, 'utf8');
    expect(env).toContain('\nPORT=127.0.0.1:3000\nAW_TRUSTED_PROXY_HOPS=1\n');
    expect(env).not.toContain('AW_TRUSTED_PROXY_HOPS=0');
    expect((await stat(options.stateDirectory)).mode % 0o1000).toBe(0o700);
    expect((await stat(path.dirname(options.stateDirectory))).mode % 0o1000).toBe(0o700);
    expect((await stat(outcome.envFile)).mode % 0o1000).toBe(0o600);
  });

  it('applies with apply, and never regenerates the secrets of an existing state', async () => {
    const { runner, calls } = docker();
    const { options } = await deploy({ runner });
    const first = await deployProjectEnvironment(options);
    const env = await readFile(first.envFile, 'utf8');

    const second = await deployProjectEnvironment({ ...options, apply: true });

    expect(second).toMatchObject({ changes: true, applied: true, created: false });
    expect(calls.filter(isComposeUp)).toHaveLength(1);
    expect(await readFile(second.envFile, 'utf8')).toBe(env);
  });
}
