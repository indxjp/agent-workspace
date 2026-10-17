/**
 * Issue #791 (ADR-0118 TS4): the runner hands a tool sandbox its secrets as a file written over
 * standard input. Every Docker call goes through a fake `DockerCommand`.
 */
import { describe, expect, it } from 'vitest';

import { createDockerDriver } from './docker.js';
import type { DockerCommand, DockerCommandResult } from './docker.js';

const result = (exitCode: number, stdout = '', stderr = ''): DockerCommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const NETWORK = JSON.stringify([
  {
    Name: 'agent-egress',
    Driver: 'bridge',
    Internal: true,
    Labels: { 'agent-workspace.runtime': 'docker-network' },
  },
]);

function driverWith(calls: { args: readonly string[]; input: string | undefined }[]) {
  const docker: DockerCommand = (args, options) => {
    calls.push({ args: [...args], input: options?.input });
    if (args[0] === 'network') return Promise.resolve(result(0, NETWORK));
    if (args[0] === 'run') return Promise.resolve(result(0, 'container-1\n'));
    return Promise.resolve(result(0));
  };
  return createDockerDriver<never, never>({
    images: new Map([['claude-agent-sdk', 'agent-workspace/runtime:dev']]),
    startAgent: () => {
      throw new Error('not used');
    },
    workspaceStorage: 'anonymous-volume',
    docker,
  });
}

const config = {
  sessionId: 's',
  engine: 'claude-agent-sdk',
  workspacePath: '/ws/s',
} as const;

describe('docker driver writeFile', () => {
  it('sends the content on standard input, never in an argument', async () => {
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    const driver = driverWith(calls);
    const handle = await driver.create(config);
    await driver.writeFile(handle, 'manifest.json', '{"env":{"KEY":"sk-live-secret"}}');
    const write = calls.find((call) => call.args[0] === 'exec');
    expect(write?.input).toBe('{"env":{"KEY":"sk-live-secret"}}');
    expect(write?.args).toEqual([
      'exec',
      '--interactive',
      'container-1',
      'sh',
      '-c',
      'cat > "/workspace/.$0.tmp" && mv "/workspace/.$0.tmp" "/workspace/$0"',
      'manifest.json',
    ]);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain('sk-live-secret');
  });

  it.each(['../etc/passwd', 'a/b', '', '.hidden', 'a b', 'x'.repeat(65)])(
    'refuses %j as a file name',
    async (name) => {
      const calls: { args: readonly string[]; input: string | undefined }[] = [];
      const driver = driverWith(calls);
      const handle = await driver.create(config);
      await expect(driver.writeFile(handle, name, 'x')).rejects.toThrow(/not a plain file name/u);
      expect(calls.some((call) => call.args[0] === 'exec')).toBe(false);
    },
  );

  it('refuses a sandbox this driver does not hold', async () => {
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    const driver = driverWith(calls);
    await expect(
      driver.writeFile(
        {
          id: 'x',
          driver: 'docker',
          externalId: 'nope',
          workspacePath: '/w',
          createdAt: new Date(),
        },
        'a',
        'b',
      ),
    ).rejects.toThrow(/no longer live/u);
  });
});
