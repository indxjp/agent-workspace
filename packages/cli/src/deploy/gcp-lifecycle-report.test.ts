import { expect, it } from 'vitest';
import { deployRerunCommand, lifecycleStep } from './gcp-lifecycle.js';
import { createRedactor } from './redact.js';
import type { DeployContext } from './steps.js';

it('prints the step and its elapsed time, and reports a failure with the re-run command', async () => {
  const lines: string[] = [];
  const context: DeployContext = {
    runner: () => Promise.reject(new Error('unused')),
    directory: '/project',
    env: {},
    cloud: 'gcp',
    out: (text) => lines.push(text),
    err: () => undefined,
  };

  await lifecycleStep(context, 'Step one', () => Promise.resolve());
  const failure = lifecycleStep(context, 'Step two', (step) => {
    step.err('╷\n│ Error: it broke postgres://ops:hunter22@db.example/aw\n╵\n');
    return Promise.reject(new Error('exit status 1'));
  });

  await expect(failure).rejects.toThrow('Step two failed after');
  await expect(failure).rejects.toThrow('Error: it broke postgres://***@db.example/aw');
  await expect(failure).rejects.toThrow('Run it again: aw deploy production --yes');
  expect(lines.join('')).toMatch(/Step one \.\.\.\nStep one: done in \d+ s\n/u);
});

it('masks the quoted error with the redactor it is given', async () => {
  const context: DeployContext = {
    runner: () => Promise.reject(new Error('unused')),
    directory: '/project',
    env: {},
    cloud: 'gcp',
    out: () => undefined,
    err: () => undefined,
  };

  const failure = lifecycleStep(
    context,
    'Plan and apply',
    (step) => {
      step.err('Error: the value S3cretPassw0rd-XYZ was refused\n');
      return Promise.reject(new Error('exit status 1'));
    },
    { redact: createRedactor({ SECRET: 'S3cretPassw0rd-XYZ' }) },
  );

  await expect(failure).rejects.toThrow('Error: the value *** was refused');
  await expect(failure).rejects.not.toThrow('S3cretPassw0rd');
});

it('quotes the thrown error, not an earlier warning, and re-runs a plan without --yes', async () => {
  const context: DeployContext = {
    runner: () => Promise.reject(new Error('unused')),
    directory: '/project',
    env: {},
    cloud: 'gcp',
    out: () => undefined,
    err: () => undefined,
  };

  const failure = lifecycleStep(
    context,
    'Check',
    (step) => {
      step.err('WARNING: org-policies describe failed\n');
      return Promise.reject(new Error('The Google Cloud checks failed.'));
    },
    { rerun: deployRerunCommand(false), quoteError: true },
  );

  await expect(failure).rejects.toThrow('failed after');
  await expect(failure).rejects.toThrow(/: The Google Cloud checks failed\./u);
  await expect(failure).rejects.not.toThrow('WARNING');
  await expect(failure).rejects.toThrow(/Run it again: aw deploy production$/u);
});
