/**
 * Issue #394: sandboxes carry their Compose project, and the driver reaps them on shutdown.
 *
 * Every Docker call goes through a fake `DockerCommand`: nothing here reaches a daemon.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDockerRunArgs,
  createDockerDriver,
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_SANDBOX_LABEL,
  requireComposeProject,
} from './docker.js';
import type { DockerCommand, DockerCommandResult } from './docker.js';

function result(exitCode: number, stdout = '', stderr = ''): DockerCommandResult {
  return { exitCode, stdout, stderr };
}

function hasPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((arg, index) => arg === flag && args[index + 1] === value);
}

const OWNED_NETWORK = (name: string): DockerCommandResult =>
  result(
    0,
    JSON.stringify([
      {
        Name: name,
        Driver: 'bridge',
        Internal: true,
        Labels: { 'agent-workspace.runtime': 'docker-network' },
      },
    ]),
  );

type FakeDocker = Readonly<{
  docker: DockerCommand;
  calls: string[][];
}>;

function fakeDocker(
  options: Readonly<{
    listed?: readonly string[];
    networkExists?: boolean;
    failRemoval?: ReadonlySet<string>;
    failListing?: boolean;
    goneAlready?: ReadonlySet<string>;
  }> = {},
): FakeDocker {
  const calls: string[][] = [];
  let nextContainer = 0;
  let networkCreated = options.networkExists ?? true;
  const docker: DockerCommand = (args) => {
    calls.push([...args]);
    const [verb, sub] = args;
    if (verb === 'network' && sub === 'inspect') {
      return Promise.resolve(
        networkCreated ? OWNED_NETWORK(args[2] ?? '') : result(1, '', 'no such network'),
      );
    }
    if (verb === 'network' && sub === 'create') {
      networkCreated = true;
      return Promise.resolve(result(0, 'network-id\n'));
    }
    if (verb === 'run') return Promise.resolve(result(0, `container-${String(++nextContainer)}\n`));
    if (verb === 'ps') {
      return Promise.resolve(
        options.failListing === true
          ? result(1, '', 'Cannot connect to the Docker daemon')
          : result(0, (options.listed ?? []).join('\n')),
      );
    }
    if (verb === 'rm') {
      const container = args.at(-1) ?? '';
      if (options.goneAlready?.has(container) === true) {
        return Promise.resolve(
          result(1, '', `Error response from daemon: No such container: ${container}`),
        );
      }
      return Promise.resolve(
        options.failRemoval?.has(container) === true
          ? result(1, '', `cannot remove ${container}`)
          : result(0, `${container}\n`),
      );
    }
    return Promise.resolve(result(1, '', `unexpected docker ${args.join(' ')}`));
  };
  return { docker, calls };
}

const noAgent = (): never => {
  throw new Error('not used');
};

describe('docker sandboxes carry their Compose project (#394)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-docker-compose-project-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('labels a sandbox with the project, beside the sandbox label it always carried', () => {
    const args = buildDockerRunArgs({
      name: 'probe',
      image: 'alpine:3.20',
      workspacePath: '/workspace',
      networkPolicy: 'none',
      networkName: 'acme-runtime-control',
      composeProject: 'acme',
    });
    expect(hasPair(args, '--label', DOCKER_SANDBOX_LABEL)).toBe(true);
    expect(hasPair(args, '--label', `${DOCKER_COMPOSE_PROJECT_LABEL}=acme`)).toBe(true);
    // The image is the first positional argument; every label precedes it.
    expect(args.indexOf(`${DOCKER_COMPOSE_PROJECT_LABEL}=acme`)).toBeLessThan(
      args.indexOf('alpine:3.20'),
    );
  });

  it('adds no project label outside a Compose project', () => {
    const args = buildDockerRunArgs({
      name: 'probe',
      image: 'alpine:3.20',
      workspacePath: '/workspace',
      networkPolicy: 'none',
      networkName: 'agent-egress',
    });
    expect(args.some((arg) => arg.startsWith(DOCKER_COMPOSE_PROJECT_LABEL))).toBe(false);
  });

  it.each(['', 'Acme', '-acme', 'acme project', 'acme,label=x', 'acme=x'])(
    'refuses %j as a Compose project before anything runs',
    (project) => {
      expect(() => requireComposeProject(project)).toThrow(/not a Compose project name/u);
      expect(() =>
        createDockerDriver<never, never>({
          images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
          startAgent: noAgent,
          composeProject: project,
          docker: () => Promise.reject(new Error('must not be called')),
        }),
      ).toThrow(/not a Compose project name/u);
    },
  );

  it('labels the sandbox it starts, and an internal network it has to create', async () => {
    const fake = fakeDocker({ networkExists: false });
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: noAgent,
      networkName: 'acme-runtime-control',
      composeProject: 'acme',
      docker: fake.docker,
    });
    await driver.create({
      sessionId: 'session-1',
      engine: 'claude-agent-sdk',
      workspacePath: path.join(root, 'one'),
    });
    const created = fake.calls.find((call) => call[0] === 'network' && call[1] === 'create');
    expect(created).toBeDefined();
    expect(hasPair(created ?? [], '--label', 'agent-workspace.runtime=docker-network')).toBe(true);
    expect(hasPair(created ?? [], '--label', `${DOCKER_COMPOSE_PROJECT_LABEL}=acme`)).toBe(true);
    const run = fake.calls.find((call) => call[0] === 'run') ?? [];
    expect(hasPair(run, '--label', `${DOCKER_COMPOSE_PROJECT_LABEL}=acme`)).toBe(true);
    expect(hasPair(run, '--label', 'agent-workspace.session-id=session-1')).toBe(true);
  });
});

describe('docker driver reapAll (#394)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-docker-reap-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes every held sandbox and every labelled one of its project, once each', async () => {
    const fake = fakeDocker({ listed: ['container-1', 'left-by-an-earlier-manager'] });
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: noAgent,
      networkName: 'acme-runtime-control',
      composeProject: 'acme',
      docker: fake.docker,
    });
    const first = await driver.create({
      sessionId: 'one',
      engine: 'claude-agent-sdk',
      workspacePath: path.join(root, 'one'),
    });
    await driver.create({
      sessionId: 'two',
      engine: 'claude-agent-sdk',
      workspacePath: path.join(root, 'two'),
    });

    const report = await driver.reapAll();

    expect([...report.removed].sort()).toEqual([
      'container-1',
      'container-2',
      'left-by-an-earlier-manager',
    ]);
    expect(report.failed).toEqual([]);
    const listing = fake.calls.find((call) => call[0] === 'ps') ?? [];
    // Both labels, so a container of another project, or one this driver did not start, is never
    // listed and therefore never removed.
    expect(hasPair(listing, '--filter', `label=${DOCKER_SANDBOX_LABEL}`)).toBe(true);
    expect(hasPair(listing, '--filter', `label=${DOCKER_COMPOSE_PROJECT_LABEL}=acme`)).toBe(true);
    const removals = fake.calls.filter((call) => call[0] === 'rm');
    expect(removals).toHaveLength(3);
    for (const removal of removals)
      expect(removal.slice(0, 3)).toEqual(['rm', '--force', '--volumes']);
    expect(await driver.isLive(first)).toBe(false);
  });

  it('lists nothing outside a Compose project and removes only the sandboxes it holds', async () => {
    const fake = fakeDocker({ listed: ['someone-elses-container'] });
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: noAgent,
      docker: fake.docker,
    });
    await driver.create({
      sessionId: 'one',
      engine: 'claude-agent-sdk',
      workspacePath: path.join(root, 'one'),
    });
    const report = await driver.reapAll();
    expect(report.removed).toEqual(['container-1']);
    expect(fake.calls.some((call) => call[0] === 'ps')).toBe(false);
  });

  it('reports a sandbox it could not remove instead of throwing, and keeps holding it', async () => {
    const fake = fakeDocker({ failRemoval: new Set(['container-1']) });
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: noAgent,
      composeProject: 'acme',
      docker: fake.docker,
    });
    const handle = await driver.create({
      sessionId: 'one',
      engine: 'claude-agent-sdk',
      workspacePath: path.join(root, 'one'),
    });
    const report = await driver.reapAll();
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([
      { container: 'container-1', reason: 'cannot remove container-1' },
    ]);
    // Still held, so a later destroy can try again.
    await expect(driver.destroy(handle)).rejects.toThrow(/remove container failed/u);
  });

  it('counts a sandbox that is already gone as removed, not as a failed reap', async () => {
    const fake = fakeDocker({ listed: ['already-gone'], goneAlready: new Set(['already-gone']) });
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: noAgent,
      composeProject: 'acme',
      docker: fake.docker,
    });
    const report = await driver.reapAll();
    expect(report.removed).toEqual(['already-gone']);
    expect(report.failed).toEqual([]);
  });

  it('does not call a shutdown clean when the project sandboxes cannot be listed', async () => {
    const fake = fakeDocker({ failListing: true });
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: noAgent,
      composeProject: 'acme',
      docker: fake.docker,
    });
    await driver.create({
      sessionId: 'one',
      engine: 'claude-agent-sdk',
      workspacePath: path.join(root, 'one'),
    });
    const report = await driver.reapAll();
    // The sandbox it holds is still removed; the failed listing is a failure, not "nothing left".
    expect(report.removed).toEqual(['container-1']);
    expect(report.failed).toEqual([
      {
        container: `label=${DOCKER_COMPOSE_PROJECT_LABEL}=acme`,
        reason: "could not list the project's sandboxes: Cannot connect to the Docker daemon",
      },
    ]);
  });
});
