import { describe, expect, it } from 'vitest';
import { PATCH as patchProfileRoute } from '../../app/api/runtime-profiles/[id]/route';
import { POST as createProfileRoute } from '../../app/api/runtime-profiles/route';
import { idContext, request, useMemoryRuntime, WORKSPACE_A } from './runtime-routes.test-support';

describe('external runtime provider', () => {
  function externalBody(driverConfig?: unknown, driver = 'external'): string {
    return JSON.stringify({
      name: `Sandbox ${Math.random().toString(36).slice(2)}`,
      driver,
      networkPolicy: 'none',
      filesystem: 'read-write',
      ...(driverConfig === undefined ? {} : { driverConfig }),
    });
  }

  async function create(body: string): Promise<Response> {
    return createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body }),
    );
  }

  async function patch(id: string, body: unknown): Promise<Response> {
    return patchProfileRoute(
      request('PATCH', `/api/runtime-profiles/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify(body),
      }),
      idContext(id),
    );
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  it('accepts provider e2b and an absent provider, which means e2b', async () => {
    useMemoryRuntime();
    expect((await create(externalBody({ provider: 'e2b' }))).status).toBe(201);
    expect((await create(externalBody())).status).toBe(201);
    expect((await create(externalBody({ region: 'eu' }))).status).toBe(201);
  });

  it('refuses an unknown provider by name with a typed 422', async () => {
    useMemoryRuntime();
    const response = await create(externalBody({ provider: 'modal' }));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('runtime_provider_unsupported');
    expect(body.error.message).toContain('"modal"');
    expect(body.error.message).toContain('"e2b"');
  });

  it('refuses a provider that is not text', async () => {
    useMemoryRuntime();
    for (const provider of [7, null, ['e2b'], { name: 'e2b' }]) {
      const response = await create(externalBody({ provider }));
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toBe('runtime_provider_unsupported');
    }
  });

  it('leaves driverConfig an escape hatch for every other driver', async () => {
    useMemoryRuntime();
    expect((await create(externalBody({ provider: 'x' }, 'docker'))).status).toBe(201);
  });

  it('refuses a PATCH that sets an unknown provider on a stored external profile', async () => {
    useMemoryRuntime();
    const { id } = (await (await create(externalBody({ provider: 'e2b' }))).json()) as {
      id: string;
    };
    const response = await patch(id, { driverConfig: { provider: 'modal' } });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('runtime_provider_unsupported');
    expect((await patch(id, { driverConfig: { provider: 'e2b' } })).status).toBe(200);
  });

  it('refuses a PATCH that moves a profile carrying an unknown provider to external', async () => {
    useMemoryRuntime();
    const { id } = (await (await create(externalBody({ provider: 'modal' }, 'docker'))).json()) as {
      id: string;
    };
    const response = await patch(id, { driver: 'external' });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('runtime_provider_unsupported');
  });
});
