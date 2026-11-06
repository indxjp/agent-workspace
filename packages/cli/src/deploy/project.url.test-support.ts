import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { deployProjectEnvironment } from './project.js';
import { deploy } from './project.fixture.test-support.js';
export function defineUrlCases(): void {
  describe('the public URL (#955)', () => {
    const URL_KEY = 'AW_PUBLIC_URL=';
    const urlLines = (env: string) => env.split('\n').filter((line) => line.startsWith(URL_KEY));

    it('writes the production origin, once, after its comment, and forwards it to web', async () => {
      const { options } = await deploy();

      const { envFile } = await deployProjectEnvironment(options);

      const env = await readFile(envFile, 'utf8');
      expect(urlLines(env)).toEqual([`${URL_KEY}https://agents.acme.example`]);
      expect(env).toMatch(/^# Public https origin of this deployment .*\nAW_PUBLIC_URL=/mu);
      const compose = await readFile(
        new URL('../../templates/compose.yaml', import.meta.url),
        'utf8',
      );
      expect(compose).toContain('AW_PUBLIC_URL: ${AW_PUBLIC_URL:-}');
    });

    it('is byte-identical on a second run', async () => {
      const { options } = await deploy();
      const first = await deployProjectEnvironment(options);
      const written = await readFile(first.envFile, 'utf8');

      const second = await deployProjectEnvironment({ ...options, apply: true });

      expect(await readFile(second.envFile, 'utf8')).toBe(written);
    });

    it('follows a changed url without keeping two lines or two comments', async () => {
      const { options } = await deploy();
      await deployProjectEnvironment(options);

      const moved = await deployProjectEnvironment({
        ...options,
        project: {
          ...options.project,
          environments: {
            ...options.project.environments,
            production: {
              target: 'single-vm',
              url: 'https://moved.acme.example',
            },
          },
        },
      });

      const env = await readFile(moved.envFile, 'utf8');
      expect(urlLines(env)).toEqual(['AW_PUBLIC_URL=https://moved.acme.example']);
      expect(env.match(/^# Public https origin/gmu)).toHaveLength(1);
    });
  });
}
