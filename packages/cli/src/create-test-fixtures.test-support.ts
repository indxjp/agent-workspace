import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, vi } from 'vitest';
import { runCreateCommand, type RunCreateCommandOptions, type RunInProject } from './create.js';
import type { DeploymentImages } from './deployment.js';

export const created: string[] = [];

const digest = (character: string) => `sha256:${character.repeat(64)}`;

export const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};

export const cloudImages: DeploymentImages = {
  web: images.web,
  gateway: images.gateway,
  runner: images.runner,
  runtime: images.runtime,
};

export const options = { images };

const fakeRun: RunInProject = () => Promise.resolve(0);

export function create(
  argv: readonly string[],
  overrides: RunCreateCommandOptions = {},
): Promise<void> {
  return runCreateCommand([...argv], { run: fakeRun, platform: 'linux', ...overrides });
}

export function captureStdout() {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return () => written.join('');
}

beforeEach(() => {
  // The package manager that ran `npm create`; the suite itself may run under pnpm.
  vi.stubEnv('npm_config_user_agent', 'npm/11.0.0 node/v24.0.0 linux x64');
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
