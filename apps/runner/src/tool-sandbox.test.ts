import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig, RuntimeHandle } from '@agent-workspace/runtime/driver';

import { createRunnerManagerServer } from './manager.js';
import type { ManagedRuntimeDriver } from './manager-support.js';
import {
  createToolSandboxes,
  parseToolSandboxRequest,
  ToolSandboxUnavailableError,
  type ToolSandboxDriver,
} from './tool-sandbox.js';

const SECRET = 'sk-live-do-not-print-0123456789';
const TOKEN = 'a-run-token-0123456789';
const MANAGER_TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

const request = (overrides: Record<string, unknown> = {}) => ({
  key: 'tools-1',
  manifest: {
    tools: [
      {
        name: 'get_order',
        description: 'Looks up an order.',
        inputSchema: { type: 'object' },
        timeoutMs: 5_000,
        digest: 'a'.repeat(64),
        bundleBase64: Buffer.from('export default () => 1;').toString('base64'),
      },
    ],
    env: { ORDERS_API_KEY: SECRET },
  },
  allowedDomains: ['api.example.com'],
  run: { runId: 'run_1', token: TOKEN },
  ...overrides,
});

function fakeDriver(options: { live?: boolean | (() => boolean) } = {}) {
  const files: { id: string; name: string; content: string }[] = [];
  const created: RuntimeConfig[] = [];
  const destroyed: string[] = [];
  let count = 0;
  const driver: ToolSandboxDriver = {
    create: (config) => {
      created.push(config);
      count += 1;
      const handle: RuntimeHandle = {
        id: `tool-${String(count)}`,
        driver: 'docker',
        externalId: `container-${String(count)}`,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
      };
      return Promise.resolve(handle);
    },
    destroy: (handle) => {
      destroyed.push(handle.id);
      return Promise.resolve();
    },
    isLive: () =>
      Promise.resolve(typeof options.live === 'function' ? options.live() : (options.live ?? true)),
    writeFile: (handle, name, content) => {
      files.push({ id: handle.id, name, content });
      return Promise.resolve();
    },
  };
  return { driver, files, created, destroyed };
}

const serving = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 401 })));
const session = {
  key: 'profile-one:session-one',
  workspaceId: 'workspace-one',
  sessionId: 'session-one',
  workspacesRoot: '/srv/runtimes',
};
const origin = (handle: RuntimeHandle) => `http://sandbox-${handle.id}:8788`;

describe('tool sandboxes (ADR-0118 TS2, TS4, TS5)', () => {
  it('writes the secrets as the manifest, then the run token once the host serves', async () => {
    const { driver, files, created } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).resolves.toBe(
      'http://sandbox-tool-1:8788',
    );
    expect(files.map((file) => file.name)).toEqual(['manifest.json', 'tokens.json']);
    expect(JSON.parse(files[0]?.content ?? '')).toMatchObject({ env: { ORDERS_API_KEY: SECRET } });
    expect(JSON.parse(files[1]?.content ?? '')).toEqual([TOKEN]);
    expect(created[0]?.runSpec).toMatchObject({
      networkPolicy: 'restricted',
      allowedDomains: ['api.example.com'],
    });
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(JSON.stringify(created)).not.toContain(TOKEN);
  });

  it('has no egress when no domain is declared', async () => {
    const { driver, created } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request({ allowedDomains: [] })));
    expect(created[0]?.runSpec?.networkPolicy).toBe('none');
    expect(created[0]?.runSpec?.allowedDomains).toBeUndefined();
  });

  it('reuses a live sandbox for the next run and replaces the previous run token', async () => {
    const { driver, files, created } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    const next = request({ run: { runId: 'run_2', token: 'another-run-token-0123456' } });
    await sandboxes.open(session, parseToolSandboxRequest(next));
    expect(created).toHaveLength(1);
    expect(files.filter((file) => file.name === 'manifest.json')).toHaveLength(1);
    expect(JSON.parse(files.at(-1)?.content ?? '')).toEqual(['another-run-token-0123456']);
  });

  it('replaces the sandbox when the tool set changes, so old secrets do not outlive their version', async () => {
    const { driver, created, destroyed } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    await sandboxes.open(session, parseToolSandboxRequest(request({ key: 'tools-2' })));
    expect(created).toHaveLength(2);
    expect(destroyed).toEqual(['tool-1']);
  });

  it('removes the sandbox and reports it when it stops before it serves', async () => {
    const { driver, destroyed } = fakeDriver({ live: false });
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      ToolSandboxUnavailableError,
    );
    expect(destroyed).toEqual(['tool-1']);
  });

  it('gives up, and removes the sandbox, when the host never answers', async () => {
    const { driver, destroyed } = fakeDriver();
    const refusing = vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')));
    const sandboxes = createToolSandboxes({
      driver,
      origin,
      fetch: refusing,
      readyTimeoutMs: 250,
    });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      'the tool sandbox did not become ready in time (no answer)',
    );
    expect(destroyed).toEqual(['tool-1']);
  });

  it('names the last status the probe saw when a provider edge keeps answering 502', async () => {
    const { driver } = fakeDriver();
    const edge = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 502 })));
    const sandboxes = createToolSandboxes({
      driver,
      origin,
      upstream: () => ({ url: 'https://49983-sbx1.e2b.test/mcp', headers: {} }),
      fetch: edge,
      readyTimeoutMs: 250,
    });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      'the tool sandbox did not become ready in time (last answer HTTP 502)',
    );
  });

  it('names the cause, and removes the sandbox, when the manifest cannot be written', async () => {
    const { driver, destroyed } = fakeDriver();
    driver.writeFile = () => Promise.reject(new Error('envd answered 503'));
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      'the tool sandbox could not be prepared: envd answered 503',
    );
    expect(destroyed).toEqual(['tool-1']);
  });

  it('keeps both failures when the sandbox that stopped before it served cannot be removed', async () => {
    const { driver } = fakeDriver({ live: false });
    driver.destroy = () => Promise.reject(new Error('docker rm failed'));
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    const thrown = await sandboxes
      .open(session, parseToolSandboxRequest(request()))
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    const [failure, cleanup] = (thrown as AggregateError).errors as Error[];
    expect(failure).toBeInstanceOf(ToolSandboxUnavailableError);
    expect(cleanup?.message).toBe('docker rm failed');
  });

  it('keeps the driver error as the cause when the manifest cannot be written', async () => {
    const { driver } = fakeDriver();
    const cause = new Error('envd answered 503');
    driver.writeFile = () => Promise.reject(cause);
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    const thrown = await sandboxes
      .open(session, parseToolSandboxRequest(request()))
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ToolSandboxUnavailableError);
    expect((thrown as Error).cause).toBe(cause);
  });

  it('starts no new tool set while the sandbox holding the old secrets cannot be removed', async () => {
    const { driver, created } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    const cause = new Error('docker rm failed');
    driver.destroy = () => Promise.reject(cause);
    const thrown = await sandboxes
      .open(session, parseToolSandboxRequest(request({ key: 'tools-2' })))
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ToolSandboxUnavailableError);
    expect((thrown as Error).cause).toBe(cause);
    expect(created).toHaveLength(1);
  });

  it('keeps both failures when the sandbox just started cannot be removed after its run token failed', async () => {
    const { driver } = fakeDriver();
    driver.writeFile = (_handle, name) =>
      name === 'tokens.json' ? Promise.reject(new Error('envd answered 502')) : Promise.resolve();
    driver.destroy = () => Promise.reject(new Error('docker rm failed'));
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    const thrown = await sandboxes
      .open(session, parseToolSandboxRequest(request()))
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    const [failure, cleanup] = (thrown as AggregateError).errors as Error[];
    expect(failure?.message).toBe('the run token could not be registered: envd answered 502');
    expect(cleanup?.message).toBe('docker rm failed');
  });

  it('keeps both failures when the sandbox outlives its close and its run token cannot be revoked', async () => {
    const { driver } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    driver.destroy = () => Promise.reject(new Error('docker rm failed'));
    driver.writeFile = () => Promise.reject(new Error('envd answered 502'));
    const thrown = await sandboxes.close(session).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(((thrown as AggregateError).errors as Error[]).map((error) => error.message)).toEqual([
      'docker rm failed',
      'envd answered 502',
    ]);
  });

  it('names the cause, and removes the sandbox it just started, when the run token cannot be written', async () => {
    const { driver, destroyed } = fakeDriver();
    driver.writeFile = (_handle, name) =>
      name === 'tokens.json' ? Promise.reject(new Error('envd answered 502')) : Promise.resolve();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      'the run token could not be registered: envd answered 502',
    );
    expect(destroyed).toEqual(['tool-1']);
  });

  it('keeps the live sandbox of an earlier run when a later run token cannot be written', async () => {
    const { driver, destroyed } = fakeDriver();
    const write = driver.writeFile.bind(driver);
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    driver.writeFile = (handle, name, content) =>
      name === 'tokens.json'
        ? Promise.reject(new Error('envd answered 502'))
        : write(handle, name, content);
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      'the run token could not be registered',
    );
    expect(destroyed).toEqual([]);
  });

  it("surfaces the provider's concurrency limit as an unavailable tool sandbox, without retrying", async () => {
    const { driver } = fakeDriver();
    const create = vi.fn<ToolSandboxDriver['create']>(() =>
      Promise.reject(
        new Error(
          "external runtime: provider e2b create failed with status 429: the provider's concurrency limit was reached (you have reached the maximum number of concurrent E2B sandboxes (20)).",
        ),
      ),
    );
    driver.create = create;
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    const error: unknown = await sandboxes
      .open(session, parseToolSandboxRequest(request()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolSandboxUnavailableError);
    expect((error as Error).message).toContain("the provider's concurrency limit was reached");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('waits at least as long as an npx fetch when the manifest has a stdio server', async () => {
    const { driver } = fakeDriver();
    const servingAfter = Date.now() + 500;
    const slow = vi.fn<typeof fetch>(() =>
      Date.now() < servingAfter
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve(new Response(null, { status: 401 })),
    );
    const sandboxes = createToolSandboxes({ driver, origin, fetch: slow, readyTimeoutMs: 250 });
    const stdio = request({
      manifest: {
        tools: [],
        stdioServers: [
          {
            name: 'orders',
            command: 'npx',
            args: ['-y', '@acme/orders-mcp@1.2.3'],
            timeoutMs: 5_000,
          },
        ],
        env: {},
      },
    });
    await expect(sandboxes.open(session, parseToolSandboxRequest(stdio))).resolves.toBe(
      'http://sandbox-tool-1:8788',
    );
  });

  it('closes the session sandbox once and tolerates a session without one', async () => {
    const { driver, destroyed } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.close({ ...session, key: 'nobody' });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    await sandboxes.close(session);
    await sandboxes.close(session);
    expect(destroyed).toEqual(['tool-1']);
  });

  it('removes the sandbox when it answers once and then stops (a bundle did not start)', async () => {
    let probes = 0;
    const { driver, files, destroyed } = fakeDriver({ live: () => (probes += 1) === 1 });
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await expect(sandboxes.open(session, parseToolSandboxRequest(request()))).rejects.toThrow(
      ToolSandboxUnavailableError,
    );
    expect(destroyed).toEqual(['tool-1']);
    expect(files.map((file) => file.name)).toEqual(['manifest.json']);
  });

  it('keeps one sandbox per profile of a session, so closing one leaves the other', async () => {
    const { driver, files, created, destroyed } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    const other = { ...session, key: 'profile-two:session-one' };
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    const second = request({ run: { runId: 'run_2', token: 'another-run-token-0123456' } });
    await sandboxes.open(other, parseToolSandboxRequest(second));
    expect(created).toHaveLength(2);
    expect(created[0]?.workspacePath).not.toBe(created[1]?.workspacePath);
    const tokens = files.filter((file) => file.name === 'tokens.json');
    expect(tokens.map((file) => [file.id, JSON.parse(file.content) as unknown])).toEqual([
      ['tool-1', [TOKEN]],
      ['tool-2', ['another-run-token-0123456']],
    ]);
    await sandboxes.close(other);
    expect(destroyed).toEqual(['tool-2']);
  });

  it('releases only the sandbox a run started, never one the run only reused (issue #832)', async () => {
    const { driver, created, destroyed } = fakeDriver();
    const sandboxes = createToolSandboxes({ driver, origin, fetch: serving() });
    await sandboxes.open(session, parseToolSandboxRequest(request()));
    // A second run of the session (one the runtime then refuses as in flight) reuses the sandbox.
    const second = request({ run: { runId: 'run_2', token: 'another-run-token-0123456' } });
    await sandboxes.open(session, parseToolSandboxRequest(second));
    await sandboxes.release?.({ workspaceId: 'workspace-one', runId: 'run_2' });
    await sandboxes.release?.({ workspaceId: 'workspace-two', runId: 'run_1' });
    expect(destroyed).toEqual([]);
    await sandboxes.release?.({ workspaceId: 'workspace-one', runId: 'run_1' });
    expect(destroyed).toEqual(['tool-1']);
    expect(created).toHaveLength(1);
  });

  it('refuses an invalid request naming paths and never a value', () => {
    let message = '';
    try {
      parseToolSandboxRequest(request({ run: { runId: 'run_1', token: 'short' }, extra: SECRET }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('run.token');
    expect(message).not.toContain(SECRET);
  });
});

describe('a provider-hosted tool sandbox (ADR-0120 LC5, LC6)', () => {
  const PROVIDER_KEY = 'e2b_SENTINEL_provider_key_0123456789';
  const ACCESS = { 'e2b-traffic-access-token': 'traffic-SENTINEL' };

  function hosted(found?: RuntimeHandle) {
    const calls: { op: string; credential: string | undefined; name?: string }[] = [];
    const handle: RuntimeHandle = found ?? {
      id: 'sealed-id',
      driver: 'external',
      externalId: 'sbx1',
      workspacePath: '/w',
      createdAt: new Date(),
    };
    const driver: ToolSandboxDriver = {
      create: (_config, credential) => {
        calls.push({ op: 'create', credential });
        return Promise.resolve(handle);
      },
      destroy: (_handle, credential) => {
        calls.push({ op: 'destroy', credential });
        return Promise.resolve();
      },
      isLive: () => Promise.resolve(true),
      writeFile: (_handle, name, _content, credential) => {
        calls.push({ op: 'write', credential, name });
        return Promise.resolve();
      },
      find: (_config, credential) => {
        calls.push({ op: 'find', credential });
        return Promise.resolve(found);
      },
    };
    const probe = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 401 })));
    const sandboxes = createToolSandboxes({
      driver,
      driverId: 'external',
      origin: (h, base) => `${base}/tool-sandboxes/${h.id}`,
      upstream: (h) => ({ url: `https://49983-${h.externalId}.e2b.test/mcp`, headers: ACCESS }),
      recover: (id) => (id === handle.id ? handle : undefined),
      fetch: probe,
    });
    return { sandboxes, calls, probe };
  }
  const opened = {
    ...session,
    publicBase: 'https://manager.example.dev',
    providerCredential: PROVIDER_KEY,
  };

  it('passes the provider key to every call, probes through the access headers, and returns a manager origin', async () => {
    const { sandboxes, calls, probe } = hosted();
    await expect(sandboxes.open(opened, parseToolSandboxRequest(request()))).resolves.toBe(
      'https://manager.example.dev/tool-sandboxes/sealed-id',
    );
    expect(calls.map((call) => call.op)).toEqual(['find', 'create', 'write', 'write']);
    for (const call of calls) expect(call.credential).toBe(PROVIDER_KEY);
    expect(probe).toHaveBeenCalledWith(
      'https://49983-sbx1.e2b.test/mcp',
      expect.objectContaining({ headers: ACCESS }),
    );
    await sandboxes.close(session, PROVIDER_KEY);
    expect(calls.at(-1)).toEqual({ op: 'destroy', credential: PROVIDER_KEY });
  });

  it('waits past the provider edge answering a closed port (502) for the host to refuse the probe', async () => {
    const { sandboxes, calls, probe } = hosted();
    probe
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    await sandboxes.open(opened, parseToolSandboxRequest(request()));
    expect(probe).toHaveBeenCalledTimes(3);
    expect(calls.map((call) => call.op === 'write' && call.name)).toEqual([
      false,
      false,
      'manifest.json',
      'tokens.json',
    ]);
  });

  it('reuses a sandbox another invocation started: it writes the run token and no manifest', async () => {
    const found: RuntimeHandle = {
      id: 'sealed-id',
      driver: 'external',
      externalId: 'sbx1',
      workspacePath: '/w',
      createdAt: new Date(),
    };
    const { sandboxes, calls } = hosted(found);
    await sandboxes.open(opened, parseToolSandboxRequest(request()));
    expect(calls.map((call) => call.op === 'write' && call.name)).toEqual([false, 'tokens.json']);
  });

  it('closes a sandbox another invocation started when this invocation is asked to', async () => {
    const found: RuntimeHandle = {
      id: 'sealed-id',
      driver: 'external',
      externalId: 'sbx1',
      workspacePath: '/w',
      createdAt: new Date(),
    };
    const { sandboxes, calls } = hosted(found);
    await sandboxes.open(opened, parseToolSandboxRequest(request()));
    await sandboxes.close(session, PROVIDER_KEY);
    expect(calls.at(-1)).toEqual({ op: 'destroy', credential: PROVIDER_KEY });
  });

  it('closes from a fresh instance by the session tags, and revokes the run token when the kill fails', async () => {
    const tagged: Record<string, string>[] = [];
    const writes: string[] = [];
    let fail = false;
    const handle: RuntimeHandle = {
      id: 'sealed-id',
      driver: 'external',
      externalId: 'sbx1',
      workspacePath: '/w',
      createdAt: new Date(),
    };
    const driver: ToolSandboxDriver = {
      create: () => Promise.resolve(handle),
      destroy: () => Promise.reject(new Error('unused')),
      isLive: () => Promise.resolve(true),
      writeFile: (_handle, name, content) => {
        writes.push(`${name}=${content}`);
        return Promise.resolve();
      },
      find: () => Promise.resolve(undefined),
      destroyTagged: (tags) => {
        tagged.push({ ...tags });
        return fail ? Promise.reject(new Error('provider down')) : Promise.resolve();
      },
    };
    const make = () =>
      createToolSandboxes({
        driver,
        driverId: 'external',
        origin: (h, base) => `${base}/tool-sandboxes/${h.id}`,
        upstream: () => ({ url: 'https://8080-sbx1.e2b.test/mcp', headers: ACCESS }),
        fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 401 }))),
      });
    const first = make();
    await first.open(opened, parseToolSandboxRequest(request()));
    // Before the new sandbox starts, whatever the session key still holds is removed.
    expect(tagged).toEqual([
      {
        awWorkspace: 'workspace-one',
        awSession: 'session-one',
        awSessionKey: 'profile-one:session-one',
      },
    ]);
    await make().close(
      { key: '', workspaceId: 'workspace-one', sessionId: 'session-one' },
      PROVIDER_KEY,
    );
    expect(tagged.at(-1)).toEqual({ awWorkspace: 'workspace-one', awSession: 'session-one' });
    // A run's release, from any instance, names the run that started the sandbox and nothing wider.
    await make().release?.({ workspaceId: 'workspace-one', runId: 'run_1' }, PROVIDER_KEY);
    expect(tagged.at(-1)).toEqual({ awWorkspace: 'workspace-one', awRun: 'run_1' });

    fail = true;
    await expect(first.close(session, PROVIDER_KEY)).rejects.toThrow('provider down');
    expect(writes.at(-1)).toBe('tokens.json=[]');
  });

  it('caps the sandbox lifetime at the backstop timeout, plus the margin past it', async () => {
    const { driver, created } = fakeDriver();
    const sandboxes = createToolSandboxes({
      driver,
      origin,
      fetch: serving(),
      timeoutSeconds: 900,
    });
    await sandboxes.open({ ...session, timeoutSeconds: 3_600 }, parseToolSandboxRequest(request()));
    expect(created[0]?.runSpec?.timeoutSeconds).toBe(1_020);
  });

  it('ends a sandbox two minutes after its run deadline, so an unreleased one frees its slot soon (issue #832)', async () => {
    const { driver, created } = fakeDriver();
    const sandboxes = createToolSandboxes({
      driver,
      origin,
      fetch: serving(),
      timeoutSeconds: 900,
    });
    await sandboxes.open({ ...session, timeoutSeconds: 300 }, parseToolSandboxRequest(request()));
    expect(created[0]?.runSpec?.timeoutSeconds).toBe(420);
  });

  it('resolves only an id it handed out, and gives the access headers with it', () => {
    const { sandboxes } = hosted();
    expect(sandboxes.upstream?.('sealed-id')).toEqual({
      url: 'https://49983-sbx1.e2b.test/mcp',
      headers: ACCESS,
    });
    expect(sandboxes.upstream?.('another-id')).toBeUndefined();
  });
});

describe('runner manager allocation with a tool sandbox', () => {
  const allocationBody = {
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

  async function withManager(
    toolSandboxes: Parameters<typeof createRunnerManagerServer>[0]['toolSandboxes'],
    run: (
      post: (body: unknown) => Promise<Response>,
      destroyed: string[],
      remove: (id: string) => Promise<Response>,
      release: (runId: string) => Promise<Response>,
    ) => Promise<void>,
    driverOptions: { destroyFails?: boolean } = {},
  ) {
    const live = new Set<string>();
    const destroyed: string[] = [];
    const driver: ManagedRuntimeDriver = {
      create: (config) => {
        live.add('handle-1');
        return Promise.resolve({
          id: 'handle-1',
          driver: 'docker',
          externalId: 'container-1',
          workspacePath: config.workspacePath,
          createdAt: new Date(),
        });
      },
      destroy: (handle) => {
        live.delete(handle.id);
        destroyed.push(handle.id);
        return driverOptions.destroyFails === true
          ? Promise.reject(new Error('docker rm failed'))
          : Promise.resolve();
      },
      isLive: (handle) => Promise.resolve(live.has(handle.id)),
    };
    const server = createRunnerManagerServer({
      token: MANAGER_TOKEN,
      driver,
      workspacesRoot: '/srv/runtimes',
      runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
      fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok'))),
      ...(toolSandboxes === undefined ? {} : { toolSandboxes }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${String(address.port)}`;
    const post = (body: unknown) =>
      fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${MANAGER_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const remove = (id: string) =>
      fetch(`${base}/runtimes/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${MANAGER_TOKEN}` },
      });
    const release = (runId: string) =>
      fetch(`${base}/tool-sandboxes/runs/${runId}?workspaceId=workspace-one`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${MANAGER_TOKEN}` },
      });
    try {
      await run(post, destroyed, remove, release);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('returns the sandbox origin with the allocation and closes it with the runtime', async () => {
    const open = vi.fn(() => Promise.resolve('http://sandbox:8788'));
    const close = vi.fn(() => Promise.resolve());
    await withManager({ open, close }, async (post) => {
      const response = await post({ ...allocationBody, toolSandbox: request() });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { handle: { id: string }; toolSandbox: unknown };
      expect(body.toolSandbox).toEqual({ origin: 'http://sandbox:8788' });
      expect(open).toHaveBeenCalledWith(
        {
          key: 'profile-one:session-one',
          workspaceId: 'workspace-one',
          sessionId: 'session-one',
          workspacesRoot: '/srv/runtimes',
          publicBase: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u) as string,
        },
        expect.objectContaining({ key: 'tools-1' }),
      );
      const second = await post({ ...allocationBody, toolSandbox: request() });
      expect(second.status).toBe(200);
      expect(open).toHaveBeenCalledTimes(2);
    });
  });

  // Issue #832: a second run of a live session gets the same runtime and is refused by it with
  // `409 session_in_flight`; its release at run end must not end the first run's sandboxes.
  it('leaves the first run runtime and tool sandbox alive when a refused second run of the session is released', async () => {
    const tools = fakeDriver();
    const sandboxes = createToolSandboxes({ driver: tools.driver, origin, fetch: serving() });
    await withManager(sandboxes, async (post, destroyed, _remove, release) => {
      expect((await post({ ...allocationBody, toolSandbox: request() })).status).toBe(201);
      const second = request({ run: { runId: 'run_2', token: 'another-run-token-0123456' } });
      expect((await post({ ...allocationBody, toolSandbox: second })).status).toBe(200);

      expect((await release('run_2')).status).toBe(204);
      expect(destroyed).toEqual([]);
      expect(tools.destroyed).toEqual([]);
      // The session's next allocation still finds its runtime live.
      expect((await post({ ...allocationBody, toolSandbox: request() })).status).toBe(200);

      // The first run's release ends the tool sandbox it started, and never the session runtime.
      expect((await release('run_1')).status).toBe(204);
      expect(tools.destroyed).toEqual(['tool-1']);
      expect(destroyed).toEqual([]);
    });
  });

  it('closes the tool sandbox by session key even when the runtime fails to stop', async () => {
    const close = vi.fn(() => Promise.resolve());
    await withManager(
      { open: vi.fn(() => Promise.resolve('http://sandbox:8788')), close },
      async (post, _destroyed, remove) => {
        const response = await post({ ...allocationBody, toolSandbox: request() });
        const { handle } = (await response.json()) as { handle: { id: string } };
        const removed = await remove(handle.id);
        expect(removed.status).toBeGreaterThanOrEqual(500);
        expect(close).toHaveBeenCalledWith(
          {
            key: 'profile-one:session-one',
            workspaceId: 'workspace-one',
            sessionId: 'session-one',
          },
          undefined,
        );
      },
      { destroyFails: true },
    );
  });

  it('drops the allocation once the runtime is gone even when the tool sandbox fails to close', async () => {
    const close = vi.fn(() => Promise.reject(new Error('docker rm failed')));
    await withManager(
      { open: vi.fn(() => Promise.resolve('http://sandbox:8788')), close },
      async (post, _destroyed, remove) => {
        const response = await post({ ...allocationBody, toolSandbox: request() });
        const { handle } = (await response.json()) as { handle: { id: string } };
        expect((await remove(handle.id)).status).toBe(500);
        expect((await remove(handle.id)).status).toBe(404);
        expect((await post({ ...allocationBody, toolSandbox: request() })).status).toBe(201);
      },
    );
  });

  it('answers 503 tool_sandbox_unavailable, and starts no runtime, when none is configured', async () => {
    await withManager(undefined, async (post, destroyed) => {
      const response = await post({ ...allocationBody, toolSandbox: request() });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'tool_sandbox_unavailable' });
      expect(JSON.stringify(destroyed)).toBe('[]');
    });
  });

  it('removes the new runtime when its tool sandbox cannot start', async () => {
    const open = vi.fn(() => Promise.reject(new ToolSandboxUnavailableError('no image')));
    await withManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post, destroyed) => {
      const response = await post({ ...allocationBody, toolSandbox: request() });
      expect(response.status).toBe(503);
      expect(destroyed).toEqual(['handle-1']);
    });
  });

  it('keeps the 503 and logs the cleanup failure when the new runtime cannot be removed either', async () => {
    const open = vi.fn(() => Promise.reject(new ToolSandboxUnavailableError('no image')));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withManager(
        { open, close: vi.fn(() => Promise.resolve()) },
        async (post, destroyed) => {
          const response = await post({ ...allocationBody, toolSandbox: request() });
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: 'tool_sandbox_unavailable' });
          expect(destroyed).toEqual(['handle-1']);
        },
        { destroyFails: true },
      );
      expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain(
        'docker rm failed',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('serves a tool sandbox /mcp with the host token and the provider headers, not the manager token', async () => {
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"ok":true}')));
    const lookup = vi.fn((id: string) =>
      id === 'known'
        ? { url: 'https://49983-sbx1.e2b.test/mcp', headers: { 'e2b-traffic-access-token': 'T' } }
        : undefined,
    );
    const server = createRunnerManagerServer({
      token: MANAGER_TOKEN,
      driver: {
        create: () => Promise.reject(new Error('unused')),
        destroy: () => Promise.resolve(),
        isLive: () => Promise.resolve(true),
      },
      workspacesRoot: '/srv/runtimes',
      fetch: upstream,
      toolSandboxes: {
        open: () => Promise.resolve('x'),
        close: () => Promise.resolve(),
        upstream: lookup,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const call = (
      id: string,
      method = 'POST',
      headers: Record<string, string> = {
        authorization: `Bearer ${MANAGER_TOKEN}`,
        'x-aw-tool-authorization': 'Bearer host-run-token',
      },
    ) =>
      fetch(`http://127.0.0.1:${String(address.port)}/tool-sandboxes/${id}/mcp`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    try {
      // ADR-0132: the manager token first, then the run token, both before any sandbox lookup.
      for (const headers of [
        { 'x-aw-tool-authorization': 'Bearer host-run-token' },
        { authorization: 'Bearer host-run-token' },
        {
          authorization: 'Bearer not-the-manager-token-0123456789-0123456789',
          'x-aw-tool-authorization': 'Bearer host-run-token',
        },
        { authorization: `Bearer ${MANAGER_TOKEN}` },
      ]) {
        const refused = await call('known', 'POST', headers);
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ error: 'unauthorized' });
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
      const ok = await call('known');
      expect(ok.status).toBe(200);
      const [url, init] = upstream.mock.calls[0] ?? [];
      expect(url).toBe('https://49983-sbx1.e2b.test/mcp');
      const sent = new Headers(init?.headers);
      expect(sent.get('authorization')).toBe('Bearer host-run-token');
      expect(sent.get('x-aw-tool-authorization')).toBeNull();
      expect(JSON.stringify([...sent])).not.toContain(MANAGER_TOKEN);
      expect(sent.get('e2b-traffic-access-token')).toBe('T');
      expect((await call('unknown')).status).toBe(404);
      expect((await call('known', 'GET')).status).toBe(404);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes the tool sandbox by workspace and session on a stateless manager, which knows no session key', async () => {
    const close = vi.fn(() => Promise.resolve());
    const handle: RuntimeHandle = {
      id: 'sealed-runtime',
      driver: 'external',
      externalId: 'sbx-runtime',
      workspacePath: '/srv/runtimes/workspace-one/session-one',
      createdAt: new Date(),
    };
    const server = createRunnerManagerServer({
      token: MANAGER_TOKEN,
      driver: {
        create: () => Promise.reject(new Error('unused')),
        destroy: () => Promise.resolve(),
        isLive: () => Promise.resolve(true),
        find: () => Promise.resolve(undefined),
        recover: (id) => (id === handle.id ? handle : undefined),
      },
      workspacesRoot: '/srv/runtimes',
      toolSandboxes: { open: () => Promise.resolve('x'), close },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      const removed = await fetch(
        `http://127.0.0.1:${String(address.port)}/runtimes/${handle.id}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${MANAGER_TOKEN}`, 'x-provider-credential': 'k' },
        },
      );
      expect(removed.status).toBe(204);
      expect(close).toHaveBeenCalledWith(
        { key: '', workspaceId: 'workspace-one', sessionId: 'session-one' },
        'k',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses an invalid toolSandbox with 400 and echoes no value', async () => {
    await withManager(
      { open: vi.fn(() => Promise.resolve('x')), close: vi.fn(() => Promise.resolve()) },
      async (post) => {
        const response = await post({
          ...allocationBody,
          toolSandbox: request({ run: { runId: 'r', token: 'short' }, extra: SECRET }),
        });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain(SECRET);
      },
    );
  });
});

describe('runner manager POST /tool-sandboxes (a project endpoint client)', () => {
  const endpointBody = (overrides: Record<string, unknown> = {}) => ({
    workspaceId: 'workspace-one',
    clientId: 'client-one',
    toolSandbox: request(),
    ...overrides,
  });

  async function withEndpointManager(
    toolSandboxes: Parameters<typeof createRunnerManagerServer>[0]['toolSandboxes'],
    run: (
      post: (
        body: unknown,
        authorized?: boolean,
        extra?: Record<string, string>,
      ) => Promise<Response>,
    ) => Promise<void>,
  ) {
    const driver: ManagedRuntimeDriver = {
      create: vi.fn(() => Promise.reject(new Error('an endpoint sandbox starts no agent runtime'))),
      destroy: vi.fn(() => Promise.resolve()),
      isLive: () => Promise.resolve(false),
    };
    const server = createRunnerManagerServer({
      token: MANAGER_TOKEN,
      driver,
      workspacesRoot: '/srv/runtimes',
      runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
      fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok'))),
      ...(toolSandboxes === undefined ? {} : { toolSandboxes }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      await run((body, authorized = true, extra = {}) =>
        fetch(`http://127.0.0.1:${String(address.port)}/tool-sandboxes`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorized ? { authorization: `Bearer ${MANAGER_TOKEN}` } : {}),
            ...extra,
          },
          body: JSON.stringify(body),
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('opens the client sandbox, keyed by client, and starts no runtime', async () => {
    const open = vi.fn(() => Promise.resolve('http://runner:7001/tool-sandboxes/sealed'));
    await withEndpointManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post) => {
      const response = await post(endpointBody(), true, { 'x-provider-credential': 'e2b-key' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        toolSandbox: { origin: 'http://runner:7001/tool-sandboxes/sealed' },
      });
      expect(open).toHaveBeenCalledWith(
        {
          key: 'endpoint:client-one',
          workspaceId: 'workspace-one',
          sessionId: 'client-one',
          workspacesRoot: '/srv/runtimes',
          publicBase: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u) as string,
          providerCredential: 'e2b-key',
        },
        expect.objectContaining({ key: 'tools-1' }),
      );
    });
  });

  it('requires the manager token', async () => {
    const open = vi.fn(() => Promise.resolve('x'));
    await withEndpointManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post) => {
      const response = await post(endpointBody(), false);
      expect(response.status).toBe(401);
      expect(open).not.toHaveBeenCalled();
    });
  });

  it('answers 503 tool_sandbox_unavailable when none is configured', async () => {
    await withEndpointManager(undefined, async (post) => {
      const response = await post(endpointBody());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'tool_sandbox_unavailable' });
    });
  });

  describe('DELETE /tool-sandboxes/sessions/<clientId>', () => {
    async function withClosing(
      toolSandboxes: Parameters<typeof createRunnerManagerServer>[0]['toolSandboxes'],
      run: (del: (path: string, authorized?: boolean) => Promise<Response>) => Promise<void>,
    ) {
      const server = createRunnerManagerServer({
        token: MANAGER_TOKEN,
        driver: {
          create: vi.fn(() => Promise.reject(new Error('no runtime'))),
          destroy: vi.fn(() => Promise.resolve()),
          isLive: () => Promise.resolve(false),
        },
        workspacesRoot: '/srv/runtimes',
        runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
        fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok'))),
        ...(toolSandboxes === undefined ? {} : { toolSandboxes }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        await run((path, authorized = true) =>
          fetch(`http://127.0.0.1:${String(address.port)}${path}`, {
            method: 'DELETE',
            headers: {
              ...(authorized ? { authorization: `Bearer ${MANAGER_TOKEN}` } : {}),
              'x-provider-credential': SECRET,
            },
          }),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    it('requires the manager token', async () => {
      const close = vi.fn(() => Promise.resolve());
      await withClosing({ open: vi.fn(), close }, async (del) => {
        const response = await del('/tool-sandboxes/sessions/client-one?workspaceId=w', false);
        expect(response.status).toBe(401);
        expect(close).not.toHaveBeenCalled();
      });
    });

    it('closes only the key it builds from the client id', async () => {
      const close = vi.fn(() => Promise.resolve());
      await withClosing({ open: vi.fn(), close }, async (del) => {
        const response = await del('/tool-sandboxes/sessions/client-one?workspaceId=workspace-one');
        expect(response.status).toBe(204);
        expect(close).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith(
          { key: 'endpoint:client-one', workspaceId: 'workspace-one', sessionId: 'client-one' },
          SECRET,
        );
      });
    });

    it('refuses a malformed client id or workspace with 400', async () => {
      const close = vi.fn(() => Promise.resolve());
      await withClosing({ open: vi.fn(), close }, async (del) => {
        for (const path of [
          '/tool-sandboxes/sessions/bad%20id?workspaceId=w',
          '/tool-sandboxes/sessions/client-one',
          '/tool-sandboxes/sessions/client-one?workspaceId=..%2Fx',
        ]) {
          expect((await del(path)).status).toBe(400);
        }
        expect(close).not.toHaveBeenCalled();
      });
    });

    it('does not match the gateway route below a session', async () => {
      const close = vi.fn(() => Promise.resolve());
      await withClosing({ open: vi.fn(), close }, async (del) => {
        const response = await del('/tool-sandboxes/sessions/x/mcp?workspaceId=w');
        expect(response.status).not.toBe(204);
        expect(close).not.toHaveBeenCalled();
      });
    });

    it('answers 204 when no tool sandbox is configured', async () => {
      await withClosing(undefined, async (del) => {
        expect((await del('/tool-sandboxes/sessions/client-one?workspaceId=w')).status).toBe(204);
      });
    });

    it('answers 500 without the credential when the close fails', async () => {
      const close = vi.fn(() => Promise.reject(new Error('boom')));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await withClosing({ open: vi.fn(), close }, async (del) => {
          const response = await del('/tool-sandboxes/sessions/client-one?workspaceId=w');
          expect(response.status).toBe(500);
          expect(await response.text()).not.toContain(SECRET);
        });
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it('refuses a bad body with 400 and echoes no value', async () => {
    const open = vi.fn(() => Promise.resolve('x'));
    await withEndpointManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post) => {
      for (const body of [
        endpointBody({
          toolSandbox: request({ run: { runId: 'r', token: 'short' }, extra: SECRET }),
        }),
        endpointBody({ clientId: '../escape' }),
        endpointBody({ workspaceId: undefined }),
      ]) {
        const response = await post(body);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain(SECRET);
      }
      expect(open).not.toHaveBeenCalled();
    });
  });
});
