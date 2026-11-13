import { expect, it, vi } from 'vitest';
import { createRuntimeManagerClient } from '../compose/runtime-manager-client';
import { configureWebRuntimeRegistry } from '../runtimes/registry';
import { captureLog } from '../telemetry/capture-log';
import { log as webLogger } from '../telemetry/logger';
import {
  EXTERNAL,
  runtimeConnectionNames,
  storedKey,
  testedWith,
} from './setup-external-fixture.test-support';
import {
  complete,
  db,
  E2B_KEY,
  expectUntouched,
  LOCAL_REGISTRY,
  scope,
  setupInput,
} from './setup-fixture.test-support';

export function registerExternalChecksTests(): void {
  it('tests with the submitted key, stores it as an encrypted runtime connection, and points the profile at it', async () => {
    const spies = captureLog();
    const result = await complete(setupInput(EXTERNAL));
    if (!result.ok) throw new Error(`setup refused: ${result.code}`);
    expect(testedWith).toEqual([E2B_KEY]);
    if (result.runtimeConnectionId === null) throw new Error('no runtime connection was stored');
    expect(await runtimeConnectionNames()).toEqual([
      'RUNTIME_CONNECTION__EXTERNAL__EXTERNAL_DEFAULT',
    ]);
    expect(await storedKey(result.runtimeConnectionId)).toBe(E2B_KEY);
    const profile = await db().runtimeProfiles.forScope(scope()).get(result.runtimeProfileId);
    expect(profile).toMatchObject({
      name: 'external default',
      driver: 'external',
      runtimeConnectionId: result.runtimeConnectionId,
    });
    expect(JSON.stringify(result)).not.toContain(E2B_KEY);
    expect(spies.text()).not.toContain(E2B_KEY);
  });

  it('answers 500 setup_failed naming the runtime test, and stores nothing, when the test throws', async () => {
    const spy = captureLog();
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      list: () =>
        LOCAL_REGISTRY.list().then((entries) =>
          entries.map((entry) => ({ ...entry, id: 'external' })),
        ),
      test: () => Promise.reject(new Error(`provider refused ${E2B_KEY} at https://api.e2b.dev`)),
    });
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toContain('runtime test');
    expect(refused.message).not.toContain(E2B_KEY);
    const logged = spy.text();
    expect(logged).toContain('runtime test');
    expect(logged).not.toContain(E2B_KEY);
    expect(logged).not.toContain('api.e2b.dev');
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it('names the manager status, typed code and Worker step, and nothing from its body, when the manager refuses the runtime test', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      list: () =>
        LOCAL_REGISTRY.list().then((entries) =>
          entries.map((entry) => ({ ...entry, id: 'external' })),
        ),
      test: async () => {
        const client = createRuntimeManagerClient('https://manager.example', 'm'.repeat(32), () =>
          Promise.resolve(
            Response.json(
              {
                error: {
                  code: 'worker_exception',
                  step: 'forward',
                  message: `refused ${E2B_KEY} at https://api.e2b.dev`,
                },
              },
              { status: 502 },
            ),
          ),
        );
        await client.verify(
          { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
          'external',
          E2B_KEY,
        );
        throw new Error('unreachable');
      },
    });
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toBe(
      'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 502 worker_exception at forward). See the server log, then retry.',
    );
    await expectUntouched();
  });

  /** A registry whose runtime test is a manager `verify` that `answer` refuses. */
  function managerRefusing(answer: () => Response): void {
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      list: () =>
        LOCAL_REGISTRY.list().then((entries) =>
          entries.map((entry) => ({ ...entry, id: 'external' })),
        ),
      test: async () => {
        const client = createRuntimeManagerClient('https://manager.example', 'm'.repeat(32), () =>
          Promise.resolve(answer()),
        );
        await client.verify(
          { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
          'external',
          E2B_KEY,
        );
        throw new Error('unreachable');
      },
    });
  }

  it('answers runtime_manager_forbidden, and stores nothing, when the platform front end refuses web with an HTML 403', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    managerRefusing(
      () =>
        new Response('<html><body><h1>Error: Forbidden</h1></body></html>', {
          status: 403,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        }),
    );
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 500, code: 'runtime_manager_forbidden' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toBe(
      'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 403 non_json_html). See the server log, then retry.',
    );
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it("keeps setup_failed when the manager's own JSON answers 403", async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    managerRefusing(() =>
      Response.json({ error: { code: 'unauthorized', message: 'bad token' } }, { status: 403 }),
    );
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
    await expectUntouched();
  });

  it("names the invalid field's typed code when the manager answers 400", async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      list: () =>
        LOCAL_REGISTRY.list().then((entries) =>
          entries.map((entry) => ({ ...entry, id: 'external' })),
        ),
      test: async () => {
        const client = createRuntimeManagerClient('https://manager.example', 'm'.repeat(32), () =>
          Promise.resolve(
            Response.json(
              { error: 'invalid_engine', message: 'engine must be a safe path segment' },
              { status: 400 },
            ),
          ),
        );
        await client.verify(
          { sessionId: 's', workspacePath: '/workspace', engine: '' },
          'external',
          E2B_KEY,
        );
        throw new Error('unreachable');
      },
    });
    const refused = await complete(setupInput(EXTERNAL));
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toBe(
      'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 400 invalid_engine). See the server log, then retry.',
    );
    await expectUntouched();
  });
}
