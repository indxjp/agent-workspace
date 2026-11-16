import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  digest,
  PASSWORD,
  PROJECT,
  PROVIDERS_HASH,
  REGION,
  REGISTRY,
  WEB_URL,
} from './gcp-fixtures.test-support.ts';
import { type StateBackend } from './gcp-lifecycle.js';
import { commandLine, milestones } from './gcp-runner.test-support.ts';
import { captured, scenario, variablesOf } from './gcp-scenario.test-support.ts';
import { showOwnerPassword } from './project.js';

it('goes from an empty state to a running stack in the documented order', async () => {
  const { run, calls, moduleDirectory, stateDirectory } = await scenario();

  const outcome = await run();

  expect(milestones(calls)).toEqual([
    'preflight',
    'bucket create',
    'bucket versioning',
    'init',
    'targeted plan',
    'apply',
    'configure docker',
    'image copy',
    'targeted plan',
    'apply',
    'plan',
    'apply',
    'outputs',
  ]);
  expect(outcome).toMatchObject({ changes: true, applied: true, created: true, moduleDirectory });
  expect(outcome.nextSteps).toEqual([
    `web: ${WEB_URL}`,
    'sign-in: Owner password (set gcp.oidc for single sign-on)',
    "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
    'owner: owner@acme.example',
    'owner password: aw deploy production --show-owner-password',
  ]);
  const lines = calls.map(commandLine);
  expect(lines).toContain(
    `gcloud storage buckets create gs://${PROJECT}-aw-tfstate --project ${PROJECT} --location ${REGION} --uniform-bucket-level-access --public-access-prevention`,
  );
  expect(lines).toContain(`gcloud storage buckets update gs://${PROJECT}-aw-tfstate --versioning`);
  expect(lines).toContain(`gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet`);
  const init = calls.find((call) => commandLine(call).startsWith('terraform init'));
  expect(init?.args).toEqual([
    `-chdir=${moduleDirectory}`,
    'init',
    '-input=false',
    '-reconfigure',
    `-backend-config=bucket=${PROJECT}-aw-tfstate`,
    '-backend-config=prefix=agent-workspace/acme-ai/production',
  ]);
  const targeted = calls.find((call) => commandLine(call).includes('-target='));
  expect(targeted?.args).toEqual(
    expect.arrayContaining([
      '-target=google_project_service.required',
      '-target=google_artifact_registry_repository.images',
      `-var-file=${path.join(stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json')}`,
    ]),
  );
  await expectInitialTerraformFiles({ moduleDirectory, stateDirectory });
  expect(captured.output).toMatch(/Terraform state bucket \.\.\.\n/u);
  expect(captured.output).toMatch(/Initialise Terraform: done in \d+ s/u);
  expect(captured.output).toContain('Plan summary');
  expect(captured.output).toContain('Applied.');
});

it('re-runs an existing stack with no bucket create, no init and an empty plan', async () => {
  const { run, calls, world } = await scenario();
  await run();
  world.planExit = 0;
  const before = calls.length;

  const outcome = await run();

  const second = calls.slice(before);
  expect(milestones(second)).toEqual(['preflight', 'plan', 'outputs']);
  expect(outcome).toMatchObject({ changes: false, applied: false });
  expect(captured.output).toContain('No changes: the deployment matches agent-workspace.yaml.');
  expect(outcome.nextSteps[0]).toBe(`web: ${WEB_URL}`);
});

it('never prints the Owner password in its default output, and prints only it on request', async () => {
  const { run, options } = await scenario();

  const outcome = await run();

  expect(captured.output).not.toContain(PASSWORD);
  expect(outcome.nextSteps.join('\n')).not.toContain(PASSWORD);
  captured.output = '';
  const password = await showOwnerPassword(options);
  expect(password).toBe(PASSWORD);
  expect(captured.output).toBe('');
});

async function expectInitialTerraformFiles({
  moduleDirectory,
  stateDirectory,
}: {
  readonly moduleDirectory: string;
  readonly stateDirectory: string;
}): Promise<void> {
  expect(
    JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
  ).toEqual({
    project_id: PROJECT,
    region: REGION,
    name: 'acme-ai',
    vertex_location: 'global',
  });
  const recorded: StateBackend = JSON.parse(
    await readFile(path.join(moduleDirectory, '.aw-backend.json'), 'utf8'),
  ) as StateBackend;
  expect(recorded).toEqual({
    bucket: `${PROJECT}-aw-tfstate`,
    prefix: 'agent-workspace/acme-ai/production',
    providers: PROVIDERS_HASH,
  });
  expect((await variablesOf(stateDirectory)).images['web']).toBe(`${REGISTRY}/web@${digest('1')}`);
}
