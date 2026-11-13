import { expect, it, vi } from 'vitest';
import { createRunnerManagerServer } from './manager.js';
import type { ManagedRuntimeDriver } from './manager-support.js';
import { ToolSandboxUnavailableError } from './tool-sandbox.js';
import { SECRET, MANAGER_TOKEN, TOKEN, request } from './tool-sandbox.fixture.test-support.js';

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

it('runner manager POST /tool-sandboxes (a project endpoint client) > opens the client sandbox, keyed by client, and starts no runtime', async () => {
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

it('runner manager POST /tool-sandboxes (a project endpoint client) > requires the manager token', async () => {
  const open = vi.fn(() => Promise.resolve('x'));
  await withEndpointManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post) => {
    const response = await post(endpointBody(), false);
    expect(response.status).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });
});

it('runner manager POST /tool-sandboxes (a project endpoint client) > answers 503 tool_sandbox_unavailable when none is configured', async () => {
  await withEndpointManager(undefined, async (post) => {
    const response = await post(endpointBody());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'tool_sandbox_unavailable' });
  });
});

it('runner manager POST /tool-sandboxes (a project endpoint client) > logs why it answered 503, with no request value', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const open = vi.fn(() =>
      Promise.reject(
        new ToolSandboxUnavailableError(
          'the tool sandbox could not be prepared: writing manifest.json was refused with HTTP 500.',
        ),
      ),
    );
    await withEndpointManager({ open, close: vi.fn(() => Promise.resolve()) }, async (post) => {
      const response = await post(endpointBody(), true, { 'x-provider-credential': SECRET });
      expect(response.status).toBe(503);
    });
    const logged = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(logged).toContain(
      'runner manager tool sandbox unavailable (POST /tool-sandboxes): the tool sandbox could not be prepared: writing manifest.json was refused with HTTP 500.',
    );
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(MANAGER_TOKEN);
    expect(logged).not.toContain(TOKEN);
  } finally {
    stderr.mockRestore();
  }
});

it('runner manager POST /tool-sandboxes (a project endpoint client) > DELETE /tool-sandboxes/sessions/<clientId> > requires the manager token', async () => {
  const close = vi.fn(() => Promise.resolve());
  await withClosing({ open: vi.fn(), close }, async (del) => {
    const response = await del('/tool-sandboxes/sessions/client-one?workspaceId=w', false);
    expect(response.status).toBe(401);
    expect(close).not.toHaveBeenCalled();
  });
});

it('runner manager POST /tool-sandboxes (a project endpoint client) > DELETE /tool-sandboxes/sessions/<clientId> > closes only the key it builds from the client id', async () => {
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

it('runner manager POST /tool-sandboxes (a project endpoint client) > DELETE /tool-sandboxes/sessions/<clientId> > refuses a malformed client id or workspace with 400', async () => {
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

it('runner manager POST /tool-sandboxes (a project endpoint client) > DELETE /tool-sandboxes/sessions/<clientId> > does not match the gateway route below a session', async () => {
  const close = vi.fn(() => Promise.resolve());
  await withClosing({ open: vi.fn(), close }, async (del) => {
    const response = await del('/tool-sandboxes/sessions/x/mcp?workspaceId=w');
    expect(response.status).not.toBe(204);
    expect(close).not.toHaveBeenCalled();
  });
});

it('runner manager POST /tool-sandboxes (a project endpoint client) > DELETE /tool-sandboxes/sessions/<clientId> > answers 204 when no tool sandbox is configured', async () => {
  await withClosing(undefined, async (del) => {
    expect((await del('/tool-sandboxes/sessions/client-one?workspaceId=w')).status).toBe(204);
  });
});

it('runner manager POST /tool-sandboxes (a project endpoint client) > DELETE /tool-sandboxes/sessions/<clientId> > answers 500 without the credential when the close fails', async () => {
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

it('runner manager POST /tool-sandboxes (a project endpoint client) > refuses a bad body with 400 and echoes no value', async () => {
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
