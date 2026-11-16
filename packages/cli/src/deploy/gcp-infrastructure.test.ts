import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { DeploymentImages } from '../deployment.js';
import {
  digest,
  gcpProject,
  PROJECT,
  REGION,
  REGISTRY,
  release,
} from './gcp-fixtures.test-support.ts';
import { expectedImageRegistry } from './gcp-lifecycle.js';
import { commandLine } from './gcp-runner.test-support.ts';
import { home, scenario } from './gcp-scenario.test-support.ts';

it('leaves a --infra checkout untouched, passing the gcp block as variables', async () => {
  const checkout = await home();
  const module = path.join(checkout, 'terraform', 'gcp-cloudrun');
  await mkdir(path.join(module, '.terraform'), { recursive: true });
  await writeFile(path.join(module, 'main.tf'), '');
  const copied: DeploymentImages = {
    ...release,
    web: `${REGISTRY}/web@${digest('1')}`,
    gateway: `${REGISTRY}/gateway@${digest('2')}`,
    runner: `${REGISTRY}/runner@${digest('3')}`,
    runtime: `${REGISTRY}/runtime@${digest('4')}`,
    toolHost: `${REGISTRY}/tool-host@${digest('a')}`,
  };
  const { run, calls } = await scenario(
    { infraDirectory: checkout, apply: false, images: copied },
    { stack: true },
  );
  const before = await readdir(module);

  await run();

  expect(await readdir(module)).toEqual(before);
  const lines = calls.map(commandLine);
  expect(lines.some((line) => line.startsWith('gcloud storage buckets'))).toBe(false);
  expect(lines.some((line) => line.startsWith('terraform init'))).toBe(false);
  const plan = calls.find((call) => commandLine(call).startsWith('terraform plan'));
  expect(plan?.env['TF_VAR_project_id']).toBe(PROJECT);
  expect(plan?.env['TF_VAR_region']).toBe(REGION);
});

it('passes gcp.sandboxInternet to a --infra checkout', async () => {
  const checkout = await home();
  const module = path.join(checkout, 'terraform', 'gcp-cloudrun');
  await mkdir(path.join(module, '.terraform'), { recursive: true });
  await writeFile(path.join(module, 'main.tf'), '');
  const copied: DeploymentImages = {
    ...release,
    web: `${REGISTRY}/web@${digest('1')}`,
    gateway: `${REGISTRY}/gateway@${digest('2')}`,
    runner: `${REGISTRY}/runner@${digest('3')}`,
    runtime: `${REGISTRY}/runtime@${digest('4')}`,
    toolHost: `${REGISTRY}/tool-host@${digest('a')}`,
    egressProxy: `${REGISTRY}/egress-proxy@${digest('7')}`,
  };
  const { run, calls } = await scenario(
    {
      project: await gcpProject('acme-ai', { sandboxInternet: true }),
      infraDirectory: checkout,
      apply: false,
      images: copied,
    },
    { stack: true },
  );

  await run();

  const plan = calls.find((call) => commandLine(call).startsWith('terraform plan'));
  expect(plan?.env['TF_VAR_sandbox_internet']).toBe('true');
});

it.each([
  [
    'terraform.tfvars',
    'project_id = "other-prod"\n',
    'project_id (terraform.tfvars) is "other-prod"',
  ],
  ['prod.auto.tfvars', 'region = "europe-west1"\n', 'region (prod.auto.tfvars) is "europe-west1"'],
])(
  'refuses a --infra checkout whose %s names another project or region',
  async (file, text, message) => {
    const checkout = await home();
    const module = path.join(checkout, 'terraform', 'gcp-cloudrun');
    await mkdir(path.join(module, '.terraform'), { recursive: true });
    await writeFile(path.join(module, 'main.tf'), '');
    await writeFile(path.join(module, file), text);
    const { run, calls } = await scenario({ infraDirectory: checkout, apply: false });

    await expect(run()).rejects.toThrow(message);

    expect(calls.map(commandLine).some((line) => line.startsWith('terraform plan'))).toBe(false);
  },
);

it('keeps the registry formula equal to outputs.tf and the module default name', async () => {
  const module = new URL('../../../../infra/terraform/gcp-cloudrun/', import.meta.url);
  const outputs = await readFile(new URL('outputs.tf', module), 'utf8');
  const main = await readFile(new URL('main.tf', module), 'utf8');
  const variables = await readFile(new URL('variables.tf', module), 'utf8');

  expect(outputs).toContain(
    'value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"',
  );
  expect(main).toMatch(
    /resource "google_artifact_registry_repository" "images" \{[^}]*repository_id = var\.name/u,
  );
  expect(variables).toMatch(/variable "name" \{[^}]*default\s+=\s+"agent-workspace"/u);
  expect(expectedImageRegistry({ project: PROJECT, region: REGION }, 'acme-ai')).toBe(REGISTRY);
  expect(expectedImageRegistry({ project: PROJECT, region: REGION }, 'staging')).toBe(
    `${REGION}-docker.pkg.dev/${PROJECT}/staging`,
  );
});
