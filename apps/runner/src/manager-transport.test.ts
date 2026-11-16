import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import { createRunnerManagerServer } from './manager.js';
import {
  TOKEN,
  fixtureDriver,
  allocationBody,
  authenticated,
  allocate,
} from './manager.fixture.test-support.js';

it('runner manager Docker lifecycle > accepts a non-docker profile only when it matches the configured expectedDriver, and attaches runtimeAuthHeaders to proxied calls', async () => {
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
    const refusedAsDocker = await allocate(base);
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

it('runner manager Docker lifecycle > uses runtimeRequestUrl for every ACA readiness, verification, and proxy request', async () => {
  const { server, proxy, runtimeRequestUrl } = acaTransportFixture();
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

it('runner manager Docker lifecycle > rejects upstream redirects without following them for readiness, run, or verification', async () => {
  const { upstream, state } = await redirectingRuntimeFixture();
  const fixture = fixtureDriver();
  const manager = createRunnerManagerServer({
    token: TOKEN,
    driver: fixture.driver,
    workspacesRoot: '/srv/runtimes',
    runtimeOrigin: () => state.upstreamBase,
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
    const created = await allocate(base);
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

    state.redirectHealth = true;
    const readiness = await fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ ...allocationBody, sessionId: 'session-two' }),
    });
    expect(readiness.status).toBe(500);
    expect(state.followed).toBe(0);
  } finally {
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    stderr.mockRestore();
  }
});

function acaTransportFixture() {
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
  return { server, proxy, runtimeRequestUrl };
}

async function redirectingRuntimeFixture() {
  const state = { followed: 0, redirectHealth: false, upstreamBase: '' };
  const upstream = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', state.upstreamBase);
    if (requestUrl.pathname === '/followed') {
      state.followed += 1;
      res.writeHead(200).end('redirect followed');
      return;
    }
    if (
      requestUrl.pathname === '/run' ||
      requestUrl.pathname === '/verify/echo' ||
      (requestUrl.pathname === '/healthz' && state.redirectHealth)
    ) {
      res.writeHead(302, { location: `${state.upstreamBase}/followed` }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('no upstream address');
  }
  state.upstreamBase = `http://127.0.0.1:${String(upstreamAddress.port)}`;

  return { upstream, state };
}
