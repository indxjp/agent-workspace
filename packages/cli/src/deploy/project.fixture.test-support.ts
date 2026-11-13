import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { afterEach, vi } from 'vitest';
import type { DeploymentImages } from '../deployment.js';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** The v2 project a fixture holds; a lifted v1 profile fails the test. */
async function projectFixture(name: string) {
  const read = parseProjectFile(await fixture(name));
  if (read.lifted) throw new Error(`${name} is not a v2 project file`);
  return read.project;
}

const temporary: string[] = [];

const digest = (character: string) => `sha256:${character.repeat(64)}`;

const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};
export function installDeploymentCleanup(): void {
  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true })));
    vi.restoreAllMocks();
  });
}

/** The `terraform show -json` of a plan that changes nothing. */
const EMPTY_PLAN = JSON.stringify({ format_version: '1.2', applyable: false, complete: true });

/**
 * Docker answering for a project with no container yet, and Terraform with an empty plan; every
 * call is recorded.
 */
function docker(answer: Partial<ToolResult> = {}): {
  runner: ToolRunner;
  calls: ToolInvocation[];
} {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = (invocation) => {
    calls.push(invocation);
    const stdout = invocation.args.includes('--hash')
      ? 'web aaa\n'
      : invocation.tool === 'terraform' && invocation.args[1] === 'show'
        ? EMPTY_PLAN
        : '';
    return Promise.resolve({ status: 0, stdout, stderr: '', ...answer });
  };
  return { runner, calls };
}

async function deploy(overrides: Partial<DeployProjectEnvironmentOptions> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-state-'));
  temporary.push(home);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const options: DeployProjectEnvironmentOptions = {
    project: await projectFixture('production-single-vm.project.yaml'),
    environment: 'production',
    apply: false,
    stateDirectory: path.join(home, 'deployments', 'acme-ai', 'production'),
    env: {},
    images,
    nodeVersion: '24.1.0',
    resolveHost: () => Promise.resolve(),
    ...docker(),
    ...overrides,
  };
  return { options, run: () => deployProjectEnvironment(options) };
}

const isComposeUp = ({ args }: ToolInvocation) => args[0] === 'compose' && args[1] === 'up';
export { fixture, projectFixture, temporary, digest, images, docker, deploy, isComposeUp };
