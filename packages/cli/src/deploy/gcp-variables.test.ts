import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  PROJECT_WEB_SECRET_SETTINGS,
  PROJECT_WEB_SETTINGS,
} from '@indx-workspace/contracts/project-file';
import { materializeCloudRunModule } from './cloud-run-module.js';
import { egressRelease, gcpProject, PROJECT, REGION } from './gcp-fixtures.test-support.ts';
import { webSettingVariables } from './gcp-project-variables.ts';
import { commandLine } from './gcp-runner.test-support.ts';
import { captured, scenario } from './gcp-scenario.test-support.ts';

it('writes data_protection, size and alerts_email when the project file sets them', async () => {
  const { run, moduleDirectory } = await scenario({
    project: await gcpProject('acme-ai', {
      dataProtection: false,
      size: 'standard',
      alertsEmail: 'ops@example.com',
    }),
  });

  await run();

  expect(
    JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
  ).toEqual({
    project_id: PROJECT,
    region: REGION,
    name: 'acme-ai',
    vertex_location: 'global',
    data_protection: false,
    size: 'standard',
    alerts_email: 'ops@example.com',
  });
});

it.each([true, false])(
  'writes sandbox_internet: %s when the project file sets it',
  async (value) => {
    const { run, moduleDirectory } = await scenario({
      project: await gcpProject('acme-ai', { sandboxInternet: value }),
      images: egressRelease,
    });

    await run();

    expect(
      JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
    ).toEqual({
      project_id: PROJECT,
      region: REGION,
      name: 'acme-ai',
      vertex_location: 'global',
      sandbox_internet: value,
    });
  },
);

it('honours a hand-written terraform.tfvars without a gcp block, with a notice', async () => {
  const project = await gcpProject();
  const production = project.environments.production;
  if (production === undefined) throw new Error('no production');
  const legacy = { target: production.target, url: production.url };
  const { run, options, moduleDirectory, calls } = await scenario(
    {
      project: { ...project, environments: { ...project.environments, production: legacy } },
      env: {},
      apply: false,
    },
    { stack: true },
  );
  await materializeCloudRunModule(options.stateDirectory);
  await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
  await writeFile(path.join(moduleDirectory, 'terraform.tfvars'), `project_id = "${PROJECT}"\n`);

  await run();

  expect(captured.output).toContain('Using project_id from terraform.tfvars or TF_VAR_project_id');
  expect(await readdir(moduleDirectory)).not.toContain('terraform.tfvars.json');
  expect(calls.map(commandLine).some((line) => line.startsWith('gcloud storage'))).toBe(false);
});

it('refuses a legacy project_id that differs from the gcp block, naming both', async () => {
  const { run, options, moduleDirectory, calls, stateDirectory } = await scenario();
  await materializeCloudRunModule(options.stateDirectory);
  await writeFile(path.join(moduleDirectory, 'terraform.tfvars'), 'project_id = "other-prod"\n');

  const failure = run();

  await expect(failure).rejects.toThrow(
    'environments.production.gcp.project is "acme-prod" but the project_id (terraform.tfvars)',
  );
  await expect(failure).rejects.toThrow('"other-prod"');
  expect(
    calls.map(commandLine).some((line) => line.startsWith('gcloud storage buckets create')),
  ).toBe(false);
  await expect(access(path.join(stateDirectory, '.env'))).rejects.toThrow();
});

it('refuses a name that terraform.tfvars or TF_VAR_name sets beside the derived one', async () => {
  const tfvars = await scenario();
  await materializeCloudRunModule(tfvars.options.stateDirectory);
  await writeFile(path.join(tfvars.moduleDirectory, 'terraform.tfvars'), 'name = "old-stack"\n');
  await expect(tfvars.run()).rejects.toThrow('"old-stack"');

  const { run } = await scenario({ env: { TF_VAR_name: 'old-stack' } });
  const failure = run();
  await expect(failure).rejects.toThrow('the name (TF_VAR_name) is "old-stack"');
  await expect(failure).rejects.toThrow('Nothing was created.');
});

it('refuses a TF_VAR_project_id that differs from the gcp block', async () => {
  const { run } = await scenario({ env: { TF_VAR_project_id: 'other-prod' } });
  await expect(run()).rejects.toThrow('"other-prod"');
});

it('writes web_settings and web_secret_settings 1:1 from gcp.settings and gcp.secretSettings', async () => {
  const { run, moduleDirectory } = await scenario({
    project: await gcpProject('acme-ai', {
      settings: {
        AW_DEMO_RUNS_PER_PERSON_PER_DAY: '3',
        AW_EMAIL_LINK_SENDER: 'noreply@example.com',
      },
      secretSettings: {
        AW_DEMO_OPERATOR_TOKEN: 'store-operator-token',
        AW_DEMO_ANTHROPIC_API_KEY: 'store-anthropic-key',
      },
    }),
  });

  await run();

  expect(
    JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
  ).toEqual({
    project_id: PROJECT,
    region: REGION,
    name: 'acme-ai',
    vertex_location: 'global',
    web_settings: {
      AW_DEMO_RUNS_PER_PERSON_PER_DAY: '3',
      AW_EMAIL_LINK_SENDER: 'noreply@example.com',
    },
    web_secret_settings: {
      AW_DEMO_OPERATOR_TOKEN: 'store-operator-token',
      AW_DEMO_ANTHROPIC_API_KEY: 'store-anthropic-key',
    },
  });
});

it('writes neither variable when the project file sets no web settings', () => {
  expect(webSettingVariables({ project: PROJECT, region: REGION, settings: {} })).toEqual({});
});

it('lets no gcp.settings or gcp.secretSettings name collide with one the module sets on web', async () => {
  const { options, moduleDirectory } = await scenario();
  await materializeCloudRunModule(options.stateDirectory);
  const main = await readFile(path.join(moduleDirectory, 'main.tf'), 'utf8');
  const list = /web_reserved_env = toset\(\[([^\]]*)\]\)/u.exec(main)?.[1] ?? '';
  const reserved = new Set(list.match(/"[A-Z0-9_]+"/gu)?.map((name) => name.slice(1, -1)));
  expect(reserved.size).toBeGreaterThan(20);
  const settable: readonly string[] = [...PROJECT_WEB_SETTINGS, ...PROJECT_WEB_SECRET_SETTINGS];
  expect(settable.filter((name) => reserved.has(name))).toEqual([]);
});
