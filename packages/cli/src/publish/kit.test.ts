import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createPublishRedactor,
  defineExecutor,
  PublishSettingsError,
  requireTool,
  runPublishTool,
  versionAtLeast,
  type PublishTool,
} from './kit.ts';
import { publishPlatform } from './index.ts';
import { fakeRunner, missingTool, testContext } from './test-support.ts';

const ANT: PublishTool = {
  name: 'ant',
  versionArgs: ['--version'],
  minimumVersion: '1.30.0',
  install: 'brew install anthropics/tap/ant',
  docsUrl: 'https://example.test/ant',
};

describe('versionAtLeast', () => {
  it('compares the first x.y.z numerically', () => {
    expect(versionAtLeast('ant version 1.30.0', '1.30.0')).toBe(true);
    expect(versionAtLeast('ant 1.100.0 (build 2.0.0)', '1.34.0')).toBe(true);
    expect(versionAtLeast('ant 1.29.9', '1.30.0')).toBe(false);
    expect(versionAtLeast('ant dev', '1.30.0')).toBeNull();
  });
});

describe('defineExecutor', () => {
  const executor = defineExecutor({
    tools: [ANT],
    defaultEnvironment: 'default',
    settingsSchema: z.strictObject({ region: z.string() }),
    publish: (_context, settings) =>
      Promise.resolve({ changes: false, applied: false, nextSteps: [settings.region] }),
  });

  it('refuses invalid settings naming the path', async () => {
    const { runner } = fakeRunner({});
    const { context } = testContext(runner, { environment: 'prod' });

    const publishing = executor.publish(context, { region: 3 });

    await expect(publishing).rejects.toBeInstanceOf(PublishSettingsError);
    await expect(publishing).rejects.toThrow(
      'platforms.claude-managed-agents.environments.prod.region: ',
    );
  });

  it('passes validated settings to the executor', async () => {
    const { runner } = fakeRunner({});
    const { context } = testContext(runner);

    await expect(executor.publish(context, { region: 'eu' })).resolves.toMatchObject({
      nextSteps: ['eu'],
    });
  });
});

describe('runPublishTool', () => {
  it('echoes the command, runs in the directory and prints the output', async () => {
    const { runner, calls } = fakeRunner({ 'ant apply': { stdout: 'plan\n' } });
    const { context, stdout } = testContext(runner);

    await runPublishTool(context, ANT, ['apply', '--dry-run', '.']);

    expect(stdout.join('')).toBe('$ ant apply --dry-run .\nplan\n');
    expect(calls).toEqual([
      {
        tool: 'ant',
        args: ['apply', '--dry-run', '.'],
        cwd: '/work/platforms/export',
        env: context.env,
      },
    ]);
  });

  it('maps a missing tool to the install fix and says nothing was published', async () => {
    const { runner } = fakeRunner({ 'ant apply': missingTool() });
    const { context } = testContext(runner);

    await expect(runPublishTool(context, ANT, ['apply'])).rejects.toThrow(
      'ant is not installed or not on PATH: aw platforms publish runs it for claude-managed-agents. Install it: brew install anthropics/tap/ant. Nothing was published.',
    );
  });

  it('names every argument of a failed call that has only flags', async () => {
    const { runner } = fakeRunner({ 'ant --version': { status: 1 } });
    const { context } = testContext(runner);

    await expect(runPublishTool(context, ANT, ['--version'])).rejects.toThrow(
      '`ant --version` failed (exit status 1); its output is above.',
    );
  });

  it('throws naming the tool when the status is not accepted, and honours accept', async () => {
    const { runner } = fakeRunner({ 'ant apply': { status: 2, stderr: 'boom' } });
    const { context, stderr } = testContext(runner);

    await expect(runPublishTool(context, ANT, ['apply', '--yes'])).rejects.toThrow(
      '`ant apply` failed (exit status 2); its output is above.',
    );
    expect(stderr.join('')).toBe('boom\n');
    await expect(
      runPublishTool(context, ANT, ['apply'], { accept: [0, 2] }),
    ).resolves.toMatchObject({ status: 2 });
  });

  it('never prints the stdout of a call that returns a credential and conceals it', async () => {
    const { runner } = fakeRunner({ 'ant token': { stdout: 'tok-very-secret\n' } });
    const concealed: string[] = [];
    const { context, stdout } = testContext(runner, { conceal: (s) => concealed.push(s) });

    await runPublishTool(context, ANT, ['token'], { show: false });

    expect(stdout.join('')).toBe('$ ant token\n');
    expect(concealed).toEqual(['tok-very-secret']);
  });

  it('stops before running when the signal is aborted', async () => {
    const { runner, calls } = fakeRunner({});
    const controller = new AbortController();
    controller.abort();
    const { context } = testContext(runner, { signal: controller.signal });

    await expect(runPublishTool(context, ANT, ['apply'])).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('requireTool', () => {
  it('refuses a version below the floor with the install fix', async () => {
    const { runner } = fakeRunner({ 'ant --version': { stdout: 'ant 1.29.0\n' } });
    const { context } = testContext(runner);

    await expect(requireTool(context, ANT)).rejects.toMatchObject({
      name: 'PublishRefusedError',
      fix: 'brew install anthropics/tap/ant',
    });
  });
});

describe('redaction through publishPlatform', () => {
  it('masks credential-named environment values in every printed line', async () => {
    const { runner } = fakeRunner({
      'ant --version': { stdout: 'ant 1.31.0\n' },
      'ant apply': { stdout: 'Resources  = 1 unchanged key=sk-ant-live-123456\n' },
    });
    const out: string[] = [];
    const err: string[] = [];

    await publishPlatform({
      platform: 'claude-managed-agents',
      directory: '/work/platforms/export',
      agent: 'support',
      settings: {},
      apply: false,
      experimental: false,
      env: { ANTHROPIC_API_KEY: 'sk-ant-live-123456', PATH: '/usr/bin' },
      runner,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });

    expect(out.join('')).not.toContain('sk-ant-live-123456');
    expect(out.join('')).toContain('key=***');
  });
});

describe('createPublishRedactor', () => {
  it('masks a concealed secret from then on, longest first', () => {
    const { redact, conceal } = createPublishRedactor({ PATH: '/usr/bin' });
    expect(redact('bearer abcd-1234')).toBe('bearer abcd-1234');

    conceal('abcd');
    conceal('abcd-1234');

    expect(redact('bearer abcd-1234 / abcd')).toBe('bearer *** / ***');
  });
});
