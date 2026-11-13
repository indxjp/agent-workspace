import { rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PROJECT } from './gcp-fixtures.test-support.ts';
import { commandLine, type World } from './gcp-runner.test-support.ts';
import { captured, granted, scenario } from './gcp-scenario.test-support.ts';
import { destroyProjectEnvironment } from './project.js';

async function deployed(initial: Partial<World> = {}) {
  const setup = await scenario({}, initial);
  await setup.run();
  setup.calls.length = 0;
  captured.output = '';
  const destroy = (typed: string) =>
    destroyProjectEnvironment({
      project: setup.options.project,
      environment: 'production',
      stateDirectory: setup.stateDirectory,
      runner: setup.runner,
      env: {},
      fetch: granted,
      confirm: (question) => {
        captured.output += `${question}\n`;
        return Promise.resolve(typed);
      },
    });
  return { ...setup, destroy };
}

it('plans the destruction, summarises it and applies after the typed project id', async () => {
  const { destroy, calls } = await deployed();

  await destroy(PROJECT);

  const lines = calls.map(commandLine);
  const plan = lines.findIndex((line) => line.startsWith('terraform plan -destroy'));
  const apply = lines.findIndex((line) => line.startsWith('terraform apply'));
  expect(plan).toBeGreaterThan(-1);
  expect(apply).toBeGreaterThan(plan);
  expect(lines.some((line) => line.startsWith('terraform init'))).toBe(false);
  expect(captured.output).toContain('Type the Google Cloud project id to delete everything');
  expect(captured.output).toContain('Plan summary');
  expect(captured.output).toContain('cannot be deployed again in this Google Cloud project');
});

it.each([
  'Error: Error waiting for Deleting Network: resourceInUseByAnotherResource',
  "Error: The subnetwork resource 'projects/p/regions/r/subnetworks/s' is already being used by 'projects/p/regions/r/addresses/a'",
])('says the network is released later when it is still in use: %s', async (stderr) => {
  const { destroy, world } = await deployed();
  world.applyFails = `╷\n│ ${stderr}\n╵\n`;

  const failure = await destroy(PROJECT).then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain(
    'Google Cloud releases the network 1–2 hours after its services are deleted; everything else is gone. Run aw deploy destroy production again after that.',
  );
  expect(failure).not.toContain('Data protection is on');
});

it('refuses a mismatched confirmation before anything is applied', async () => {
  const { destroy, calls } = await deployed();

  await expect(destroy('acme')).rejects.toThrow('Nothing was destroyed.');

  expect(calls.map(commandLine).some((line) => line.startsWith('terraform apply'))).toBe(false);
});

it('explains data protection when Terraform refuses to delete Cloud SQL', async () => {
  const { destroy, world } = await deployed();
  world.applyFails =
    '╷\n│ Error: Error, failed to delete instance because deletion_protection is set to true\n╵\n';

  const failure = await destroy(PROJECT).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain('Data protection is on');
  expect(failure).toContain('environments.production.gcp.dataProtection: false');
  expect(failure).not.toContain('TF_VAR_data_protection');
  expect(failure).toContain('aw deploy destroy production');
});

const planOf = (
  ...changes: readonly {
    readonly type: string;
    readonly before: Record<string, unknown>;
  }[]
) =>
  JSON.stringify({
    resource_changes: changes.map(({ type, before }) => ({
      address: `${type}.x`,
      type,
      change: { actions: ['delete'], before, after: null },
    })),
  });

it.each([
  [
    'Cloud SQL still has deletion protection',
    planOf(
      { type: 'google_sql_database_instance', before: { deletion_protection: true } },
      { type: 'google_storage_bucket', before: { force_destroy: true } },
    ),
    'google_sql_database_instance.x (Cloud SQL instance)',
  ],
  [
    'a Cloud Run service has deletion protection',
    planOf({ type: 'google_cloud_run_v2_service', before: { deletion_protection: true } }),
    'google_cloud_run_v2_service.x (Cloud Run service)',
  ],
  [
    'a bucket does not force destroy',
    planOf({ type: 'google_storage_bucket', before: { force_destroy: false } }),
    'google_storage_bucket.x (storage bucket)',
  ],
])('stops before any apply when %s', async (_name, planJson, label) => {
  const { destroy, calls, world } = await deployed();
  world.planJson = planJson;

  await expect(destroy(PROJECT)).rejects.toThrow(label);

  expect(calls.map(commandLine).some((line) => line.startsWith('terraform apply'))).toBe(false);
  expect(captured.output).not.toContain('Type the Google Cloud project id');
});

it('asks for the project id and applies when nothing is protected', async () => {
  const { destroy, calls, world } = await deployed();
  world.planJson = planOf(
    { type: 'google_sql_database_instance', before: { deletion_protection: false } },
    { type: 'google_cloud_run_v2_service', before: { deletion_protection: false } },
    { type: 'google_storage_bucket', before: { force_destroy: true } },
  );

  await destroy(PROJECT);

  expect(captured.output).toContain('Type the Google Cloud project id');
  expect(calls.map(commandLine).some((line) => line.startsWith('terraform apply'))).toBe(true);
});

it('copies the images again after a destroy deleted the repository', async () => {
  const { destroy, run, calls, world } = await deployed();
  await destroy(PROJECT);
  world.stack = false;
  world.images.clear();
  calls.length = 0;

  await run();

  expect(calls.map(commandLine).filter((line) => line.includes('imagetools create'))).toHaveLength(
    5,
  );
});

it('refuses when the stack never used the managed state, as with --infra', async () => {
  const { run, options, moduleDirectory, calls } = await scenario(
    { apply: false },
    { bucket: true },
  );
  await run();
  await rm(path.join(moduleDirectory, '.aw-backend.json'), { force: true });
  calls.length = 0;

  const failure = destroyProjectEnvironment({
    project: options.project,
    environment: 'production',
    stateDirectory: options.stateDirectory,
    runner: options.runner ?? (() => Promise.reject(new Error('unused'))),
    env: {},
    fetch: granted,
    confirm: () => Promise.resolve(PROJECT),
  });

  await expect(failure).rejects.toThrow('there is nothing to destroy');
  expect(calls.map(commandLine).some((line) => /^terraform (init|plan|apply)/u.test(line))).toBe(
    false,
  );
});

it('refuses when nothing was deployed from this machine', async () => {
  const { options } = await scenario();
  await expect(
    destroyProjectEnvironment({
      project: options.project,
      environment: 'production',
      stateDirectory: options.stateDirectory,
      confirm: () => Promise.resolve(PROJECT),
    }),
  ).rejects.toThrow('Nothing was deployed from this machine');
});
