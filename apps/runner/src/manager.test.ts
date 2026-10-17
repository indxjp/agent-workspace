import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { RuntimeHandle } from '@agent-workspace/runtime';

import { createRunnerManagerServer, type ManagedRuntimeDriver } from './manager.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

function fixtureDriver(): {
  driver: ManagedRuntimeDriver;
  create: ReturnType<typeof vi.fn<ManagedRuntimeDriver['create']>>;
  destroy: ReturnType<typeof vi.fn<ManagedRuntimeDriver['destroy']>>;
} {
  const live = new Set<string>();
  const create = vi.fn<ManagedRuntimeDriver['create']>((config) => {
    const handle: RuntimeHandle = {
      id: `handle-${String(live.size + 1)}`,
      driver: 'docker',
      externalId: `container-${String(live.size + 1)}`,
      workspacePath: config.workspacePath,
      createdAt: new Date('2026-09-10T00:00:00Z'),
    };
    live.add(handle.id);
    return Promise.resolve(handle);
  });
  const destroy = vi.fn<ManagedRuntimeDriver['destroy']>((handle) => {
    live.delete(handle.id);
    return Promise.resolve();
  });
  return {
    create,
    destroy,
    driver: {
      create,
      destroy,
      isLive: (handle) => Promise.resolve(live.has(handle.id)),
    },
  };
}

async function withManager(
  run: (
    base: string,
    fixture: ReturnType<typeof fixtureDriver>,
    proxy: ReturnType<typeof vi.fn<typeof fetch>>,
  ) => Promise<void>,
): Promise<void> {
  const fixture = fixtureDriver();
  const proxy = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('event: run-done\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  const server = createRunnerManagerServer({
    token: TOKEN,
    driver: fixture.driver,
    workspacesRoot: '/srv/runtimes',
    runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
    fetch: proxy,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    await run(`http://127.0.0.1:${String(address.port)}`, fixture, proxy);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

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

const authenticated = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

describe('runner manager Docker lifecycle', () => {
  it('requires its private bearer and reuses live session/profile affinity', async () => {
    await withManager(async (base, fixture) => {
      expect(
        (
          await fetch(`${base}/runtimes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(allocationBody),
          })
        ).status,
      ).toBe(401);

      const first = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      expect(first.status).toBe(201);
      const firstValue = (await first.json()) as { handle: RuntimeHandle; runnerUrl: string };
      expect(firstValue.runnerUrl).toBe(`${base}/runtimes/${firstValue.handle.id}`);
      const createdConfig = fixture.create.mock.calls[0]?.[0];
      expect(createdConfig?.sessionId).toBe('session-one');
      expect(createdConfig?.workspacePath).toMatch(
        /srv[\\/]runtimes[\\/]workspace-one[\\/]session-one/u,
      );

      const reused = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      expect(reused.status).toBe(200);
      expect(fixture.create).toHaveBeenCalledTimes(1);
    });
  });

  it('creates one runtime for two concurrent requests of the same session', async () => {
    await withManager(async (base, fixture) => {
      // A container takes time to start; both requests must arrive inside that window.
      const create = fixture.create.getMockImplementation();
      if (create === undefined) throw new Error('the fixture has no create');
      fixture.create.mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return create(...args);
      });
      const allocate = (): Promise<Response> =>
        fetch(`${base}/runtimes`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify(allocationBody),
        });
      const answers = await Promise.all([allocate(), allocate()]);
      expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 201]);
      expect(fixture.create).toHaveBeenCalledTimes(1);
    });
  });

  it("echoes the caller's scheme in runnerUrl instead of always http, per X-Forwarded-Proto", async () => {
    // A reverse proxy — Cloud Run's own edge included — terminates TLS and forwards plain HTTP to
    // this server, so trusting the literal connection scheme here would bake `http:` into
    // `runnerUrl` even when every real caller used `https:`. A caller that then POSTs to that
    // `http:` URL hits Cloud Run's http→https redirect, which drops `Authorization` across the
    // scheme change — turning the caller's next `/run` into a 401 this manager issued against
    // itself. `X-Forwarded-Proto` is what a caller's own request actually arrived as.
    await withManager(async (base) => {
      const created = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: { ...authenticated, 'x-forwarded-proto': 'https' },
        body: JSON.stringify(allocationBody),
      });
      expect(created.status).toBe(201);
      const value = (await created.json()) as { runnerUrl: string };
      expect(value.runnerUrl.startsWith('https://')).toBe(true);
    });
  });

  it('proxies the runtime contract by handle and destroys only that allocation', async () => {
    await withManager(async (base, fixture, proxy) => {
      const created = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      const value = (await created.json()) as { handle: RuntimeHandle; runnerUrl: string };
      const run = await fetch(`${value.runnerUrl}/run`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ runId: 'run-one' }),
      });
      expect(await run.text()).toContain('run-done');
      expect(proxy).toHaveBeenCalledWith(
        `http://${value.handle.externalId}:8080/run`,
        expect.objectContaining({ method: 'POST' }),
      );

      const removed = await fetch(`${value.runnerUrl}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(removed.status).toBe(204);
      expect(fixture.destroy).toHaveBeenCalledOnce();
      expect(
        (
          await fetch(`${value.runnerUrl}`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(404);
    });
  });

  it('refuses caller-controlled path segments and non-Docker profiles', async () => {
    await withManager(async (base) => {
      const escaped = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ ...allocationBody, workspaceId: '../outside' }),
      });
      expect(escaped.status).toBe(400);
      const local = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({
          ...allocationBody,
          runSpec: { ...allocationBody.runSpec, driver: 'local' },
        }),
      });
      expect(local.status).toBe(400);
    });
  });

  it.each([
    ['workspaceId', { workspaceId: '../outside' }, 'invalid_workspace_id'],
    ['sessionId', { sessionId: 'a/b' }, 'invalid_session_id'],
    ['an empty engine', { engine: '' }, 'invalid_engine'],
    ['a missing engine', { engine: undefined }, 'invalid_engine'],
    ['an invalid runSpec', { runSpec: { driver: 'docker' } }, 'invalid_run_spec'],
    [
      'a driver other than the expected one',
      { runSpec: { ...allocationBody.runSpec, driver: 'local' } },
      'invalid_run_spec',
    ],
  ])('answers 400 %s with a typed code on /runtimes and /verify', async (_label, fields, code) => {
    await withManager(async (base, fixture) => {
      for (const path of ['/runtimes', '/verify']) {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify({ ...allocationBody, ...fields }),
        });
        expect(response.status).toBe(400);
        const answer = (await response.json()) as { error: string; message: string };
        expect(answer.error).toBe(code);
        expect(answer.message).not.toBe('');
      }
      expect(fixture.create).not.toHaveBeenCalled();
    });
  });

  it('answers 400 invalid_body for a body that is not a JSON object', async () => {
    await withManager(async (base) => {
      for (const body of ['not json', '[]']) {
        const response = await fetch(`${base}/verify`, {
          method: 'POST',
          headers: authenticated,
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'invalid_body' });
      }
    });
  });

  it('answers 400 invalid_tool_sandbox for an invalid toolSandbox', async () => {
    await withManager(async (base, fixture) => {
      const response = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ ...allocationBody, toolSandbox: {} }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_tool_sandbox' });
      expect(fixture.create).not.toHaveBeenCalled();
    });
  });

  it('answers 400 request_too_large for a /verify body over its limit', async () => {
    await withManager(async (base, fixture) => {
      // /verify reads at most 2 MiB (MAX_BODY_BYTES in manager.ts).
      const response = await fetch(`${base}/verify`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 1) }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'request_too_large' });
      expect(fixture.create).not.toHaveBeenCalled();
    });
  });

  it('does not expose driver failures as client validation errors', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withManager(async (base, fixture) => {
        fixture.create.mockRejectedValueOnce(new Error('sentinel registry credential leaked'));
        const response = await fetch(`${base}/runtimes`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify(allocationBody),
        });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'internal_error' });
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('sentinel registry credential leaked'),
        );
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ['a string CPU value', { cpu: '2' }],
    ['an unknown network policy', { networkPolicy: 'allowlist' }],
    ['a non-string allowed domain', { allowedDomains: ['example.com', 3] }],
    ['an unknown filesystem mode', { filesystem: 'writable' }],
    ['a non-positive timeout', { timeoutSeconds: 0 }],
    ['fractional memory', { memoryMb: 0.5 }],
    ['fractional disk', { diskMb: 12.5 }],
    ['a fractional timeout', { idleTimeoutSeconds: 1.5 }],
    ['an unknown field', { unexpected: true }],
  ])('refuses runtime specifications with %s', async (_label, invalidFields) => {
    await withManager(async (base, fixture) => {
      const response = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({
          ...allocationBody,
          runSpec: { ...allocationBody.runSpec, ...invalidFields },
        }),
      });

      expect(response.status).toBe(400);
      expect(fixture.create).not.toHaveBeenCalled();
    });
  });

  it('accepts a non-docker profile only when it matches the configured expectedDriver, and attaches runtimeAuthHeaders to proxied calls', async () => {
    const fixture = fixtureDriver();
    const proxy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('event: run-done\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const server = createRunnerManagerServer({
      token: TOKEN,
      driver: fixture.driver,
      workspacesRoot: '/srv/runtimes',
      runtimeOrigin: (handle) => `https://${handle.externalId}.a.run.app`,
      expectedDriver: 'cloud-run-service',
      runtimeAuthHeaders: (handle) => Promise.resolve({ authorization: `Bearer id-${handle.id}` }),
      fetch: proxy,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      const base = `http://127.0.0.1:${String(address.port)}`;
      const cloudRunBody = {
        ...allocationBody,
        runSpec: { ...allocationBody.runSpec, driver: 'cloud-run-service' },
      };
      const refusedAsDocker = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      expect(refusedAsDocker.status).toBe(400);

      const created = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(cloudRunBody),
      });
      expect(created.status).toBe(201);
      const value = (await created.json()) as { handle: RuntimeHandle; runnerUrl: string };
      await fetch(`${value.runnerUrl}/run`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ runId: 'run-one' }),
      });
      // The first call is `waitUntilInvocable`'s own readiness probe, made during `POST
      // /runtimes` before this allocation is ever handed back — the proxied `/run` is whichever
      // call actually targets it.
      const runCall = proxy.mock.calls.find(
        ([input]) =>
          (input instanceof Request ? input.url : String(input)) ===
          `https://${value.handle.externalId}.a.run.app/run`,
      );
      const [calledUrl, calledInit] = runCall ?? [];
      expect(calledUrl).toBe(`https://${value.handle.externalId}.a.run.app/run`);
      expect(new Headers((calledInit as RequestInit).headers).get('authorization')).toBe(
        `Bearer id-${value.handle.id}`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses runtimeRequestUrl for every ACA readiness, verification, and proxy request', async () => {
    const fixture = fixtureDriver();
    const proxy = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/verify/echo') {
        if (typeof init?.body !== 'string') throw new Error('expected JSON echo body');
        const request = JSON.parse(init.body) as { nonce: string };
        return Promise.resolve(Response.json({ nonce: request.nonce }));
      }
      if (url.pathname === '/ping') return Promise.resolve(Response.json({ status: 'ok' }));
      return Promise.resolve(
        new Response('event: run-done\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    const runtimeRequestUrl = vi.fn((handle: RuntimeHandle, requestPath: string) => {
      const url = new URL(requestPath, 'https://pool.westeurope.azurecontainerapps.io');
      url.searchParams.set('identifier', handle.externalId);
      return url.toString();
    });
    const server = createRunnerManagerServer({
      token: TOKEN,
      driver: fixture.driver,
      workspacesRoot: '/srv/runtimes',
      expectedDriver: 'aca-sessions',
      runtimeRequestUrl,
      runtimeAuthHeaders: () => Promise.resolve({ authorization: 'Bearer azure-access-token' }),
      readinessPath: '/ping',
      fetch: proxy,
      verificationTimeoutMs: 1_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${String(address.port)}`;
    const acaBody = {
      ...allocationBody,
      runSpec: { ...allocationBody.runSpec, driver: 'aca-sessions' },
    };
    try {
      const created = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(acaBody),
      });
      expect(created.status).toBe(201);
      const value = (await created.json()) as { runnerUrl: string };
      for (const [operation, method] of [
        ['run', 'POST'],
        ['interrupt', 'POST'],
        ['files?path=workspace%2FREADME.md', 'GET'],
      ] as const) {
        await fetch(`${value.runnerUrl}/${operation}`, {
          method,
          headers: authenticated,
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
      }
      const verified = await fetch(`${base}/verify`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(acaBody),
      });
      expect(verified.status).toBe(200);

      const upstream = proxy.mock.calls.map(([input, init]) => ({
        url: new URL(input instanceof Request ? input.url : String(input)),
        headers: new Headers(init?.headers),
      }));
      expect(upstream.map(({ url }) => url.pathname)).toEqual([
        '/ping',
        '/run',
        '/interrupt',
        '/files',
        '/ping',
        '/verify/echo',
      ]);
      for (const { url, headers } of upstream) {
        expect(url.searchParams.get('identifier')).toMatch(/^container-/u);
        expect(headers.get('authorization')).toBe('Bearer azure-access-token');
      }
      for (const [, init] of proxy.mock.calls) expect(init?.redirect).toBe('error');
      expect(upstream[3]?.url.searchParams.get('path')).toBe('workspace/README.md');
      expect(runtimeRequestUrl).toHaveBeenCalledTimes(6);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects upstream redirects without following them for readiness, run, or verification', async () => {
    let followed = 0;
    let redirectHealth = false;
    let upstreamBase = '';
    const upstream = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', upstreamBase);
      if (requestUrl.pathname === '/followed') {
        followed += 1;
        res.writeHead(200).end('redirect followed');
        return;
      }
      if (
        requestUrl.pathname === '/run' ||
        requestUrl.pathname === '/verify/echo' ||
        (requestUrl.pathname === '/healthz' && redirectHealth)
      ) {
        res.writeHead(302, { location: `${upstreamBase}/followed` }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === 'string') {
      throw new Error('no upstream address');
    }
    upstreamBase = `http://127.0.0.1:${String(upstreamAddress.port)}`;

    const fixture = fixtureDriver();
    const manager = createRunnerManagerServer({
      token: TOKEN,
      driver: fixture.driver,
      workspacesRoot: '/srv/runtimes',
      runtimeOrigin: () => upstreamBase,
      verificationTimeoutMs: 150,
    });
    await new Promise<void>((resolve) => manager.listen(0, '127.0.0.1', resolve));
    const managerAddress = manager.address();
    if (managerAddress === null || typeof managerAddress === 'string') {
      throw new Error('no manager address');
    }
    const base = `http://127.0.0.1:${String(managerAddress.port)}`;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const created = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      expect(created.status).toBe(201);
      const value = (await created.json()) as { runnerUrl: string };

      const run = await fetch(`${value.runnerUrl}/run`, {
        method: 'POST',
        headers: authenticated,
        body: '{}',
      });
      // A refused upstream redirect is an upstream failure, not a caller mistake: the manager
      // reports it as `internal_error` rather than echoing it as a 400.
      expect(run.status).toBe(500);

      const verify = await fetch(`${base}/verify`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      expect(verify.status).toBe(500);

      redirectHealth = true;
      const readiness = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({ ...allocationBody, sessionId: 'session-two' }),
      });
      expect(readiness.status).toBe(500);
      expect(followed).toBe(0);
    } finally {
      await new Promise<void>((resolve) => manager.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      stderr.mockRestore();
    }
  });

  it('verifies create, readiness, echo, and guaranteed teardown', async () => {
    const fixture = fixtureDriver();
    const proxy = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/healthz')) return Promise.resolve(Response.json({ status: 'ok' }));
      if (typeof init?.body !== 'string') throw new Error('expected JSON echo body');
      const request = JSON.parse(init.body) as { nonce: string };
      return Promise.resolve(Response.json({ nonce: request.nonce }));
    });
    const server = createRunnerManagerServer({
      token: TOKEN,
      driver: fixture.driver,
      workspacesRoot: '/srv/runtimes',
      runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
      fetch: proxy,
      verificationTimeoutMs: 1_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/verify`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify(allocationBody),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { fingerprint?: unknown };
      expect(typeof result.fingerprint).toBe('string');
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(fixture.create).toHaveBeenCalledOnce();
      expect(fixture.destroy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
