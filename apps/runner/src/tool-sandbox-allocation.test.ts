import { expect, it, vi } from 'vitest';
import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import { createRunnerManagerServer } from './manager.js';
import type { ManagedRuntimeDriver } from './manager-support.js';
import { createToolSandboxes, ToolSandboxUnavailableError } from './tool-sandbox.js';
import {
  SECRET,
  MANAGER_TOKEN,
  request,
  fakeDriver,
  serving,
  origin,
} from './tool-sandbox.fixture.test-support.js';

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
  const { driver, destroyed } = allocationDriver(driverOptions);
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

it('runner manager allocation with a tool sandbox > returns the sandbox origin with the allocation and closes it with the runtime', async () => {
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
it('runner manager allocation with a tool sandbox > leaves the first run runtime and tool sandbox alive when a refused second run of the session is released', async () => {
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

it('runner manager allocation with a tool sandbox > closes the tool sandbox by session key even when the runtime fails to stop', async () => {
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

it('runner manager allocation with a tool sandbox > drops the allocation once the runtime is gone even when the tool sandbox fails to close', async () => {
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

it('runner manager allocation with a tool sandbox > answers 503 tool_sandbox_unavailable, and starts no runtime, when none is configured', async () => {
  await withManager(undefined, async (post, destroyed) => {
    const response = await post({ ...allocationBody, toolSandbox: request() });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'tool_sandbox_unavailable' });
    expect(JSON.stringify(destroyed)).toBe('[]');
  });
});

it('runner manager allocation with a tool sandbox > removes the new runtime when its tool sandbox cannot start', async () => {
  const open = vi.fn(() => Promise.reject(new ToolSandboxUnavailableError('no image')));
  await withManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post, destroyed) => {
    const response = await post({ ...allocationBody, toolSandbox: request() });
    expect(response.status).toBe(503);
    expect(destroyed).toEqual(['handle-1']);
  });
});

it('runner manager allocation with a tool sandbox > keeps the 503 and logs the cleanup failure when the new runtime cannot be removed either', async () => {
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
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain('docker rm failed');
  } finally {
    stderr.mockRestore();
  }
});

it('runner manager allocation with a tool sandbox > serves a tool sandbox /mcp with the host token and the provider headers, not the manager token', async () => {
  const { server, upstream, lookup } = toolProxyFixture();
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

it('runner manager allocation with a tool sandbox > closes the tool sandbox by workspace and session on a stateless manager, which knows no session key', async () => {
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
    const removed = await fetch(`http://127.0.0.1:${String(address.port)}/runtimes/${handle.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${MANAGER_TOKEN}`, 'x-provider-credential': 'k' },
    });
    expect(removed.status).toBe(204);
    expect(close).toHaveBeenCalledWith(
      { key: '', workspaceId: 'workspace-one', sessionId: 'session-one' },
      'k',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('runner manager allocation with a tool sandbox > refuses an invalid toolSandbox with 400 and echoes no value', async () => {
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

function allocationDriver(driverOptions: { destroyFails?: boolean }) {
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
  return { driver, destroyed };
}

function toolProxyFixture() {
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
  return { server, upstream, lookup };
}
