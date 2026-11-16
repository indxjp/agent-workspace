import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWorkspace } from '../create.js';
import { deployProjectEnvironment, projectToDeploymentProfile } from './project.js';
import { images, deploy } from './project.fixture.test-support.js';
export function defineEnvironmentCases(): void {
  it('hardens .env on the next run when a first run stopped after createWorkspace', async () => {
    const { options, run } = await deploy();
    await mkdir(path.dirname(options.stateDirectory), { recursive: true, mode: 0o700 });
    await createWorkspace(options.stateDirectory, null, {
      images,
      deployState: {
        profile: projectToDeploymentProfile(options.project, 'production'),
        projectName: options.project.name,
      },
    });

    const outcome = await run();

    expect(outcome.created).toBe(false);
    const env = await readFile(outcome.envFile, 'utf8');
    expect(env).toContain('\nPORT=127.0.0.1:3000\nAW_TRUSTED_PROXY_HOPS=1\n');
    expect(env).not.toContain('AW_TRUSTED_PROXY_HOPS=0');
    expect((await stat(outcome.envFile)).mode % 0o1000).toBe(0o600);
  });

  // `$'` would be a replacement pattern if the email were passed to `replace` as a string.
  it.each(['new@acme.example', "o$'x@acme.example"])(
    're-syncs BOOTSTRAP_ADMIN to %s, touching no other line',
    async (email) => {
      const { options } = await deploy();
      const first = await deployProjectEnvironment(options);
      const before = (await readFile(first.envFile, 'utf8')).split('\n');
      const { local } = options.project.environments;
      const renamed = {
        ...options.project,
        environments: {
          ...options.project.environments,
          local: { ...local, identity: { ...local.identity, bootstrapAdmin: email } },
        },
      };

      const second = await deployProjectEnvironment({ ...options, project: renamed });

      expect(second.adminEmail).toBe(email);
      const after = (await readFile(second.envFile, 'utf8')).split('\n');
      expect(after.filter((line) => !before.includes(line))).toEqual([`BOOTSTRAP_ADMIN=${email}`]);
      expect(after).toHaveLength(before.length);
      expect((await stat(second.envFile)).mode % 0o1000).toBe(0o600);
    },
  );
}
