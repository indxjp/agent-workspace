import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';
import { cloudRunModuleDirectory } from './cloud-run-module.js';
import { gcpProject, release } from './gcp-fixtures.test-support.ts';
import { REQUIRED_GCP_PERMISSIONS } from './gcp-preflight.js';
import { stub, type World } from './gcp-runner.test-support.ts';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
const temporary: string[] = [];
export const captured = { output: '' };

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  captured.output = '';
});

export async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-gcp-lifecycle-'));
  temporary.push(directory);
  return directory;
}

export const granted: typeof fetch = () =>
  Promise.resolve(Response.json({ permissions: REQUIRED_GCP_PERMISSIONS }));

function capture(): void {
  const write = (chunk: string | Uint8Array): boolean => {
    captured.output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
}

export async function scenario(
  overrides: Partial<DeployProjectEnvironmentOptions> = {},
  initial: Partial<World> = {},
) {
  capture();
  const world: World = {
    bucket: false,
    stack: false,
    planExit: 2,
    applyFails: null,
    images: new Set<string>(),
    ...initial,
  };
  const { runner, calls } = stub(world);
  const root = await home();
  const stateDirectory = path.join(root, 'deployments', 'acme-ai', 'production');
  const options: DeployProjectEnvironmentOptions = {
    project: await gcpProject(),
    environment: 'production',
    apply: true,
    stateDirectory,
    env: {},
    images: release,
    nodeVersion: '24.1.0',
    runner,
    fetch: granted,
    ...overrides,
  };
  return {
    world,
    calls,
    runner,
    options,
    stateDirectory,
    moduleDirectory: cloudRunModuleDirectory(stateDirectory),
    run: (extra: Partial<DeployProjectEnvironmentOptions> = {}) =>
      deployProjectEnvironment({ ...options, ...extra }),
  };
}

export const variablesOf = async (
  stateDirectory: string,
): Promise<{ images: Record<string, string> }> =>
  JSON.parse(
    await readFile(
      path.join(stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json'),
      'utf8',
    ),
  ) as { images: Record<string, string> };
