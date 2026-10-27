/**
 * Issue #394: a Docker runner manager labels its sandboxes with the Compose project it runs in and
 * removes them when it is asked to stop. Docker is a fake throughout; nothing reaches a daemon.
 */
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import type { DockerCommand, DockerReapReport } from '@agent-workspace/runtime/driver/docker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerManagerServer } from './manager.js';
import type { ManagedRuntimeDriver } from './manager-support.js';
import { createShutdownGate } from './shutdown-gate.js';
import { composeProjectFor, dockerDriverOptions, shutdownRunnerManager } from './manager-start.js';

const IMAGE_ENV = { AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'alpine:3.20' } as const;

function fakeDocker(listed: readonly string[] = []): {
  docker: DockerCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  const docker: DockerCommand = (args) => {
    calls.push([...args]);
    const ok = (stdout = '') => Promise.resolve({ exitCode: 0, stdout, stderr: '' });
    if (args[0] === 'network' && args[1] === 'inspect') {
      return ok(
        JSON.stringify([
          {
            Name: args[2],
            Driver: 'bridge',
            Internal: true,
            Labels: { 'agent-workspace.runtime': 'docker-network' },
          },
        ]),
      );
    }
    if (args[0] === 'network') return ok();
    if (args[0] === 'run') return ok('sandbox-1\n');
    if (args[0] === 'ps') return ok(listed.join('\n'));
    if (args[0] === 'rm') return ok();
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected' });
  };
  return { docker, calls };
}

function sink(): { write: (chunk: string) => boolean; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

describe('runner manager Compose project', () => {
  it('reads COMPOSE_PROJECT_NAME, and treats an unset or blank value as no project', () => {
    expect(composeProjectFor({ COMPOSE_PROJECT_NAME: 'acme-ai' })).toBe('acme-ai');
    expect(composeProjectFor({ COMPOSE_PROJECT_NAME: '  ' })).toBeUndefined();
    expect(composeProjectFor({})).toBeUndefined();
  });

  it('refuses a malformed project name at start-up rather than labelling with it', () => {
    expect(() =>
      dockerDriverOptions({ ...IMAGE_ENV, COMPOSE_PROJECT_NAME: 'Acme AI' }, fakeDocker().docker),
    ).toThrow(/not a Compose project name/u);
  });

  it('labels each sandbox with the project and reaps the project sandboxes', async () => {
    const fake = fakeDocker(['left-behind']);
    const options = dockerDriverOptions(
      { ...IMAGE_ENV, COMPOSE_PROJECT_NAME: 'acme-ai', RUNTIME_NETWORK: 'acme-ai-runtime-control' },
      fake.docker,
    );
    await options.driver.create({
      sessionId: 'session-1',
      engine: 'claude-agent-sdk',
      workspacePath: '/workspace/session-1',
    });
    const run = fake.calls.find((call) => call[0] === 'run') ?? [];
    expect(run).toContain('agent-workspace.compose-project=acme-ai');
    expect(run).toContain('acme-ai-runtime-control');

    const report = await options.reap?.();
    expect([...(report?.removed ?? [])].sort()).toEqual(['left-behind', 'sandbox-1']);
  });
});

describe('runner manager egress proxy (ADR-0117)', () => {
  const create = {
    sessionId: 'session-1',
    engine: 'claude-agent-sdk',
    workspacePath: '/workspace/session-1',
  };

  it('keeps refusing restricted egress when no proxy image is configured', async () => {
    const options = dockerDriverOptions(IMAGE_ENV, fakeDocker().docker);
    await expect(
      options.driver.create({
        ...create,
        runSpec: {
          runtimeProfileId: 'p',
          driver: 'docker',
          networkPolicy: 'restricted',
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow(/egressProxyImage/u);
  });

  it('starts the proxy and a distinct fingerprint once an image is configured', async () => {
    const env = {
      ...IMAGE_ENV,
      AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: 'agent-workspace/egress-proxy:dev',
      RUNTIME_PROXY_BYPASS: 'gateway, ',
    };
    const fake = fakeDocker();
    const withProxy = dockerDriverOptions(env, fake.docker);
    await withProxy.driver.create({
      ...create,
      runSpec: {
        runtimeProfileId: 'p',
        driver: 'docker',
        networkPolicy: 'restricted',
        allowedDomains: ['api.example.com'],
        filesystem: 'read-write',
      },
    });
    const runs = fake.calls.filter((call) => call[0] === 'run');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain('agent-workspace/egress-proxy:dev');
    expect(runs[1]).toContain('NO_PROXY=localhost,127.0.0.1,gateway');
    expect(withProxy.configurationFingerprint).not.toBe(
      dockerDriverOptions(IMAGE_ENV, fakeDocker().docker).configurationFingerprint,
    );
  });

  it('gives a tool sandbox no proxy bypass, so the proxy is its only route out (ADR-0118 TS5)', async () => {
    const fake = fakeDocker();
    const options = dockerDriverOptions(
      {
        ...IMAGE_ENV,
        AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: 'agent-workspace/egress-proxy:dev',
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: 'agent-workspace/tool-host:dev',
        RUNTIME_PROXY_BYPASS: 'gateway',
      },
      fake.docker,
    );
    // The fake refuses the manifest write, so the open fails after the containers are started.
    await expect(
      options.toolSandboxes?.open(
        {
          key: 'p:session-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          workspacesRoot: '/workspace',
        },
        {
          key: 'tools-1',
          manifest: { tools: [], stdioServers: [], env: {} },
          allowedDomains: ['api.example.com'],
          run: { runId: 'run_1', token: 'a-run-token-0123456789' },
        },
      ),
    ).rejects.toThrow();
    const sandbox = fake.calls.find(
      (call) => call[0] === 'run' && call.includes('agent-workspace/tool-host:dev'),
    );
    expect(sandbox).toContain('NO_PROXY=localhost,127.0.0.1');
  });
});

describe('shutdownRunnerManager', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server?.listening === true) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  async function listening(): Promise<Server> {
    server = createServer((_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  }

  it('stops listening, reaps the sandboxes and reports a clean stop', async () => {
    const live = await listening();
    const port = (live.address() as AddressInfo).port;
    const log = sink();
    let reaped = false;
    const outcome = await shutdownRunnerManager(
      live,
      () => {
        reaped = true;
        return Promise.resolve({ removed: ['a', 'b'], failed: [] } satisfies DockerReapReport);
      },
      log,
    );
    expect(outcome).toBe('clean');
    expect(reaped).toBe(true);
    expect(live.listening).toBe(false);
    expect(log.text()).toContain('removed 2 sandbox(es)');
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow();
  });

  it('names a sandbox it could not remove and does not call the stop clean', async () => {
    const log = sink();
    const outcome = await shutdownRunnerManager(
      await listening(),
      () => Promise.resolve({ removed: [], failed: [{ container: 'stuck', reason: 'busy' }] }),
      log,
    );
    expect(outcome).toBe('sandboxes-left');
    expect(log.text()).toContain('could not remove stuck: busy');
  });

  it('reports a failed reap instead of throwing', async () => {
    const log = sink();
    const outcome = await shutdownRunnerManager(
      await listening(),
      () => Promise.reject(new Error('daemon gone')),
      log,
    );
    expect(outcome).toBe('sandboxes-left');
    expect(log.text()).toContain('daemon gone');
  });

  it('has nothing to reap for a driver whose sandboxes outlive the manager', async () => {
    expect(await shutdownRunnerManager(await listening(), undefined, sink())).toBe('clean');
  });
});

/**
 * #406 follow-up: a sandbox `create` already in flight when the shutdown begins must not finish
 * after the reap has listed what exists, and a create asked for once shutdown began is refused.
 * The driver is a fake whose `create` resolves only when the test says so.
 */
describe('shutdown and sandbox creates in flight', () => {
  const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';
  const allocation = {
    workspaceId: 'workspace-one',
    sessionId: 'session-one',
    engine: 'claude-agent-sdk',
    runSpec: {
      runtimeProfileId: 'profile-one',
      driver: 'docker',
      networkPolicy: 'none',
      filesystem: 'read-write',
    },
  };
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  function slowDriver() {
    const live = new Map<string, RuntimeHandle>();
    const order: string[] = [];
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let count = 0;
    const driver: ManagedRuntimeDriver = {
      create: (config) =>
        new Promise<RuntimeHandle>((resolve) => {
          started?.();
          release = () => {
            count += 1;
            const handle: RuntimeHandle = {
              id: `handle-${String(count)}`,
              driver: 'docker',
              externalId: `container-${String(count)}`,
              workspacePath: config.workspacePath,
              createdAt: new Date('2026-10-01T00:00:00Z'),
            };
            live.set(handle.id, handle);
            order.push('created');
            resolve(handle);
          };
        }),
      destroy: (handle) => {
        live.delete(handle.id);
        order.push('destroyed');
        return Promise.resolve();
      },
      isLive: (handle) => Promise.resolve(live.has(handle.id)),
    };
    const reap = (): Promise<DockerReapReport> => {
      order.push('reaped');
      const removed = [...live.values()].map((handle) => handle.externalId);
      live.clear();
      return Promise.resolve({ removed, failed: [] });
    };
    return { driver, live, order, reap, createStarted, release: () => release?.() };
  }

  async function serve(driver: ManagedRuntimeDriver): Promise<{ server: Server; base: string }> {
    const server = createRunnerManagerServer({
      token: TOKEN,
      driver,
      workspacesRoot: '/srv/runtimes',
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
  }

  it('lets a create in flight at SIGTERM settle, then leaves no sandbox behind', async () => {
    const fake = slowDriver();
    const gate = createShutdownGate(fake.driver);
    const { server, base } = await serve(gate.driver);
    const allocating = fetch(`${base}/runtimes`, {
      method: 'POST',
      headers,
      body: JSON.stringify(allocation),
    }).then((response) => response.status);
    await fake.createStarted;

    const stopping = shutdownRunnerManager(server, fake.reap, sink(), gate, 5_000);
    // The sandbox appears only after the shutdown has begun, as with a slow `docker run`.
    fake.release();

    expect(await stopping).toBe('clean');
    expect(fake.live.size).toBe(0);
    // The create settled (and removed its own sandbox) before the reap listed what exists.
    expect(fake.order).toEqual(['created', 'destroyed', 'reaped']);
    // The caller is told why: the sandbox it asked for was started, then removed, during shutdown.
    expect(await allocating).toBe(503);
  });

  it('answers 503 to a create asked for after shutdown began, and never reaches the driver', async () => {
    const fake = slowDriver();
    const gate = createShutdownGate(fake.driver);
    const { server, base } = await serve(gate.driver);
    try {
      expect(await gate.close(1_000)).toBe(true);
      const refused = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers,
        body: JSON.stringify(allocation),
      });
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('5');
      expect(await refused.json()).toMatchObject({ error: 'runner_shutting_down' });
      expect(fake.order).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops waiting for a create that never settles, reaps, and does not call the stop clean', async () => {
    const fake = slowDriver();
    const gate = createShutdownGate(fake.driver);
    const creating = gate.driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/srv/runtimes/w/s',
    });
    await fake.createStarted;
    const server = createServer();
    const log = sink();
    // The late create may start a sandbox after the reap, or after the process exits: not clean.
    expect(await shutdownRunnerManager(server, fake.reap, log, gate, 10)).toBe('sandboxes-left');
    expect(log.text()).toContain('still in progress after 10ms');
    expect(log.text()).toContain('agent-workspace stop');
    expect(fake.order).toEqual(['reaped']);
    // If the process is still alive when it finishes, the closed gate removes the sandbox.
    fake.release();
    await expect(creating).rejects.toThrow(/shutting down/u);
    expect(fake.order).toEqual(['reaped', 'created', 'destroyed']);
    expect(fake.live.size).toBe(0);
  });

  it('names a sandbox it could not remove when a create finishes after the gate closed', async () => {
    const fake = slowDriver();
    const gate = createShutdownGate({
      ...fake.driver,
      destroy: () => Promise.reject(new Error('daemon refused')),
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const creating = gate.driver.create({
        sessionId: 's',
        engine: 'claude-agent-sdk',
        workspacePath: '/srv/runtimes/w/s',
      });
      await fake.createStarted;
      // The gate closes while the create is pending; the wait gives up at once.
      expect(await gate.close(0)).toBe(false);
      fake.release();

      await expect(creating).rejects.toThrow(/shutting down/u);
      const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(written).toContain('could not remove container-1');
      expect(written).toContain('daemon refused');
      // The failed destroy leaves the sandbox running, which is why it is named on stderr.
      expect(fake.live.size).toBe(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
