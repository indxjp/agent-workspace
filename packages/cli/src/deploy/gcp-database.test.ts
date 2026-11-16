import { expect, it, vi } from 'vitest';
import { commandLine, DATABASE_TARGET } from './gcp-runner.test-support.ts';
import { captured, scenario } from './gcp-scenario.test-support.ts';
import type { ToolInvocation, ToolRunner } from './runner.js';

const isCopy = (call: ToolInvocation) =>
  commandLine(call).startsWith('docker buildx imagetools create');

const isFullPlan = (call: ToolInvocation) =>
  commandLine(call).startsWith('terraform plan') && !commandLine(call).includes('-target=');

const isDatabasePlan = (call: ToolInvocation) =>
  commandLine(call).startsWith('terraform plan') && call.args.includes(DATABASE_TARGET);

/** A gate the test opens: `open` resolves `promise`. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function failureOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => 'the deploy succeeded',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

it('starts the Cloud SQL apply before the copies finish, and the full apply only after both', async () => {
  const database = gate();
  const copies = gate();
  const events: string[] = [];
  let copiesStarted = 0;
  let databaseApplying = false;
  const setup = await scenario({}, { databaseApplyGate: database.promise });
  const runner: ToolRunner = async (invocation) => {
    const line = commandLine(invocation);
    if (isCopy(invocation)) {
      copiesStarted += 1;
      await copies.promise;
      events.push('copy finished');
    }
    if (isFullPlan(invocation)) events.push('full plan');
    const databaseApply =
      line.startsWith('terraform apply') &&
      (setup.world.lastPlanTargets ?? []).includes(DATABASE_TARGET);
    if (databaseApply) databaseApplying = true;
    const result = await setup.runner(invocation);
    if (databaseApply) events.push('Cloud SQL applied');
    return result;
  };

  const run = setup.run({ runner });
  await vi.waitFor(() => {
    expect(copiesStarted).toBe(5);
    expect(databaseApplying).toBe(true);
  });
  expect(events).toEqual([]);

  copies.open();
  await vi.waitFor(() => expect(events).toHaveLength(5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(Array.from({ length: 5 }, () => 'copy finished'));

  database.open();
  const outcome = await run;

  expect(outcome).toMatchObject({ changes: true, applied: true });
  expect(events.slice(5)).toEqual(['Cloud SQL applied', 'full plan']);
  expect(captured.output).toContain(
    'Create Cloud SQL and its private network while the images copy ...',
  );
  for (const name of ['web', 'gateway', 'runner', 'runtime', 'tool-host']) {
    expect(captured.output).toContain(`Copied ${name}.`);
  }
  expect(captured.output).toContain('Cloud SQL apply complete!');
});

it('reports a failed copy with what the Cloud SQL apply created, and applies nothing else', async () => {
  const { run, calls, world } = await scenario({}, { copyFails: 'denied: permission\n' });

  const failure = await failureOf(run);

  expect(failure).toContain('Copy the release images failed after');
  expect(failure).toContain(
    'Cloud SQL and its private network were created while the images copied. ' +
      'The rest of the stack was not applied.',
  );
  expect(failure).not.toContain('Nothing was applied.');
  expect(world.database).toBe(true);
  expect(calls.some(isFullPlan)).toBe(false);
});

it('reports a failed Cloud SQL apply after the copies, and applies nothing else', async () => {
  const { run, calls } = await scenario(
    {},
    { databaseApplyFails: '╷\n│ Error: Error, failed to create instance acme-ai-pg: 409\n╵\n' },
  );

  const failure = await failureOf(run);

  expect(failure).toContain(
    'Create Cloud SQL and its private network while the images copy failed after',
  );
  expect(failure).toContain('Error: Error, failed to create instance acme-ai-pg: 409');
  expect(failure).toContain(
    'The release images were copied. The rest of the stack was not applied.',
  );
  expect(calls.filter(isCopy)).toHaveLength(5);
  expect(calls.some(isFullPlan)).toBe(false);
});

it('reports both failures when the copy and the Cloud SQL apply fail', async () => {
  const { run, calls } = await scenario(
    {},
    {
      copyFails: 'denied: permission\n',
      databaseApplyFails: 'Error: Error waiting for Create Service Networking Connection\n',
    },
  );

  const failure = await failureOf(run);

  expect(failure).toContain(
    'Create Cloud SQL and its private network while the images copy failed after',
  );
  expect(failure).toContain('Error waiting for Create Service Networking Connection');
  expect(failure).toContain('Copy the release images failed after');
  expect(failure).toContain(
    'The Cloud SQL apply may have created part of its network. ' +
      'The rest of the stack was not applied.',
  );
  expect(calls.some(isFullPlan)).toBe(false);
});

it('runs no Cloud SQL apply without --yes, nor once the instance is in the state', async () => {
  const { run, calls, world } = await scenario({ apply: false }, { bucket: true });
  await run();
  expect(calls.some((call) => commandLine(call).startsWith('terraform state list'))).toBe(false);

  await run({ apply: true });
  expect(calls.filter(isDatabasePlan)).toHaveLength(1);
  expect(world.database).toBe(true);
  const before = calls.length;

  await run({ apply: true });

  const again = calls.slice(before);
  expect(again.map(commandLine)).toContain('terraform state list');
  expect(again.some(isDatabasePlan)).toBe(false);
  expect(again.some(isFullPlan)).toBe(true);
});

// Run 42577620759: the full apply waited 60 s for the Secret Manager service agent before the
// key's grant, and the runner manager and web waited for that grant. The first deploy now applies
// the grant (and the wait) beside Cloud SQL, so the full apply finds it done.
it('applies the Secret Manager key grant beside Cloud SQL, in the same targeted plan', async () => {
  const { run, calls } = await scenario({});
  await run();

  const plans = calls.filter(isDatabasePlan);
  expect(plans).toHaveLength(1);
  const targets = plans[0]?.args.filter((argument) => argument.startsWith('-target='));
  expect(targets).toEqual([
    DATABASE_TARGET,
    '-target=google_kms_crypto_key_iam_member.secret_manager',
  ]);
});
