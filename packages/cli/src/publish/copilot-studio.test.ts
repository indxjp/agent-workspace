import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { copilotStudio, solutionNameOf } from './copilot-studio.ts';
import { PublishRefusedError } from './kit.ts';
import { fakeRunner, testContext } from './test-support.ts';

// The compile options as `CopilotStudioOptionsSchema` leaves them.
const SETTINGS = { publisherPrefix: 'acme', mcpConnectionMode: 'Maker', language: 1033 };
const DIRECTORY = '/work/platforms/export';
const ZIP = path.join('/work/platforms', 'support_triage.zip');
const PACK = [
  'solution',
  'pack',
  '--zipfile',
  ZIP,
  '--folder',
  DIRECTORY,
  '--packagetype',
  'Unmanaged',
];

function setup(options: { apply?: boolean; experimental?: boolean; version?: string } = {}) {
  const { runner, calls } = fakeRunner({
    'pac help': {
      stdout: `Microsoft PowerPlatform CLI\nVersion: ${options.version ?? '2.4.1'}+g1\n`,
    },
  });
  const { context } = testContext(runner, {
    platform: 'copilot-studio',
    agent: 'support-triage',
    apply: options.apply ?? false,
    experimental: options.experimental ?? false,
  });
  return { context, calls: () => calls.map((call) => call.args) };
}

describe('copilot-studio executor', () => {
  it('plans with pac solution pack only and imports nothing without apply', async () => {
    const { context, calls } = setup();

    const outcome = await copilotStudio.publish(context, SETTINGS);

    expect(calls()).toEqual([['help'], PACK]);
    expect(outcome).toMatchObject({ changes: true, applied: false });
  });

  it('writes the zip outside the folder it packs', async () => {
    const { context, calls } = setup();

    await copilotStudio.publish(context, SETTINGS);

    const zipfile = calls()[1]?.[3] ?? '';
    expect(zipfile).toBe(ZIP);
    expect(path.relative(DIRECTORY, zipfile).startsWith('..')).toBe(true);
  });

  it('refuses apply without experimental and never calls import', async () => {
    const { context, calls } = setup({ apply: true });

    const publishing = copilotStudio.publish(context, SETTINGS);

    await expect(publishing).rejects.toBeInstanceOf(PublishRefusedError);
    await expect(publishing).rejects.toMatchObject({
      message:
        'publishing to Copilot Studio is experimental until the agent folder schema is verified (P3b)',
      fix: `import ${ZIP} in Copilot Studio or the VS Code extension, or re-run with --experimental`,
    });
    expect(calls().some((args) => args[1] === 'import')).toBe(false);
  });

  it('imports and publishes with apply and experimental, into the active pac auth profile', async () => {
    const { context, calls } = setup({ apply: true, experimental: true });

    const outcome = await copilotStudio.publish(context, SETTINGS);

    expect(calls()).toEqual([
      ['help'],
      PACK,
      ['solution', 'import', '--path', ZIP, '--publish-changes'],
    ]);
    expect(outcome.applied).toBe(true);
  });

  it('says the plan uses the active pac auth profile', async () => {
    const { context } = setup();

    const outcome = await copilotStudio.publish(context, SETTINGS);

    expect(outcome.nextSteps[0]).toContain('active pac auth profile');
  });

  it('refuses a pac older than 2.4.1 before packing', async () => {
    const { context, calls } = setup({ version: '2.3.9' });

    await expect(copilotStudio.publish(context, SETTINGS)).rejects.toBeInstanceOf(
      PublishRefusedError,
    );
    expect(calls()).toEqual([['help']]);
  });

  it.each([
    ['support', 'support'],
    ['support-triage', 'support_triage'],
    ['9lives', '_9lives'],
  ])('derives the solution name of %s as %s', (agent, name) => {
    expect(solutionNameOf(agent)).toBe(name);
  });
});
