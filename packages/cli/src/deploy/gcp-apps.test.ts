import type { ProjectDocument } from '@indx-workspace/contracts/project-file';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { appRoleSql } from './compose-apps.js';
import { gcpProject, REGISTRY } from './gcp-fixtures.test-support.ts';
import { commandLine } from './gcp-runner.test-support.ts';
import { captured, granted, scenario } from './gcp-scenario.test-support.ts';
import { destroyProjectEnvironment } from './project.js';

const DESK = {
  image: `ghcr.io/acme/desk@sha256:${'d1'.repeat(32)}`,
  url: 'https://desk.acme.example',
};

async function withDesk(): Promise<ProjectDocument> {
  const project = await gcpProject();
  const production = project.environments.production;
  if (production === undefined) throw new Error('no production environment');
  return {
    ...project,
    environments: {
      ...project.environments,
      production: { ...production, apps: { desk: DESK } },
    },
  };
}

const tfvarsOf = async (moduleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')) as Record<
    string,
    unknown
  >;

it('writes no apps variable while the project lists none', async () => {
  const { run, moduleDirectory } = await scenario();

  await run();

  expect(await tfvarsOf(moduleDirectory)).not.toHaveProperty('apps');
});

it('copies the app image into app-<name> by digest and writes apps with the role SQL', async () => {
  const { run, calls, moduleDirectory } = await scenario({ project: await withDesk() });

  await run();

  const copies = calls.map(commandLine).filter((line) => line.includes('imagetools create'));
  expect(copies).toContain(
    `docker buildx imagetools create --tag ${REGISTRY}/app-desk:${PLATFORM_IMAGE_VERSION} ${DESK.image}`,
  );
  const { apps } = await tfvarsOf(moduleDirectory);
  expect(apps).toEqual({
    desk: {
      image: `${REGISTRY}/app-desk@sha256:${'d1'.repeat(32)}`,
      url: DESK.url,
      role_sql: appRoleSql('app_desk', '$$'),
    },
  });
  expect(JSON.stringify(apps)).not.toContain('$$$$');
});

it('prints each app run.app URL from the apps output in the next steps', async () => {
  const { run } = await scenario(
    { project: await withDesk(), apply: true },
    { appsOutput: JSON.stringify({ desk: 'https://aw-app-desk-abc-an.a.run.app' }) },
  );

  const outcome = await run();

  expect(outcome.nextSteps).toContain('app desk: https://aw-app-desk-abc-an.a.run.app');
});

it('lists the app copy in a plan and creates nothing, yet writes the destination', async () => {
  const { run, calls, moduleDirectory } = await scenario(
    { project: await withDesk(), apply: false },
    { bucket: true },
  );

  await run();

  expect(calls.map(commandLine).some((line) => line.includes('imagetools create'))).toBe(false);
  expect(captured.output).toContain(`Would copy ${DESK.image} to ${REGISTRY}/app-desk@sha256:`);
  expect(
    ((await tfvarsOf(moduleDirectory))['apps'] as Record<string, { image: string }>)['desk']?.image,
  ).toBe(`${REGISTRY}/app-desk@sha256:${'d1'.repeat(32)}`);
});

it('keeps the apps in the variables file a destroy plans against', async () => {
  const withApp = await withDesk();
  const setup = await scenario({ project: withApp });
  await setup.run();
  const file = path.join(setup.moduleDirectory, 'terraform.tfvars.json');
  const before = await readFile(file, 'utf8');
  expect(before).toContain(`${REGISTRY}/app-desk@sha256:`);

  await expect(
    destroyProjectEnvironment({
      project: withApp,
      environment: 'production',
      stateDirectory: setup.stateDirectory,
      runner: setup.runner,
      env: {},
      fetch: granted,
      confirm: () => Promise.resolve('no'),
    }),
  ).rejects.toThrow('Nothing was destroyed.');

  expect(await readFile(file, 'utf8')).toBe(before);
});
