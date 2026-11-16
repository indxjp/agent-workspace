import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ProfileError } from '../profile.js';
import { deployProjectEnvironment } from './project.js';
import { projectFixture, docker, deploy } from './project.fixture.test-support.js';
export function defineAppsCases(): void {
  describe('environments.production.apps on single-vm (#1512)', () => {
    const DESK = {
      image: `ghcr.io/acme/desk@sha256:${'d1'.repeat(32)}`,
      url: 'https://desk.acme.example',
    };

    const withApps = async (apps: Record<string, typeof DESK> | undefined) => {
      const project = await projectFixture('production-single-vm.project.yaml');
      const production = project.environments.production;
      if (production === undefined) throw new Error('the fixture has a production environment');
      return {
        ...project,
        // A policy line is also moved to the end of `.env`; the apps' lines must not fight it.
        policy: { tools: ['orders'] },
        environments: {
          ...project.environments,
          production: { ...production, ...(apps === undefined ? {} : { apps }) },
        },
      };
    };

    const SECRET_LINE = /^AW_APP_DESK_(?:DB_PASSWORD|IDENTITY_SECRET)=[A-Za-z0-9_-]{43}$/u;

    it('a single-vm deploy with an app writes compose.apps.yaml and its secrets once', async () => {
      const { runner, calls } = docker();
      const { options } = await deploy({ runner, project: await withApps({ desk: DESK }) });

      const first = await deployProjectEnvironment(options);

      const overlayFile = path.join(options.stateDirectory, 'compose.apps.yaml');
      const overlay = await readFile(overlayFile, 'utf8');
      expect((await stat(overlayFile)).mode % 0o1000).toBe(0o600);
      const services = Object.keys(
        (parse(overlay) as { services: Record<string, unknown> }).services,
      );
      expect(services).toEqual(['app-desk-role', 'app-desk']);
      expect(overlay).toContain(`image: ${DESK.image}`);
      expect(overlay).toContain('127.0.0.1:3100:3000');
      const env = await readFile(first.envFile, 'utf8');
      const secrets = env.split('\n').filter((line) => SECRET_LINE.test(line));
      expect(secrets).toHaveLength(2);
      expect(env).toContain('\nCOMPOSE_FILE=compose.yaml:compose.apps.yaml\n');
      // No generated value reaches the overlay.
      for (const line of secrets) expect(overlay).not.toContain(line.split('=')[1]);
      expect(first.nextSteps).toContain(
        'next: caddy reverse-proxy --from desk.acme.example --to 127.0.0.1:3100',
      );
      // Compose runs with .env's COMPOSE_FILE, whatever the shell says.
      const config = calls.find(({ args }) => args.join(' ') === 'compose config --quiet');
      expect(config?.env['COMPOSE_FILE']).toBe('compose.yaml:compose.apps.yaml');

      const second = await deployProjectEnvironment(options);

      expect(await readFile(second.envFile, 'utf8')).toBe(env);
      expect(await readFile(overlayFile, 'utf8')).toBe(overlay);
    });

    it('removing the app empties the overlay, drops COMPOSE_FILE and keeps the secrets', async () => {
      const { runner, calls } = docker();
      const { options } = await deploy({
        runner,
        project: await withApps({ desk: DESK }),
        env: { COMPOSE_FILE: 'compose.yaml:other.yaml' },
      });
      const first = await deployProjectEnvironment(options);
      const secrets = (await readFile(first.envFile, 'utf8'))
        .split('\n')
        .filter((line) => SECRET_LINE.test(line));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      calls.length = 0;

      const second = await deployProjectEnvironment({
        ...options,
        project: await withApps(undefined),
      });

      const overlayFile = path.join(options.stateDirectory, 'compose.apps.yaml');
      expect(parse(await readFile(overlayFile, 'utf8'))).toEqual({ services: {} });
      const env = await readFile(second.envFile, 'utf8');
      expect(env).not.toContain('COMPOSE_FILE=');
      for (const line of secrets) expect(env).toContain(`\n${line}\n`);
      expect(stderr.mock.calls.map(([text]) => String(text))).toContain(
        'app containers app-desk are left running; aw deploy never removes them\n',
      );
      // A shell COMPOSE_FILE no longer picks the file set.
      const composeCalls = calls.filter(
        ({ args }) => args[0] === 'compose' && args[1] !== 'version',
      );
      expect(composeCalls.length).toBeGreaterThan(0);
      expect(composeCalls.every(({ env: tool }) => tool['COMPOSE_FILE'] === undefined)).toBe(true);
      expect(second.nextSteps.some((line) => line.includes('desk'))).toBe(false);
    });

    it('writes no overlay for a project that never had an app', async () => {
      const { options, run } = await deploy();
      await run();
      await expect(
        access(path.join(options.stateDirectory, 'compose.apps.yaml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses an app whose role app_<name> would pass 63 bytes, naming its path', async () => {
      const name = 'a'.repeat(60);
      const { run } = await deploy({ project: await withApps({ [name]: DESK }) });
      await expect(run()).rejects.toThrow(
        new ProfileError(
          `environments.production.apps.${name}`,
          'must be named with at most 59 characters (its database role is app_<name>)',
        ),
      );
    });
  });
}
