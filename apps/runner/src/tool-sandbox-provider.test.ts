import { expect, it, vi } from 'vitest';
import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import { createToolSandboxes, type ToolSandboxDriver } from './tool-sandbox.js';
import {
  hostedHandle,
  parsedRequest,
  fakeDriver,
  serving,
  session,
  origin,
} from './tool-sandbox.fixture.test-support.js';

const PROVIDER_KEY = 'e2b_SENTINEL_provider_key_0123456789';

const ACCESS = { 'e2b-traffic-access-token': 'traffic-SENTINEL' };

function hosted(found?: RuntimeHandle) {
  const calls: { op: string; credential: string | undefined; name?: string }[] = [];
  const handle: RuntimeHandle = found ?? hostedHandle();
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

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > passes the provider key to every call, probes through the access headers, and returns a manager origin', async () => {
  const { sandboxes, calls, probe } = hosted();
  await expect(sandboxes.open(opened, parsedRequest())).resolves.toBe(
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

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > waits past the provider edge answering a closed port (502) for the host to refuse the probe', async () => {
  const { sandboxes, calls, probe } = hosted();
  probe
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 502 }));
  await sandboxes.open(opened, parsedRequest());
  expect(probe).toHaveBeenCalledTimes(3);
  expect(calls.map((call) => call.op === 'write' && call.name)).toEqual([
    false,
    false,
    'manifest.json',
    'tokens.json',
  ]);
});

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > reuses a sandbox another invocation started: it writes the run token and no manifest', async () => {
  const found: RuntimeHandle = hostedHandle();
  const { sandboxes, calls } = hosted(found);
  await sandboxes.open(opened, parsedRequest());
  expect(calls.map((call) => call.op === 'write' && call.name)).toEqual([false, 'tokens.json']);
});

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > closes a sandbox another invocation started when this invocation is asked to', async () => {
  const found: RuntimeHandle = hostedHandle();
  const { sandboxes, calls } = hosted(found);
  await sandboxes.open(opened, parsedRequest());
  await sandboxes.close(session, PROVIDER_KEY);
  expect(calls.at(-1)).toEqual({ op: 'destroy', credential: PROVIDER_KEY });
});

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > closes from a fresh instance by the session tags, and revokes the run token when the kill fails', async () => {
  const tagged: Record<string, string>[] = [];
  const writes: string[] = [];
  let fail = false;
  const handle: RuntimeHandle = hostedHandle();
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
  await first.open(opened, parsedRequest());
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

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > caps the sandbox lifetime at the backstop timeout, plus the margin past it', async () => {
  const { driver, created } = fakeDriver();
  const sandboxes = createToolSandboxes({
    driver,
    origin,
    fetch: serving(),
    timeoutSeconds: 900,
  });
  await sandboxes.open({ ...session, timeoutSeconds: 3_600 }, parsedRequest());
  expect(created[0]?.runSpec?.timeoutSeconds).toBe(1_020);
});

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > ends a sandbox two minutes after its run deadline, so an unreleased one frees its slot soon (issue #832)', async () => {
  const { driver, created } = fakeDriver();
  const sandboxes = createToolSandboxes({
    driver,
    origin,
    fetch: serving(),
    timeoutSeconds: 900,
  });
  await sandboxes.open({ ...session, timeoutSeconds: 300 }, parsedRequest());
  expect(created[0]?.runSpec?.timeoutSeconds).toBe(420);
});

it('a provider-hosted tool sandbox (ADR-0120 LC5, LC6) > resolves only an id it handed out, and gives the access headers with it', () => {
  const { sandboxes } = hosted();
  expect(sandboxes.upstream?.('sealed-id')).toEqual({
    url: 'https://49983-sbx1.e2b.test/mcp',
    headers: ACCESS,
  });
  expect(sandboxes.upstream?.('another-id')).toBeUndefined();
});
