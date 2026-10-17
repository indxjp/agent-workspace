import { describe, expect, it } from 'vitest';

import { m365DeclarativeAgent } from './m365-declarative-agent.ts';
import { fakeRunner, testContext } from './test-support.ts';

const FOLDER_FLAGS = ['--folder', '.', '-i', 'false'];

describe('m365-declarative-agent executor', () => {
  it('plans with validate then package and never provisions', async () => {
    const { runner, calls } = fakeRunner({ 'atk --version': { stdout: '1.1.4\n' } });
    const { context, stdout } = testContext(runner, {
      platform: 'm365-declarative-agent',
      environment: 'dev',
    });

    const outcome = await m365DeclarativeAgent.publish(context, {});

    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['validate', '--env', 'dev', ...FOLDER_FLAGS],
      ['package', '--env', 'dev', ...FOLDER_FLAGS],
    ]);
    expect(calls.every((call) => call.cwd === context.directory)).toBe(true);
    expect(stdout.join('')).toContain(
      'atk provision would register or update the app in Microsoft 365',
    );
    expect(outcome).toEqual({ changes: true, applied: false, nextSteps: [] });
  });

  it('adds provision when applying and flows --env to every call', async () => {
    const { runner, calls } = fakeRunner({});
    const { context } = testContext(runner, {
      platform: 'm365-declarative-agent',
      environment: 'staging',
      apply: true,
    });

    const outcome = await m365DeclarativeAgent.publish(context, {});

    expect(calls.map((call) => call.args).slice(1)).toEqual([
      ['validate', '--env', 'staging', ...FOLDER_FLAGS],
      ['package', '--env', 'staging', ...FOLDER_FLAGS],
      ['provision', '--env', 'staging', ...FOLDER_FLAGS],
    ]);
    expect(outcome.applied).toBe(true);
    expect(outcome.nextSteps.join('\n')).toContain('atk publish --env staging --folder ');
    expect(outcome.nextSteps.join('\n')).toContain('atk auth login');
  });

  it('stops before package when validate fails', async () => {
    const { runner, calls } = fakeRunner({ 'atk validate': { status: 1, stderr: 'invalid' } });
    const { context } = testContext(runner, {
      platform: 'm365-declarative-agent',
      environment: 'dev',
      apply: true,
    });

    await expect(m365DeclarativeAgent.publish(context, {})).rejects.toThrow(
      '`atk validate` failed (exit status 1)',
    );
    expect(calls.map((call) => call.args[0])).toEqual(['--version', 'validate']);
  });
});
