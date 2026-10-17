import { PLATFORM_IDS } from '@indx-workspace/contracts/platforms';
import { describe, expect, it } from 'vitest';

import { checkPublishPrerequisites, PUBLISH_EXECUTORS, publishPlatform } from './index.ts';
import { PublishRefusedError } from './kit.ts';
import { fakeRunner, missingTool } from './test-support.ts';

const BASE = {
  directory: '/work/platforms/export',
  agent: 'support',
  settings: {},
  apply: false,
  experimental: false,
} as const;

describe('publishPlatform', () => {
  it('refuses an eject target and points at export', async () => {
    const publishing = publishPlatform({ ...BASE, platform: 'eject-mastra' });

    await expect(publishing).rejects.toBeInstanceOf(PublishRefusedError);
    await expect(publishing).rejects.toMatchObject({
      message: 'eject targets are exported, not published',
      fix: 'aw platforms export --platform eject-mastra',
    });
  });

  it('has an executor for every non-eject platform id and for nothing else', () => {
    const hosted = PLATFORM_IDS.filter((id) => !id.startsWith('eject-'));

    expect(Object.keys(PUBLISH_EXECUTORS).sort()).toEqual([...hosted].sort());
  });

  it('routes aws-agentcore to its executor with the default target', async () => {
    const { runner, calls } = fakeRunner({ 'agentcore --version': { stdout: '0.9.0\n' } });

    await publishPlatform({
      ...BASE,
      platform: 'aws-agentcore',
      runner,
      out: () => undefined,
      err: () => undefined,
    });

    expect(calls.map((call) => call.args)).toContainEqual([
      'deploy',
      '--target',
      'default',
      '--dry-run',
      '--json',
    ]);
  });

  it('uses the executor default environment when none is given', async () => {
    const { runner, calls } = fakeRunner({});
    expect(PUBLISH_EXECUTORS['m365-declarative-agent'].defaultEnvironment).toBe('dev');

    await publishPlatform({
      ...BASE,
      platform: 'm365-declarative-agent',
      runner,
      out: () => undefined,
      err: () => undefined,
    });

    expect(calls[1]?.args).toEqual(['validate', '--env', 'dev', '--folder', '.', '-i', 'false']);
  });
});

describe('checkPublishPrerequisites', () => {
  it('reports pass for a tool at or above its floor', async () => {
    const { runner } = fakeRunner({
      'ant --version': { stdout: 'ant version 1.31.2\n' },
      'atk --version': { stdout: '1.1.4\n' },
      'pac help': { stdout: 'Version: 2.4.1+g1\n' },
      'az version': { stdout: '{"azure-cli": "2.70.0"}\n' },
      'gcloud --version': { stdout: 'Google Cloud SDK 540.0.0\n' },
      'agentcore --version': { stdout: '0.9.0\n' },
    });

    await expect(checkPublishPrerequisites({ runner })).resolves.toEqual([
      {
        platform: 'claude-managed-agents',
        tool: 'ant',
        status: 'pass',
        detail: 'ant version 1.31.2',
      },
      { platform: 'copilot-studio', tool: 'pac', status: 'pass', detail: 'Version: 2.4.1+g1' },
      { platform: 'm365-declarative-agent', tool: 'atk', status: 'pass', detail: '1.1.4' },
      {
        platform: 'microsoft-foundry',
        tool: 'az',
        status: 'pass',
        detail: '{"azure-cli": "2.70.0"}',
      },
      {
        platform: 'gemini-enterprise',
        tool: 'gcloud',
        status: 'pass',
        detail: 'Google Cloud SDK 540.0.0',
      },
      { platform: 'aws-agentcore', tool: 'agentcore', status: 'pass', detail: '0.9.0' },
    ]);
  });

  it('reports fail with the install fix for a missing tool and for an old version', async () => {
    const { runner, calls } = fakeRunner({
      'ant --version': { stdout: 'ant version 1.29.0\n' },
      'atk --version': missingTool(),
      'pac help': { stdout: 'Version: 2.4.1\n' },
      'az version': { stdout: '{"azure-cli": "2.70.0"}\n' },
      'gcloud --version': { stdout: 'Google Cloud SDK 540.0.0\n' },
      'agentcore --version': { stdout: '0.9.0\n' },
    });

    const rows = await checkPublishPrerequisites({ runner });

    expect(rows[0]).toMatchObject({ tool: 'ant', status: 'fail' });
    expect(rows[0]?.detail).toContain('needs 1.30.0 or later');
    expect(rows[2]).toEqual({
      platform: 'm365-declarative-agent',
      tool: 'atk',
      status: 'fail',
      detail: 'not installed; npm install -g @microsoft/m365agentstoolkit-cli',
    });
    expect(calls).toHaveLength(6);
  });

  it('checks only the platform asked for, and nothing for an eject target', async () => {
    const { runner, calls } = fakeRunner({});

    await expect(checkPublishPrerequisites({ runner, platform: 'eject-mastra' })).resolves.toEqual(
      [],
    );
    const rows = await checkPublishPrerequisites({ runner, platform: 'm365-declarative-agent' });

    expect(rows.map((row) => row.tool)).toEqual(['atk']);
    expect(calls).toHaveLength(1);
  });
});
