import { createDockerDriver } from './docker.js';
import type { DockerCommand, DockerCommandResult } from './docker.js';
import type { RuntimeRunSpec } from './driver.js';

export function commandResult(exitCode: number, stdout = '', stderr = ''): DockerCommandResult {
  return { exitCode, stdout, stderr };
}

export function networkInspection(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): DockerCommandResult {
  return commandResult(
    0,
    JSON.stringify([
      {
        Name: name,
        Driver: 'bridge',
        Internal: true,
        Labels: { 'agent-workspace.runtime': 'docker-network' },
        ...overrides,
      },
    ]),
  );
}

export function includesSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  return haystack.some((_, index) =>
    needle.every((value, offset) => haystack[index + offset] === value),
  );
}

export function runSpec(overrides: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-1',
    driver: 'docker',
    networkPolicy: 'none',
    filesystem: 'read-write',
    ...overrides,
  };
}

export function recordingDriver(
  calls: string[][],
  options: Readonly<{
    workspaceStorage?: 'bind' | 'anonymous-volume';
    rm?: (container: string) => DockerCommandResult | Promise<DockerCommandResult>;
  }> = {},
) {
  let next = 0;
  const docker: DockerCommand = (args) => {
    calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'inspect')
      return Promise.resolve(networkInspection('agent-egress'));
    if (args[0] === 'run') return Promise.resolve(commandResult(0, `c-${String(++next)}\n`));
    if (args[0] === 'rm')
      return Promise.resolve(options.rm?.(args.at(-1) ?? '') ?? commandResult(0));
    return Promise.resolve(commandResult(0, 'true\n'));
  };
  return createDockerDriver<never, never>({
    images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
    startAgent: () => {
      throw new Error('not used');
    },
    docker,
    workspaceStorage: options.workspaceStorage ?? 'anonymous-volume',
  });
}
