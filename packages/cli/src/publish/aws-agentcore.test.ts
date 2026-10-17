import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { awsAgentcore, dryRunHasChanges } from './aws-agentcore.ts';
import type { ToolInvocation, ToolResult, ToolRunner } from '../deploy/runner.ts';
import { testContext } from './test-support.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), 'utf8');
}

const DEPLOY_DRY_RUN = (target: string): string[] => [
  'deploy',
  '--target',
  target,
  '--dry-run',
  '--json',
];

/** `deploy` answers by whether `--dry-run` is present; `validate` can be made to fail. */
function setup(
  dryRun: string,
  options: { apply?: boolean; environment?: string; validateStatus?: number } = {},
) {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = (invocation) => {
    calls.push(invocation);
    const [command] = invocation.args;
    const result: Partial<ToolResult> =
      command === '--version'
        ? { stdout: '0.9.0\n' }
        : command === 'validate'
          ? { status: options.validateStatus ?? 0 }
          : { stdout: invocation.args.includes('--dry-run') ? dryRun : '{"success":true}' };
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...result });
  };
  const { context } = testContext(runner, {
    platform: 'aws-agentcore',
    directory: '/work/platforms/export',
    apply: options.apply ?? false,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return { context, calls };
}

describe('aws-agentcore executor', () => {
  it('plans with validate then a deploy dry run, and applies nothing without apply', async () => {
    const { context, calls } = setup(await fixture('agentcore-dry-run-changes.json'));

    const outcome = await awsAgentcore.publish(context, {});

    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['validate', '-d', '.'],
      DEPLOY_DRY_RUN('default'),
    ]);
    expect(calls.every((call) => call.cwd === '/work/platforms/export')).toBe(true);
    expect(outcome).toEqual({ changes: true, applied: false, nextSteps: [] });
  });

  it('applies with deploy -y --json after the plan and points at status', async () => {
    const { context, calls } = setup(await fixture('agentcore-dry-run-changes.json'), {
      apply: true,
    });

    const outcome = await awsAgentcore.publish(context, {});

    expect(calls.at(-1)?.args).toEqual(['deploy', '--target', 'default', '-y', '--json']);
    expect(outcome).toEqual({
      changes: true,
      applied: true,
      nextSteps: ['agentcore status --target default --json'],
    });
  });

  it('maps --env to --target', async () => {
    const { context, calls } = setup(await fixture('agentcore-dry-run-changes.json'), {
      apply: true,
      environment: 'staging',
    });

    await awsAgentcore.publish(context, {});

    expect(calls.map((call) => call.args).slice(2)).toEqual([
      DEPLOY_DRY_RUN('staging'),
      ['deploy', '--target', 'staging', '-y', '--json'],
    ]);
  });

  it('does not deploy when the dry run reports no changes, even with apply', async () => {
    const { context, calls } = setup(await fixture('agentcore-dry-run-none.json'), {
      apply: true,
    });

    const outcome = await awsAgentcore.publish(context, {});

    expect(calls).toHaveLength(3);
    expect(outcome).toEqual({ changes: false, applied: false, nextSteps: [] });
  });

  it('stops before deploy when validate fails', async () => {
    const { context, calls } = setup('{}', { validateStatus: 1, apply: true });

    await expect(awsAgentcore.publish(context, {})).rejects.toThrow(/validate/u);
    expect(calls.map((call) => call.args[0])).toEqual(['--version', 'validate']);
  });

  it('strips the compile options that share the merged settings', async () => {
    const { context, calls } = setup(await fixture('agentcore-dry-run-changes.json'));

    await awsAgentcore.publish(context, { region: 'us-east-1', accountId: '123456789012' });

    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['validate', '-d', '.'],
      DEPLOY_DRY_RUN('default'),
    ]);
  });
});

describe('dryRunHasChanges', () => {
  it.each([
    ['a non-empty change list', '{"changes":[{"action":"create"}]}', true],
    ['an empty change list', '{"changes":[]}', false],
    ['a true flag', '{"changes":true}', true],
    ['a false flag', '{"changes":false}', false],
    ['output that is not JSON', 'Deploying…', true],
    ['JSON without changes', '{"success":true}', true],
    ['changes of another type', '{"changes":"none"}', true],
  ])('reads %s', (_name, output, expected) => {
    expect(dryRunHasChanges(output)).toBe(expected);
  });
});
