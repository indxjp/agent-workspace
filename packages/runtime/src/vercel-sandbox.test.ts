import { afterEach, describe, expect, it } from 'vitest';
import { vercelSandboxRuntimeCapabilities } from './vercel-sandbox.js';
import {
  TOKEN,
  IMAGE,
  servers,
  createdOk,
  fakeVercel,
  driverFor,
  spec,
  config,
} from './vercel-sandbox.test-support.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('vercel sandbox lifecycle', () => {
  it('LC1/LC3: creates a sandbox, starts the runner, and addresses it by its route URL with a minted bearer', async () => {
    const { apiBase, calls } = await fakeVercel();
    const driver = driverFor(apiBase);
    const handle = await driver.create(config(spec()), TOKEN);

    expect(driver.id).toBe('vercel-sandbox');
    expect(handle.driver).toBe('vercel-sandbox');
    expect(handle.externalId).toMatch(/^aw-[A-Za-z0-9_-]{24}$/u);
    expect(JSON.stringify(handle)).not.toContain(TOKEN);
    expect(driver.requestUrl(handle, '/readyz')).toBe('https://runner.vercel.run/readyz');

    expect(calls.map((call) => `${call.method} ${call.url.split('?')[0] ?? ''}`)).toEqual([
      'POST /v4/sandboxes',
      'POST /v2/sandboxes/sessions/sess_1/cmd',
    ]);
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url).toContain('teamId=team_1');
    }

    const create = calls[0]?.body as Record<string, unknown>;
    expect(create).toMatchObject({
      name: handle.externalId,
      projectId: 'prj_1',
      image: IMAGE,
      ports: [8080],
      timeout: 2_700_000,
      persistent: false,
    });
    expect(JSON.stringify(create)).not.toContain(TOKEN);

    const start = calls[1]?.body as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(start.command).toBe('node');
    expect(start.args).toEqual(['/srv/apps/runner/dist/index.js']);
    const bearer = start.env['RUNTIME_SANDBOX_BEARER'];
    expect(bearer?.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(create)).not.toContain(String(bearer));
    expect(JSON.stringify(start)).not.toContain(TOKEN);
    expect(await driver.authHeaders(handle)).toEqual({ authorization: `Bearer ${String(bearer)}` });
    expect(await driver.isLive(handle)).toBe(true);

    await driver.destroy(handle, TOKEN);
    expect(calls[2]).toMatchObject({ method: 'DELETE', authorization: `Bearer ${TOKEN}` });
    expect(calls[2]?.url).toBe(`/v2/sandboxes/${handle.externalId}?teamId=team_1&projectId=prj_1`);
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('destroy: an already-deleted sandbox (404) is success, any other failure is an error', async () => {
    const gone = await fakeVercel((call) =>
      call.method === 'DELETE' ? { status: 404, body: {} } : createdOk,
    );
    const driver = driverFor(gone.apiBase);
    const handle = await driver.create(config(spec()), TOKEN);
    await expect(driver.destroy(handle, TOKEN)).resolves.toBeUndefined();

    const broken = await fakeVercel((call) =>
      call.method === 'DELETE' ? { status: 500, body: {} } : createdOk,
    );
    const brokenDriver = driverFor(broken.apiBase);
    const kept = await brokenDriver.create(config(spec()), TOKEN);
    await expect(brokenDriver.destroy(kept, TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel destroy failed with status 500.',
    );
  });

  it('deletes a sandbox whose create response cannot be used, and rejects without the body', async () => {
    const { apiBase, calls } = await fakeVercel((call) =>
      call.method === 'POST'
        ? {
            status: 200,
            body: {
              session: { id: 'sess_9' },
              routes: [{ port: 8080, url: `http://insecure.example.com/${TOKEN}` }],
            },
          }
        : { status: 200, body: {} },
    );
    const error: unknown = await driverFor(apiBase)
      .create(config(spec()), TOKEN)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('vercel-sandbox runtime: provider vercel create failed.');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(calls[1]?.url).toContain('/v2/sandboxes/aw-');
  });

  it('deletes a sandbox whose runner failed to start', async () => {
    const { apiBase, calls } = await fakeVercel((call) => {
      if (call.url.includes('/cmd')) return { status: 500, body: {} };
      return call.url.startsWith('/v4/sandboxes') ? createdOk : { status: 200, body: {} };
    });
    await expect(driverFor(apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel start the runner failed with status 500.',
    );
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'DELETE']);
  });

  it('extends the session by the shortfall when the granted timeout is shorter than asked', async () => {
    const { apiBase, calls } = await fakeVercel((call) => {
      if (call.url.startsWith('/v4/sandboxes')) {
        return {
          status: 200,
          body: {
            session: { id: 'sess_1', timeout: 300_000 },
            routes: [{ port: 8080, url: 'https://runner.vercel.run' }],
          },
        };
      }
      return { status: 200, body: {} };
    });
    await driverFor(apiBase).create(config(spec({ timeoutSeconds: 600 })), TOKEN);
    expect(calls.map((call) => call.url.split('?')[0])).toEqual([
      '/v4/sandboxes',
      '/v2/sandboxes/sessions/sess_1/extend-timeout',
      '/v2/sandboxes/sessions/sess_1/cmd',
    ]);
    expect(calls[1]?.body).toEqual({ duration: 300_000 });
  });

  it('clamps the timeout to the plan limit, and Pro raises it', async () => {
    const hobby = await fakeVercel();
    await driverFor(hobby.apiBase).create(config(spec({ timeoutSeconds: 999_999 })), TOKEN);
    expect((hobby.calls[0]?.body as { timeout: number }).timeout).toBe(2_700_000);

    const pro = await fakeVercel();
    await driverFor(pro.apiBase, 'pro').create(config(spec({ timeoutSeconds: 999_999 })), TOKEN);
    expect((pro.calls[0]?.body as { timeout: number }).timeout).toBe(86_400_000);
  });

  it('capabilities omit allowlist and keep the documented shape', () => {
    expect(vercelSandboxRuntimeCapabilities()).toEqual({
      isolation: 'microvm',
      customImage: true,
      persistentFilesystem: false,
      sessionAffinity: true,
      maxSessionSeconds: 2_700,
      networkPolicies: ['none', 'open'],
      execCommands: true,
      gpu: false,
      managedByProvider: true,
      typicalStartMs: null,
      fileTransfer: 'push-archive',
    });
    expect(vercelSandboxRuntimeCapabilities('pro').maxSessionSeconds).toBe(86_400);
  });
});
