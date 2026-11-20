import { createDockerDriver } from './docker.js';
import type { DockerCommand } from './docker.js';

export const unusedStartAgent = (): never => {
  throw new Error('not used');
};

/** Builds a Docker driver for the claude-agent-sdk engine over a fake docker command. */
export function createFakeDockerDriver(
  docker: DockerCommand,
  options: { publish?: 'loopback'; workspaceStorage?: 'anonymous-volume' } = {},
) {
  return createDockerDriver<never, never>({
    images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
    startAgent: unusedStartAgent,
    docker,
    ...options,
  });
}
