import { log as webLogger } from '../telemetry/logger';
import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeManagerError,
  createRuntimeManagerClient,
  probeRuntimeManager,
} from './runtime-manager-client';
import { setupStepFailure } from '../setup/failure';

const TOKEN = 'runtime-manager-client-test-token-over-32-characters';

describe('runtime manager client', () => {
  it('allocates with tenant/session scope and keeps its bearer out of the run spec', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          handle: {
            id: 'handle-1',
            driver: 'docker',
            externalId: 'container-1',
            workspacePath: '/workspace',
            createdAt: '2026-09-10T00:00:00Z',
          },
          runnerUrl: 'http://manager/runtimes/handle-1',
        },
        { status: 201 },
      ),
    );
    const client = createRuntimeManagerClient('http://manager/', TOKEN, fetch);
    const allocation = await client.allocate(
      {
        run: {} as never,
        agent: { id: 'agent', workspaceId: 'workspace-one', engine: 'claude-agent-sdk' },
        session: { id: 'session-one', agentId: 'agent', engine: null },
        principal: {
          principalId: 'principal',
          ownerPrincipalId: 'principal',
          userId: 'user',
          workspaceId: 'workspace-one',
          scope: null,
        },
        prompt: 'hello',
      },
      {
        runtimeProfileId: 'profile-one',
        driver: 'docker',
        networkPolicy: 'none',
        filesystem: 'read-write',
      },
    );
    expect(allocation.runnerUrl).toBe('http://manager/runtimes/handle-1');
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    if (typeof init?.body !== 'string') throw new Error('expected JSON allocation body');
    const body = JSON.parse(init.body) as unknown;
    expect(body).toMatchObject({
      workspaceId: 'workspace-one',
      sessionId: 'session-one',
      runSpec: { driver: 'docker', runtimeProfileId: 'profile-one' },
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(client.authorizationHeaders()).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('sends the tool sandbox request and returns its origin, and fails if none comes back', async () => {
    const handle = { id: 'h', driver: 'docker', externalId: 'c', workspacePath: '/workspace' };
    const context = {
      run: {} as never,
      agent: { id: 'agent', workspaceId: 'workspace-one', engine: 'claude-agent-sdk' },
      session: { id: 'session-one', agentId: 'agent', engine: null },
      principal: {
        principalId: 'principal',
        ownerPrincipalId: 'principal',
        userId: 'user',
        workspaceId: 'workspace-one',
        scope: null,
      },
      prompt: 'hello',
    } as const;
    const spec = {
      runtimeProfileId: 'profile-one',
      driver: 'docker',
      networkPolicy: 'none',
      filesystem: 'read-write',
    } as const;
    const toolSandbox = { key: 'k' } as never;
    const answer = (extra: object) =>
      vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() =>
          Promise.resolve(Response.json({ handle, runnerUrl: 'http://manager/r', ...extra })),
        );

    const served = answer({ toolSandbox: { origin: 'http://tool-host:9' } });
    const allocation = await createRuntimeManagerClient('http://manager', TOKEN, served).allocate(
      context,
      spec,
      toolSandbox,
    );
    expect(allocation.toolSandboxOrigin).toBe('http://tool-host:9');
    expect(String(served.mock.calls[0]?.[1]?.body as string)).toContain(
      '"toolSandbox":{"key":"k"}',
    );

    const plain = answer({});
    const without = await createRuntimeManagerClient('http://manager', TOKEN, plain).allocate(
      context,
      spec,
    );
    expect(without).not.toHaveProperty('toolSandboxOrigin');
    expect(String(plain.mock.calls[0]?.[1]?.body as string)).not.toContain('toolSandbox');

    await expect(
      createRuntimeManagerClient('http://manager', TOKEN, answer({})).allocate(
        context,
        spec,
        toolSandbox,
      ),
    ).rejects.toThrow('omitted the tool sandbox origin');
  });

  it('opens an endpoint tool sandbox with the provider key in a header only, and redacts it on failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ toolSandbox: { origin: 'http://runner/tool' } }))
      .mockResolvedValueOnce(
        Response.json(
          { error: 'tool_sandbox_unavailable', message: 'e2b-secret-key' },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = createRuntimeManagerClient('http://manager/', TOKEN, fetch);
    const input = {
      workspaceId: 'workspace-one',
      clientId: 'client-one',
      toolSandbox: {} as never,
    };

    await expect(client.openToolSandbox(input, 'e2b-secret-key')).resolves.toBe(
      'http://runner/tool',
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://manager/tool-sandboxes');
    expect(new Headers(init?.headers).get('x-provider-credential')).toBe('e2b-secret-key');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(init?.body)).not.toContain('e2b-secret-key');

    const failure = await client.openToolSandbox(input, 'e2b-secret-key').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RuntimeManagerError);
    expect((failure as RuntimeManagerError).code).toBe('tool_sandbox_unavailable');
    expect((failure as RuntimeManagerError).message).not.toContain('e2b-secret-key');

    await expect(client.openToolSandbox(input)).rejects.toThrow('omitted the tool sandbox origin');
  });

  it('closes an endpoint tool sandbox by client, with the key in a header only, and redacts it on failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ error: 'internal_error', message: 'e2b-secret-key' }, { status: 500 }),
      );
    const client = createRuntimeManagerClient('http://manager/', TOKEN, fetch);

    await expect(
      client.closeToolSandbox('workspace one', 'client/one', 'e2b-secret-key'),
    ).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      'http://manager/tool-sandboxes/sessions/client%2Fone?workspaceId=workspace%20one',
    );
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('x-provider-credential')).toBe('e2b-secret-key');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);

    await expect(client.closeToolSandbox('w', 'c')).resolves.toBeUndefined();
    const failure = await client
      .closeToolSandbox('w', 'c', 'e2b-secret-key')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RuntimeManagerError);
    expect((failure as RuntimeManagerError).message).not.toContain('e2b-secret-key');
  });

  it('releases only the tool sandboxes of a run, never its runtime, and redacts the key on failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ error: 'internal_error', message: 'e2b-secret-key' }, { status: 500 }),
      );
    const client = createRuntimeManagerClient('http://manager/', TOKEN, fetch);

    await expect(
      client.releaseRunToolSandboxes('workspace one', 'run/one', 'e2b-secret-key'),
    ).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://manager/tool-sandboxes/runs/run%2Fone?workspaceId=workspace%20one');
    expect(init?.method).toBe('DELETE');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('x-provider-credential')).toBe('e2b-secret-key');

    const failure = await client
      .releaseRunToolSandboxes('w', 'r', 'e2b-secret-key')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RuntimeManagerError);
    expect((failure as RuntimeManagerError).message).not.toContain('e2b-secret-key');
  });

  it('bounds a tool sandbox close with a timeout that never echoes the credential', async () => {
    const thrown = new DOMException('The operation timed out.', 'TimeoutError');
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(thrown);
    const client = createRuntimeManagerClient('http://manager', TOKEN, fetch);

    const failure = await client
      .closeToolSandbox('w', 'c', 'e2b-secret-key')
      .catch((e: unknown) => e);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(failure).toBeInstanceOf(RuntimeManagerError);
    expect(failure).toMatchObject({ status: 0, code: 'timeout' });
    expect((failure as RuntimeManagerError).message).not.toContain('e2b-secret-key');
    expect((failure as RuntimeManagerError).safeCause).not.toContain('e2b-secret-key');
  });

  it('keeps verification network-none by default and permits an ACA open-network probe', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          fingerprint: 'verified-fingerprint',
          verifiedAt: '2026-09-11T00:00:00.000Z',
          expiresAt: '2026-09-12T00:00:00.000Z',
        }),
      ),
    );
    const config = {
      sessionId: 'verify-session',
      workspacePath: '/workspace',
      engine: 'claude-agent-sdk',
    };

    await createRuntimeManagerClient('http://manager', TOKEN, fetch).verify(config, 'docker');
    await createRuntimeManagerClient('http://manager', TOKEN, fetch, {
      verificationNetworkPolicy: 'open',
    }).verify(config, 'aca-sessions');

    const runSpecs = fetch.mock.calls.map(([, init]) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON verification body');
      const value = JSON.parse(init.body) as {
        runSpec: { networkPolicy: string; timeoutSeconds?: number };
      };
      return value.runSpec;
    });
    expect(runSpecs.map(({ networkPolicy }) => networkPolicy)).toEqual(['none', 'open']);
    expect(runSpecs[0]?.timeoutSeconds).toBe(30);
    expect(runSpecs[1]).not.toHaveProperty('timeoutSeconds');
  });
});

describe('probeRuntimeManager', () => {
  it('asks GET /healthz with an abort signal, trimming trailing slashes, and releases the body', async () => {
    const response = Response.json({ status: 'ok', allocations: 0 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);

    await expect(probeRuntimeManager('http://manager:8090//', fetch)).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://manager:8090/healthz');
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('answers false for an empty URL without fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(probeRuntimeManager('  ', fetch)).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers false for a non-2xx health answer', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('down', { status: 503 }));

    await expect(probeRuntimeManager('http://manager', fetch)).resolves.toBe(false);
  });

  it('answers false when the probe times out', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation timed out.', 'TimeoutError'));
          });
        }),
    );

    await expect(probeRuntimeManager('http://manager', fetch, 10)).resolves.toBe(false);
  });

  it('answers false when the connection is refused', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed'));

    await expect(probeRuntimeManager('http://manager', fetch)).resolves.toBe(false);
  });
});

describe('a refused verification', () => {
  const KEY = 'e2b_secret_key_value';
  const config = { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' };
  const failureOf = async (response: Response): Promise<RuntimeManagerError> => {
    const client = createRuntimeManagerClient(
      'http://manager',
      TOKEN,
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
      { notReadyRetry: { windowMs: 0, initialDelayMs: 0 } },
    );
    const error: unknown = await client.verify(config, 'external', KEY).catch((e: unknown) => e);
    if (!(error instanceof RuntimeManagerError)) throw new Error('expected a RuntimeManagerError');
    return error;
  };

  it('carries the Worker JSON error code and step, never its message', async () => {
    const error = await failureOf(
      Response.json(
        { error: { code: 'worker_exception', step: 'forward', message: `boom ${KEY}` } },
        { status: 502 },
      ),
    );
    expect(error).toMatchObject({ status: 502, code: 'worker_exception', step: 'forward' });
    expect(error.safeCause).toBe('runner manager answered HTTP 502 worker_exception at forward');
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain(KEY);
  });

  it("carries the manager's own string error code", async () => {
    const error = await failureOf(Response.json({ error: 'internal_error' }, { status: 500 }));
    expect(error.safeCause).toBe('runner manager answered HTTP 500 internal_error');
  });

  it("carries the manager's typed 400 field code, never its message", async () => {
    const error = await failureOf(
      Response.json(
        { error: 'invalid_engine', message: 'engine must be a safe path segment' },
        { status: 400 },
      ),
    );
    expect(error).toMatchObject({ status: 400, code: 'invalid_engine' });
    expect(error.safeCause).toBe('runner manager answered HTTP 400 invalid_engine');
    expect(error.detail).toBeUndefined();
  });

  it("keeps the manager's message for tool_sandbox_unavailable, redacted of the provider key (issue #827)", async () => {
    const error = await failureOf(
      Response.json(
        {
          error: 'tool_sandbox_unavailable',
          message: `the tool sandbox could not be started: refused ${KEY}`,
        },
        { status: 503 },
      ),
    );
    expect(error.safeCause).toBe('runner manager answered HTTP 503 tool_sandbox_unavailable');
    expect(error.detail).toBe('the tool sandbox could not be started: refused [redacted]');
  });

  it("names the Worker's plain-text 503 while the container is not ready", async () => {
    const error = await failureOf(
      new Response('The runner manager container exited (boom)', { status: 503 }),
    );
    expect(error.safeCause).toBe('runner manager answered HTTP 503 manager_not_ready');
  });

  it('drops a code that is not a plain token', async () => {
    const odd = await failureOf(
      Response.json({ error: { code: `https://x/${KEY}`, step: 'a b' } }, { status: 500 }),
    );
    expect(odd.safeCause).toBe('runner manager answered HTTP 500');
  });

  it.each([
    [
      'the platform error header',
      () =>
        new Response('<html>The function crashed</html>', {
          status: 500,
          headers: { 'content-type': 'text/html', 'x-vercel-error': 'FUNCTION_INVOCATION_FAILED' },
        }),
      'runner manager answered HTTP 500 function_invocation_failed',
    ],
    [
      'an error token in the page',
      () => new Response('<html><h1>FUNCTION_INVOCATION_TIMEOUT</h1></html>', { status: 504 }),
      'runner manager answered HTTP 504 function_invocation_timeout',
    ],
    [
      'an HTML page with no token',
      () =>
        new Response(`<!DOCTYPE html><p>error code: 1101 ${KEY}</p>`, {
          status: 500,
          headers: { 'content-type': 'text/html' },
        }),
      'runner manager answered HTTP 500 non_json_html',
    ],
    [
      'an empty body',
      () => new Response(null, { status: 502 }),
      'runner manager answered HTTP 502 non_json_empty',
    ],
    [
      'a plain-text body',
      () => new Response(`Bad gateway ${KEY}`, { status: 502 }),
      'runner manager answered HTTP 502 non_json_text',
    ],
  ])('types a non-JSON answer from %s without showing its text', async (_name, answer, cause) => {
    const error = await failureOf(answer());
    expect(error.safeCause).toBe(cause);
    expect(error.safeCause).not.toContain(KEY);
    expect(error.message).not.toContain(KEY);
  });

  it.each([
    ['a timeout', new DOMException('The operation timed out', 'TimeoutError'), 'timeout'],
    ['an abort', new DOMException('aborted', 'AbortError'), 'timeout'],
    ['a network failure', new TypeError(`fetch failed ${KEY}`), 'unreachable'],
  ])(
    'types %s as an unanswered call, keeping the original as the cause',
    async (_n, thrown, code) => {
      const client = createRuntimeManagerClient(
        'http://manager',
        TOKEN,
        vi.fn<typeof globalThis.fetch>().mockRejectedValue(thrown),
      );
      const error: unknown = await client.verify(config, 'external', KEY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeManagerError);
      expect(error).toMatchObject({ status: 0, code, cause: thrown });
      expect((error as RuntimeManagerError).safeCause).toBe(
        `runner manager did not answer ${code}`,
      );
      expect((error as RuntimeManagerError).message).not.toContain(KEY);
    },
  );

  it.each([
    ['not JSON', () => new Response('<html></html>', { status: 200 })],
    [
      'missing the fingerprint',
      () =>
        Response.json({ verifiedAt: '2026-09-11T00:00:00Z', expiresAt: '2026-09-12T00:00:00Z' }),
    ],
    ['null', () => Response.json(null)],
  ])('types a 2xx verification that is %s', async (_name, answer) => {
    const error = await failureOf(answer());
    expect(error).toMatchObject({ status: 200, code: 'invalid_answer' });
    expect(error.safeCause).toBe('runner manager answered HTTP 200 invalid_answer');
  });

  it('types an unanswered allocation and destroy the same way', async () => {
    const client = createRuntimeManagerClient(
      'http://manager',
      TOKEN,
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed')),
    );
    await expect(client.destroy('handle-1', KEY)).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
    });
    const context = {
      run: {},
      agent: { engine: 'claude-agent-sdk' },
      session: { id: 'session-one' },
      principal: { workspaceId: 'workspace-one' },
    } as never;
    await expect(client.allocate(context, {} as never, undefined, KEY)).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
    });
    const nullAnswer = createRuntimeManagerClient(
      'http://manager',
      TOKEN,
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(null)),
    );
    await expect(nullAnswer.allocate(context, {} as never, undefined, KEY)).rejects.toMatchObject({
      status: 200,
      code: 'invalid_answer',
    });
  });

  it('keeps a key the manager echoed as its error code out of the setup failure', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const error = await failureOf(Response.json({ error: KEY }, { status: 500 }));
    expect(error.code).toBe(KEY);
    const failure = setupStepFailure('runtime test', error, [KEY], error.safeCause);
    expect(failure.message).toBe(
      'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 500 [redacted]). See the server log, then retry.',
    );
  });
});

describe('verification while the manager Worker is starting', () => {
  const KEY = 'e2b_secret_key_value';
  const config = { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' };
  const starting = () => new Response('The runner manager is starting', { status: 503 });
  const verified = () =>
    Response.json({
      fingerprint: 'verified-fingerprint',
      verifiedAt: '2026-09-11T00:00:00.000Z',
      expiresAt: '2026-09-12T00:00:00.000Z',
    });
  const clientFor = (answers: readonly (() => Response)[]) => {
    let next = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer === undefined) throw new Error('no answer');
      return Promise.resolve(answer());
    });
    const client = createRuntimeManagerClient('http://manager', TOKEN, fetch, {
      notReadyRetry: { windowMs: 200, initialDelayMs: 5 },
    });
    return { fetch, client };
  };

  it('retries manager_not_ready and resolves with the verification, sending the same call each time', async () => {
    const { fetch, client } = clientFor([starting, starting, verified]);

    await expect(client.verify(config, 'external', KEY)).resolves.toMatchObject({
      fingerprint: 'verified-fingerprint',
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    const sent = fetch.mock.calls.map(([, init]) => ({
      body: init?.body,
      key: new Headers(init?.headers).get('x-provider-credential'),
    }));
    expect(new Set(sent.map(({ body }) => body)).size).toBe(1);
    expect(sent.map(({ key }) => key)).toEqual([KEY, KEY, KEY]);
  });

  it('fails with the typed hop error when it never becomes ready, after a bounded number of calls', async () => {
    const { fetch, client } = clientFor([starting]);

    const error: unknown = await client.verify(config, 'external', KEY).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RuntimeManagerError);
    expect((error as RuntimeManagerError).safeCause).toBe(
      'runner manager answered HTTP 503 manager_not_ready',
    );
    expect((error as RuntimeManagerError).message).not.toContain(KEY);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it.each([
    [
      'a Worker exception',
      () =>
        Response.json({ error: { code: 'worker_exception', step: 'forward' } }, { status: 502 }),
    ],
    [
      'a 503 that is not manager_not_ready',
      () => Response.json({ error: 'internal_error' }, { status: 503 }),
    ],
  ])('does not retry %s', async (_name, answer) => {
    const { fetch, client } = clientFor([answer, verified]);

    await expect(client.verify(config, 'external', KEY)).rejects.toBeInstanceOf(
      RuntimeManagerError,
    );

    expect(fetch).toHaveBeenCalledOnce();
  });
});
