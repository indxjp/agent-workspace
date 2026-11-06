import { readFile, writeFile } from 'node:fs/promises';
import type { FeatureId } from '@indx-workspace/contracts/features';
import { describe, expect, it } from 'vitest';
import { deployProjectEnvironment } from './project.js';
import { projectFixture, deploy } from './project.fixture.test-support.js';
export function defineFeaturesCases(): void {
  describe('the project features (ADR-0160 D5, #1495)', () => {
    const FEATURES_KEY = 'AW_DEPLOYMENT_FEATURES=';

    const withFeatures = async (value: readonly FeatureId[] | undefined) => {
      const project = await projectFixture('production-single-vm.project.yaml');
      return { ...project, ...(value === undefined ? {} : { features: value }) };
    };
    const featureLines = (env: string) =>
      env.split('\n').filter((line) => line.startsWith(FEATURES_KEY));

    it('writes no line, and the same .env as before, for a project without features', async () => {
      const { options } = await deploy({ project: await withFeatures(undefined) });
      const plain = await readFile((await deployProjectEnvironment(options)).envFile, 'utf8');
      expect(featureLines(plain)).toEqual([]);

      const listed = await deployProjectEnvironment({
        ...options,
        project: await withFeatures(['chat', 'files']),
      });
      const listedEnv = await readFile(listed.envFile, 'utf8');
      expect(featureLines(listedEnv)).toEqual([`${FEATURES_KEY}chat,files`]);
      expect(listedEnv.replace(/AW_DEPLOYMENT_FEATURES=.*\n/u, '')).toBe(plain);
    });

    it('writes the features in file order, byte-identical on a second run', async () => {
      const { options } = await deploy({ project: await withFeatures(['files', 'chat']) });
      const first = await deployProjectEnvironment(options);
      const written = await readFile(first.envFile, 'utf8');
      expect(featureLines(written)).toEqual([`${FEATURES_KEY}files,chat`]);

      const second = await deployProjectEnvironment({ ...options, apply: true });

      expect(await readFile(second.envFile, 'utf8')).toBe(written);
    });

    it('follows changed features, replaces a hand-set value and removes the line when dropped', async () => {
      const { options } = await deploy({ project: await withFeatures(['chat']) });
      const first = await deployProjectEnvironment(options);
      await writeFile(
        first.envFile,
        `${await readFile(first.envFile, 'utf8')}AW_DEPLOYMENT_FEATURES=skills\n`,
      );

      const changed = await deployProjectEnvironment({
        ...options,
        project: await withFeatures(['chat', 'runs']),
      });
      const changedEnv = await readFile(changed.envFile, 'utf8');
      expect(featureLines(changedEnv)).toEqual([`${FEATURES_KEY}chat,runs`]);

      const dropped = await deployProjectEnvironment({
        ...options,
        project: await withFeatures(undefined),
      });
      const droppedEnv = await readFile(dropped.envFile, 'utf8');
      expect(featureLines(droppedEnv)).toEqual([]);
      expect(droppedEnv).toBe(changedEnv.replace(/AW_DEPLOYMENT_FEATURES=.*\n/u, ''));
    });

    it('is forwarded to the web service by the Compose template', async () => {
      const compose = await readFile(
        new URL('../../templates/compose.yaml', import.meta.url),
        'utf8',
      );
      expect(compose).toContain('AW_DEPLOYMENT_FEATURES: ${AW_DEPLOYMENT_FEATURES:-}');
    });
  });
}
