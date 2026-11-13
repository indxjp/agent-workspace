import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  digest,
  fixture,
  gcpProject,
  PROJECT,
  PROVIDERS_HASH,
  REGISTRY,
  release,
  WEB_URL,
} from './gcp-fixtures.test-support.ts';
import { commandLine, milestones } from './gcp-runner.test-support.ts';
import { captured, scenario, variablesOf } from './gcp-scenario.test-support.ts';

it('runs init with -reconfigure again when the backend changes', async () => {
  const { run, calls, world, moduleDirectory } = await scenario();
  await run();
  world.planExit = 0;
  const before = calls.length;

  await run({ project: await gcpProject('other-ai') });

  const init = calls.slice(before).find((call) => commandLine(call).startsWith('terraform init'));
  expect(init?.args).toContain('-reconfigure');
  expect(init?.args).toContain('-backend-config=prefix=agent-workspace/other-ai/production');
  expect(
    JSON.parse(await readFile(path.join(moduleDirectory, '.aw-backend.json'), 'utf8')),
  ).toEqual({
    bucket: `${PROJECT}-aw-tfstate`,
    prefix: 'agent-workspace/other-ai/production',
    providers: PROVIDERS_HASH,
  });
});

it('plans an empty state with the destination references and creates nothing', async () => {
  const { run, calls, stateDirectory } = await scenario({ apply: false }, { bucket: true });

  const outcome = await run();

  expect(outcome).toMatchObject({ changes: true, applied: false });
  const lines = calls.map(commandLine);
  expect(lines.some((line) => line.startsWith('gcloud storage buckets create'))).toBe(false);
  expect(lines.some((line) => line.startsWith('terraform apply'))).toBe(false);
  expect(lines.some((line) => line.includes('imagetools create'))).toBe(false);
  expect(lines.some((line) => line.includes('-target='))).toBe(false);
  expect(milestones(calls)).toEqual(['preflight', 'init', 'plan']);
  expect(captured.output).toContain(`Would copy ${release.web} to ${REGISTRY}/web@${digest('1')}`);
  expect(captured.output).toContain('Plan summary');
  expect((await variablesOf(stateDirectory)).images).toEqual({
    web: `${REGISTRY}/web@${digest('1')}`,
    gateway: `${REGISTRY}/gateway@${digest('2')}`,
    runner: `${REGISTRY}/runner@${digest('3')}`,
    runtime: `${REGISTRY}/runtime@${digest('4')}`,
    tool_host: `${REGISTRY}/tool-host@${digest('a')}`,
  });
});

it('copies the images on --yes after a plan that pinned destinations it never copied', async () => {
  const { run, calls } = await scenario({ apply: false }, { bucket: true });
  await run();
  expect(calls.map(commandLine).some((line) => line.includes('imagetools create'))).toBe(false);
  calls.length = 0;

  await run({ apply: true });

  expect(calls.map(commandLine).filter((line) => line.includes('imagetools create'))).toHaveLength(
    5,
  );
});

it('refuses a state bucket that belongs to another project', async () => {
  const { run, calls } = await scenario({}, { bucket: true, bucketOwner: '999' });

  await expect(run()).rejects.toThrow('is taken by another project. Nothing was created.');

  expect(milestones(calls)).toEqual(['preflight']);
});

it('applies a plan with changes when a wrapper exits 0 for Terraform exit status 2', async () => {
  // Live run 41861782201: setup-terraform's terraform_wrapper exits 0 for a plan with changes,
  // and the deploy printed "Plan: 59 to add" and then "No changes" without applying anything.
  const { run, calls } = await scenario({}, { planExit: 0, planJson: await fixture('plan.json') });

  const outcome = await run();

  expect(outcome).toMatchObject({ changes: true, applied: true });
  expect(milestones(calls).slice(-3)).toEqual(['plan', 'apply', 'outputs']);
  expect(captured.output).toContain('Applied.');
  expect(captured.output).not.toContain('No changes');
  expect(outcome.nextSteps[0]).toBe(`web: ${WEB_URL}`);
});

it('reads the plan file of an exit-0 plan and reports no changes when it changes nothing', async () => {
  const { run, calls, world } = await scenario();
  await run();
  world.planExit = 0;
  const before = calls.length;

  const outcome = await run();

  expect(outcome).toMatchObject({ changes: false, applied: false });
  const second = calls.slice(before).map(commandLine);
  expect(second.filter((line) => line.startsWith('terraform show -json'))).toHaveLength(1);
  expect(second.some((line) => line.startsWith('terraform apply'))).toBe(false);
  expect(captured.output).toContain('No changes: the deployment matches agent-workspace.yaml.');
});

it('accepts the state bucket it created itself on the next run', async () => {
  // Live run 41861782201: the display of `gcloud storage buckets describe` has no project
  // number, so the re-run and the destroy refused the bucket the first run had created.
  const { run, calls } = await scenario({}, { bucket: true });

  await expect(run()).resolves.toMatchObject({ applied: true });

  const describe = calls.find((call) =>
    commandLine(call).startsWith('gcloud storage buckets describe'),
  );
  expect(describe?.args).toEqual([
    'storage',
    'buckets',
    'describe',
    `gs://${PROJECT}-aw-tfstate`,
    '--raw',
    '--format=json',
  ]);
  expect(milestones(calls)).not.toContain('bucket create');
});

it('says the state bucket would be created, and creates nothing, without --yes', async () => {
  const { run, calls, stateDirectory } = await scenario({ apply: false });

  const outcome = await run();

  expect(outcome).toMatchObject({ changes: true, applied: false, created: false });
  expect(captured.output).toContain(`gs://${PROJECT}-aw-tfstate does not exist yet`);
  expect(milestones(calls)).toEqual(['preflight']);
  await expect(access(stateDirectory)).rejects.toThrow();
});

it('refuses before anything is created when a preflight check fails', async () => {
  const { run, calls, stateDirectory } = await scenario({
    fetch: () => Promise.resolve(Response.json({ permissions: [] })),
  });

  await expect(run()).rejects.toThrow('Nothing was created.');

  expect(milestones(calls)).toEqual(['preflight']);
  await expect(access(stateDirectory)).rejects.toThrow();
});

it('reports the failed step, the first Terraform error and the re-run command', async () => {
  const { run } = await scenario(
    {},
    { applyFails: '╷\n│ Error: Error enabling service run.googleapis.com: 403\n│ \n╵\n' },
  );

  const failure = await run().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain('Enable the APIs and create the image repository failed after');
  expect(failure).toContain('Error: Error enabling service run.googleapis.com: 403');
  expect(failure).toContain('Run it again: aw deploy production --yes');
});
