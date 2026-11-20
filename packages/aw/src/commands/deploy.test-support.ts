import { rm } from 'node:fs/promises';
import path from 'node:path';

import type {
  DeployProjectEnvironmentOptions,
  ProjectDeployOutcome,
} from '@indx-workspace/cli/deploy';

import { tempDirectory, tempFile } from '../testing.js';

import { deployMocks } from './deploy.mocks.test-support.js';

export const PROJECT = [
  'apiVersion: agentworkspace.dev/v2',
  'kind: Project',
  'name: acme-ai',
  'environments:',
  '  local:',
  '    cloud: local',
  '    identity:',
  '      bootstrapAdmin: admin@localhost.test',
  '  production:',
  '    target: single-vm',
  '    url: https://agents.acme.example',
  '',
].join('\n');

/** Where a production deploy keeps its state for the `/home/owner` home directory. */
export const PRODUCTION_STATE_DIRECTORY = path.join(
  '/home/owner',
  '.config',
  'agent-workspace',
  'deployments',
  'acme-ai',
  'production',
);

const temporary: string[] = [];

export async function resetDeployFixtures(): Promise<void> {
  for (const mock of Object.values(deployMocks)) mock.mockReset();
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true });
}

export async function emptyDirectory(): Promise<string> {
  const directory = await tempDirectory();
  temporary.push(directory);
  return directory;
}

export async function project(text = PROJECT): Promise<string> {
  const directory = await emptyDirectory();
  await tempFile(directory, 'agent-workspace.yaml', text);
  return directory;
}

export function outcome(changes: boolean, applied: boolean): ProjectDeployOutcome {
  return {
    changes,
    applied,
    created: true,
    adminEmail: 'admin@localhost.test',
    envFile: '/home/owner/.config/agent-workspace/deployments/acme-ai/production/.env',
    moduleDirectory: null,
    nextSteps: ['next: a', 'next: b'],
  };
}

export function deployedWith(): DeployProjectEnvironmentOptions {
  const [options] = deployMocks.deployProjectEnvironment.mock.calls[0] ?? [];
  if (options === undefined) throw new Error('deployProjectEnvironment was not called');
  return options;
}
