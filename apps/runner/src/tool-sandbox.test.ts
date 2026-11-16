import { expect, it, vi } from 'vitest';
import {
  createToolSandboxes,
  parseToolSandboxRequest,
  ToolSandboxUnavailableError,
  type ToolSandboxDriver,
} from './tool-sandbox.js';
import {
  SECRET,
  TOKEN,
  request,
  parsedRequest,
  localSandboxes,
  fakeDriver,
  session,
  origin,
} from './tool-sandbox.fixture.test-support.js';

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > writes the secrets as the manifest, then the run token once the host serves', async () => {
  const { driver, files, created } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await expect(sandboxes.open(session, parsedRequest())).resolves.toBe(
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

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps waiting through answers servingWhen rejects and returns on the first it accepts', async () => {
  const { driver } = fakeDriver();
  const answers = [503, 503, 401];
  const doFetch = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: answers.shift() ?? 401 })),
  );
  const sandboxes = createToolSandboxes({
    driver,
    origin,
    fetch: doFetch,
    servingWhen: (status) => status < 500,
  });
  await sandboxes.open(session, parsedRequest());
  expect(doFetch).toHaveBeenCalledTimes(3);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > has no egress when no domain is declared', async () => {
  const { driver, created } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest({ allowedDomains: [] }));
  expect(created[0]?.runSpec?.networkPolicy).toBe('none');
  expect(created[0]?.runSpec?.allowedDomains).toBeUndefined();
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > reuses a live sandbox for the next run and replaces the previous run token', async () => {
  const { driver, files, created } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest());
  const next = request({ run: { runId: 'run_2', token: 'another-run-token-0123456' } });
  await sandboxes.open(session, parseToolSandboxRequest(next));
  expect(created).toHaveLength(1);
  expect(files.filter((file) => file.name === 'manifest.json')).toHaveLength(1);
  expect(JSON.parse(files.at(-1)?.content ?? '')).toEqual(['another-run-token-0123456']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > starts a new sandbox when the live one no longer serves, as after a restarted instance', async () => {
  const { driver, created, destroyed } = fakeDriver();
  const doFetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 401 })));
  const sandboxes = createToolSandboxes({
    driver,
    origin,
    fetch: doFetch,
    servingWhen: (status) => status < 500,
  });
  await sandboxes.open(session, parsedRequest());
  // The host restarted: still Ready, but it has no manifest and answers 503 until it gets one.
  doFetch.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 503 })));
  await sandboxes.open(
    session,
    parseToolSandboxRequest(
      request({ run: { runId: 'run_2', token: 'another-run-token-0123456' } }),
    ),
  );
  expect(destroyed).toEqual(['tool-1']);
  expect(created).toHaveLength(2);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > replaces the sandbox when the tool set changes, so old secrets do not outlive their version', async () => {
  const { driver, created, destroyed } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest());
  await sandboxes.open(session, parsedRequest({ key: 'tools-2' }));
  expect(created).toHaveLength(2);
  expect(destroyed).toEqual(['tool-1']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > removes the sandbox and reports it when it stops before it serves', async () => {
  const { driver, destroyed } = fakeDriver({ live: false });
  const sandboxes = localSandboxes(driver);
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    ToolSandboxUnavailableError,
  );
  expect(destroyed).toEqual(['tool-1']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > gives up, and removes the sandbox, when the host never answers', async () => {
  const { driver, destroyed } = fakeDriver();
  const refusing = vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')));
  const sandboxes = createToolSandboxes({
    driver,
    origin,
    fetch: refusing,
    readyTimeoutMs: 250,
  });
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    'the tool sandbox did not become ready in time (no answer)',
  );
  expect(destroyed).toEqual(['tool-1']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > names the last status the probe saw when a provider edge keeps answering 502', async () => {
  const { driver } = fakeDriver();
  const edge = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 502 })));
  const sandboxes = createToolSandboxes({
    driver,
    origin,
    upstream: () => ({ url: 'https://49983-sbx1.e2b.test/mcp', headers: {} }),
    fetch: edge,
    readyTimeoutMs: 250,
  });
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    'the tool sandbox did not become ready in time (last answer HTTP 502)',
  );
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > names the cause, and removes the sandbox, when the manifest cannot be written', async () => {
  const { driver, destroyed } = fakeDriver();
  driver.writeFile = () => Promise.reject(new Error('envd answered 503'));
  const sandboxes = localSandboxes(driver);
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    'the tool sandbox could not be prepared: envd answered 503',
  );
  expect(destroyed).toEqual(['tool-1']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps both failures when the sandbox that stopped before it served cannot be removed', async () => {
  const { driver } = fakeDriver({ live: false });
  driver.destroy = () => Promise.reject(new Error('docker rm failed'));
  const sandboxes = localSandboxes(driver);
  const thrown = await sandboxes.open(session, parsedRequest()).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(AggregateError);
  const [failure, cleanup] = (thrown as AggregateError).errors as Error[];
  expect(failure).toBeInstanceOf(ToolSandboxUnavailableError);
  expect(cleanup?.message).toBe('docker rm failed');
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps the driver error as the cause when the manifest cannot be written', async () => {
  const { driver } = fakeDriver();
  const cause = new Error('envd answered 503');
  driver.writeFile = () => Promise.reject(cause);
  const sandboxes = localSandboxes(driver);
  const thrown = await sandboxes.open(session, parsedRequest()).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(ToolSandboxUnavailableError);
  expect((thrown as Error).cause).toBe(cause);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > starts no new tool set while the sandbox holding the old secrets cannot be removed', async () => {
  const { driver, created } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest());
  const cause = new Error('docker rm failed');
  driver.destroy = () => Promise.reject(cause);
  const thrown = await sandboxes
    .open(session, parsedRequest({ key: 'tools-2' }))
    .catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(ToolSandboxUnavailableError);
  expect((thrown as Error).cause).toBe(cause);
  expect(created).toHaveLength(1);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps both failures when the sandbox just started cannot be removed after its run token failed', async () => {
  const { driver } = fakeDriver();
  driver.writeFile = (_handle, name) =>
    name === 'tokens.json' ? Promise.reject(new Error('envd answered 502')) : Promise.resolve();
  driver.destroy = () => Promise.reject(new Error('docker rm failed'));
  const sandboxes = localSandboxes(driver);
  const thrown = await sandboxes.open(session, parsedRequest()).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(AggregateError);
  const [failure, cleanup] = (thrown as AggregateError).errors as Error[];
  expect(failure?.message).toBe('the run token could not be registered: envd answered 502');
  expect(cleanup?.message).toBe('docker rm failed');
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps both failures when the sandbox outlives its close and its run token cannot be revoked', async () => {
  const { driver } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest());
  driver.destroy = () => Promise.reject(new Error('docker rm failed'));
  driver.writeFile = () => Promise.reject(new Error('envd answered 502'));
  const thrown = await sandboxes.close(session).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(AggregateError);
  expect(((thrown as AggregateError).errors as Error[]).map((error) => error.message)).toEqual([
    'docker rm failed',
    'envd answered 502',
  ]);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > names the cause, and removes the sandbox it just started, when the run token cannot be written', async () => {
  const { driver, destroyed } = fakeDriver();
  driver.writeFile = (_handle, name) =>
    name === 'tokens.json' ? Promise.reject(new Error('envd answered 502')) : Promise.resolve();
  const sandboxes = localSandboxes(driver);
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    'the run token could not be registered: envd answered 502',
  );
  expect(destroyed).toEqual(['tool-1']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps the live sandbox of an earlier run when a later run token cannot be written', async () => {
  const { driver, destroyed } = fakeDriver();
  const write = driver.writeFile.bind(driver);
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest());
  driver.writeFile = (handle, name, content) =>
    name === 'tokens.json'
      ? Promise.reject(new Error('envd answered 502'))
      : write(handle, name, content);
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    'the run token could not be registered',
  );
  expect(destroyed).toEqual([]);
});

it("tool sandboxes (ADR-0118 TS2, TS4, TS5) > surfaces the provider's concurrency limit as an unavailable tool sandbox, without retrying", async () => {
  const { driver } = fakeDriver();
  const create = vi.fn<ToolSandboxDriver['create']>(() =>
    Promise.reject(
      new Error(
        "external runtime: provider e2b create failed with status 429: the provider's concurrency limit was reached (you have reached the maximum number of concurrent E2B sandboxes (20)).",
      ),
    ),
  );
  driver.create = create;
  const sandboxes = localSandboxes(driver);
  const error: unknown = await sandboxes
    .open(session, parsedRequest())
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolSandboxUnavailableError);
  expect((error as Error).message).toContain("the provider's concurrency limit was reached");
  expect(create).toHaveBeenCalledTimes(1);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > waits at least as long as an npx fetch when the manifest has a stdio server', async () => {
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

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > closes the session sandbox once and tolerates a session without one', async () => {
  const { driver, destroyed } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.close({ ...session, key: 'nobody' });
  await sandboxes.open(session, parsedRequest());
  await sandboxes.close(session);
  await sandboxes.close(session);
  expect(destroyed).toEqual(['tool-1']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > removes the sandbox when it answers once and then stops (a bundle did not start)', async () => {
  let probes = 0;
  const { driver, files, destroyed } = fakeDriver({ live: () => (probes += 1) === 1 });
  const sandboxes = localSandboxes(driver);
  await expect(sandboxes.open(session, parsedRequest())).rejects.toThrow(
    ToolSandboxUnavailableError,
  );
  expect(destroyed).toEqual(['tool-1']);
  expect(files.map((file) => file.name)).toEqual(['manifest.json']);
});

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > keeps one sandbox per profile of a session, so closing one leaves the other', async () => {
  const { driver, files, created, destroyed } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  const other = { ...session, key: 'profile-two:session-one' };
  await sandboxes.open(session, parsedRequest());
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

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > releases only the sandbox a run started, never one the run only reused (issue #832)', async () => {
  const { driver, created, destroyed } = fakeDriver();
  const sandboxes = localSandboxes(driver);
  await sandboxes.open(session, parsedRequest());
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

it('tool sandboxes (ADR-0118 TS2, TS4, TS5) > refuses an invalid request naming paths and never a value', () => {
  let message = '';
  try {
    parsedRequest({ run: { runId: 'run_1', token: 'short' }, extra: SECRET });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('run.token');
  expect(message).not.toContain(SECRET);
});
