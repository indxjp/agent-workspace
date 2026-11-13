import { readFile, writeFile } from 'node:fs/promises';
import { ProjectPolicySchema, type ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import { deployProjectEnvironment } from './project.js';
import { projectFixture, deploy } from './project.fixture.test-support.js';
export function definePolicyCases(): void {
  describe('the project policy (#797)', () => {
    const policy: ProjectPolicy = {
      promotion: { minEvalScore: 0.9 },
      models: ["o'brien-$1 #model"],
      tools: ['orders'],
    };
    const POLICY_KEY = 'AW_DEPLOYMENT_POLICY=';

    const withPolicy = async (value: ProjectPolicy | undefined) => {
      const project = await projectFixture('production-single-vm.project.yaml');
      return { ...project, ...(value === undefined ? {} : { policy: value }) };
    };
    const policyLines = (env: string) =>
      env.split('\n').filter((line) => line.startsWith(POLICY_KEY));

    it('writes the promotion bar into the deployment, canonical and single-quoted', async () => {
      const { options } = await deploy({
        project: await withPolicy({ promotion: { minEvalScore: 0.9 } }),
      });

      const { envFile } = await deployProjectEnvironment(options);

      expect(policyLines(await readFile(envFile, 'utf8'))).toEqual([
        `${POLICY_KEY}'{"promotion":{"minEvalScore":0.9}}'`,
      ]);
    });

    it('writes a value the deployment parses back to exactly the project policy', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });

      const { envFile } = await deployProjectEnvironment(options);

      const [line] = policyLines(await readFile(envFile, 'utf8'));
      const quoted = line?.slice(POLICY_KEY.length) ?? '';
      expect(quoted).toMatch(/^'.*'$/u);
      const value = quoted.slice(1, -1);
      expect(value).not.toContain("'");
      expect(ProjectPolicySchema.parse(JSON.parse(value))).toEqual(policy);
    });

    it('is byte-identical on a second run', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });
      const first = await deployProjectEnvironment(options);
      const written = await readFile(first.envFile, 'utf8');

      const second = await deployProjectEnvironment({ ...options, apply: true });

      expect(await readFile(second.envFile, 'utf8')).toBe(written);
    });

    it('follows a changed policy and removes the line when the project drops it', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });
      await deployProjectEnvironment(options);

      const tightened = await deployProjectEnvironment({
        ...options,
        project: await withPolicy({ promotion: { minEvalScore: 1 } }),
      });
      const tightenedEnv = await readFile(tightened.envFile, 'utf8');
      expect(policyLines(tightenedEnv)).toEqual([
        `${POLICY_KEY}'{"promotion":{"minEvalScore":1}}'`,
      ]);

      const dropped = await deployProjectEnvironment({
        ...options,
        project: await withPolicy(undefined),
      });
      const droppedEnv = await readFile(dropped.envFile, 'utf8');
      expect(policyLines(droppedEnv)).toEqual([]);
      expect(droppedEnv).toBe(tightenedEnv.replace(/AW_DEPLOYMENT_POLICY=.*\n/u, ''));
    });

    it('replaces a hand-set value rather than keeping two', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });
      const first = await deployProjectEnvironment(options);
      await writeFile(
        first.envFile,
        `${await readFile(first.envFile, 'utf8')}AW_DEPLOYMENT_POLICY={}\n`,
      );

      const second = await deployProjectEnvironment(options);

      expect(policyLines(await readFile(second.envFile, 'utf8'))).toHaveLength(1);
    });

    it('is forwarded to the web service by the Compose template', async () => {
      const compose = await readFile(
        new URL('../../templates/compose.yaml', import.meta.url),
        'utf8',
      );
      expect(compose).toContain('AW_DEPLOYMENT_POLICY: ${AW_DEPLOYMENT_POLICY:-}');
    });
  });
}
