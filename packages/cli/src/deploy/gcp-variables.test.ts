import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { materializeCloudRunModule } from './cloud-run-module.js';
import { egressRelease, gcpProject, PROJECT, REGION } from './gcp-fixtures.test-support.ts';
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
