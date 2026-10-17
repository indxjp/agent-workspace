import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeManagedAgents, planHasChanges } from './claude-managed-agents.ts';
import { fakeRunner, testContext } from './test-support.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), 'utf8');
}

describe('claude-managed-agents executor', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'aw-publish-ant-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true });
  });

  async function run(
    plan: string,
    options: { apply?: boolean } = {},
  ): Promise<readonly (readonly string[])[]> {
    const { runner, calls } = fakeRunner({
      'ant --version': { stdout: 'ant version 1.40.0\n' },
      'ant apply': { stdout: plan },
    });
    const env = { ANTHROPIC_API_KEY: 'sk-ant-live-123456' };
    const { context } = testContext(runner, { directory, env, apply: options.apply ?? false });

    await claudeManagedAgents.publish(context, {});

    for (const call of calls) {
      expect(call.cwd).toBe(directory);
      expect(call.env).toBe(env);
      expect(call.args).not.toContain('--force');
      expect(call.args).not.toContain('--prune');
      expect(call.args).not.toContain('--upgrade');
    }
    return calls.map((call) => call.args);
  }

  it('plans with ant apply --dry-run . and makes no apply call without apply', async () => {
    const calls = await run(await fixture('ant-dry-run-create.txt'));

    expect(calls).toEqual([['--version'], ['apply', '--dry-run', '.']]);
  });

  it.each([
    ['', (lock: string) => lock],
    [
      ' from a lock file without kind',
      (lock: string) => lock.replace(/^\s*"kind": "agent",\n/mu, ''),
    ],
  ])(
    'applies with ant apply --yes . and reports the agent id and the lock file%s',
    async (name, edit) => {
      const lock = edit(await fixture('claude-lock.json'));
      expect(lock.includes('"kind"')).toBe(name === '');
      await writeFile(path.join(directory, 'claude-lock.json'), lock);
      const { runner, calls } = fakeRunner({
        'ant --version': { stdout: 'ant version 1.40.0\n' },
        'ant apply': { stdout: await fixture('ant-dry-run-create.txt') },
      });
      const { context } = testContext(runner, { directory, apply: true });

      const outcome = await claudeManagedAgents.publish(context, {});

      expect(calls.map((call) => call.args)).toEqual([
        ['--version'],
        ['apply', '--dry-run', '.'],
        ['apply', '--yes', '.'],
      ]);
      expect(outcome).toEqual({
        changes: true,
        applied: true,
        nextSteps: [
          'agent id: agent_011CYm1BLqPXpQRk5khsSXrs',
          `commit ${directory.split(path.sep).join('/')}/claude-lock.json with the exported files`,
        ],
      });
    },
  );

  it.each([
    ['ant-dry-run-create.txt', true],
    ['ant-dry-run-update.txt', true],
    ['ant-dry-run-unchanged.txt', false],
  ])('reads changes from %s', async (name, changes) => {
    const { runner } = fakeRunner({
      'ant --version': { stdout: 'ant version 1.40.0\n' },
      'ant apply': { stdout: await fixture(name) },
    });
    const { context } = testContext(runner, { directory });

    await expect(claudeManagedAgents.publish(context, {})).resolves.toMatchObject({ changes });
  });

  it('does not apply an unchanged plan', async () => {
    const calls = await run(await fixture('ant-dry-run-unchanged.txt'), { apply: true });

    expect(calls).toEqual([['--version'], ['apply', '--dry-run', '.']]);
  });

  it('refuses a blocked plan and never applies', async () => {
    const { runner, calls } = fakeRunner({
      'ant --version': { stdout: 'ant version 1.40.0\n' },
      'ant apply': { stdout: await fixture('ant-dry-run-blocked.txt') },
    });
    const { context } = testContext(runner, { directory, apply: true });

    await expect(claudeManagedAgents.publish(context, {})).rejects.toThrow(
      'ant apply refused the plan: a resource was changed outside these files',
    );
    expect(calls.map((call) => call.args)).toEqual([['--version'], ['apply', '--dry-run', '.']]);
  });

  it('counts a plan it cannot read as a change', () => {
    expect(planHasChanges('something new')).toBe(true);
    expect(planHasChanges('Resources  ? 1 mystery')).toBe(true);
  });

  it('refuses ant 1.29.0 with the install fix', async () => {
    const { runner, calls } = fakeRunner({ 'ant --version': { stdout: 'ant version 1.29.0\n' } });
    const { context } = testContext(runner, { directory });

    await expect(claudeManagedAgents.publish(context, {})).rejects.toMatchObject({
      name: 'PublishRefusedError',
      fix: expect.stringContaining('brew install anthropics/tap/ant') as unknown,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a bundle with vaults/ below ant 1.34.0', async () => {
    await mkdir(path.join(directory, 'vaults'));
    const { runner, calls } = fakeRunner({ 'ant --version': { stdout: 'ant version 1.33.0\n' } });
    const { context } = testContext(runner, { directory });

    await expect(claudeManagedAgents.publish(context, {})).rejects.toThrow(
      'ant is older than 1.34.0',
    );
    expect(calls).toHaveLength(1);
  });

  it('ignores the compile options that share the merged settings', async () => {
    const { runner } = fakeRunner({
      'ant --version': { stdout: 'ant version 1.40.0\n' },
      'ant apply': { stdout: await fixture('ant-dry-run-unchanged.txt') },
    });
    const { context } = testContext(runner, { directory });

    await expect(
      claudeManagedAgents.publish(context, { model: 'claude-opus-5-5' }),
    ).resolves.toMatchObject({ changes: false });
  });
});
