import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerManagerFunction } from './manager-function.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';
const CREDENTIAL = 'provider_SENTINEL_credential_0123456789';
const IMAGE_ENV = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';

/** What a deploy gives the manager project, per driver; the values are fakes. */
const lanes = {
  'vercel-sandbox': {
    env: {
      RUNTIME_DRIVER: 'vercel-sandbox',
      AW_VERCEL_TEAM_ID: 'team_fixture123',
      VERCEL_PROJECT_ID: 'prj_fixture123',
      [IMAGE_ENV]: `acme/aw-manager/runtime@sha256:${'a'.repeat(64)}`,
    },
    createUrl: 'https://api.vercel.com/v4/sandboxes',
    failure: 'provider vercel create failed with status 400',
  },
  external: {
    env: {
      RUNTIME_DRIVER: 'external',
      EXTERNAL_PROVIDER: 'e2b',
      [IMAGE_ENV]: 'agent-runtime:0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11',
    },
    createUrl: 'https://api.e2b.app/v2/sandboxes',
    failure: 'provider e2b create failed with status 400',
  },
} as const;

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(Object.keys(lanes) as (keyof typeof lanes)[])(
  'the Vercel Function with the %s environment a deploy gives it',
  (driver) => {
    const lane = lanes[driver];

    it('starts, and a provider 400 on create is a 500 internal_error whose log names the hop but not the credential', async () => {
      const realFetch = globalThis.fetch;
      const providerCalls: string[] = [];
      vi.stubGlobal('fetch', (input: Request | string | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!/^https:\/\/api\.(vercel\.com|e2b\.app)\//u.test(url)) return realFetch(input, init);
        providerCalls.push(`${init?.method ?? 'GET'} ${url.split('?')[0] ?? ''}`);
        return Promise.resolve(
          new Response(init?.method === 'POST' ? '{}' : '', {
            status: init?.method === 'POST' ? 400 : 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
      const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const handler = createRunnerManagerFunction({
        ...lane.env,
        RUNNER_MANAGER_TOKEN: TOKEN,
        RUNNER_MANAGER_STATELESS: 'true',
        GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
        NODE_ENV: 'production',
      });
      const serve = createServer((req, res) => {
        handler(req, res);
      });
      servers.push(serve);
      await new Promise<void>((resolve) => serve.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${String((serve.address() as AddressInfo).port)}`;

      const health = await realFetch(`${base}/healthz`);
      expect(health.status).toBe(200);

      const verify = await realFetch(`${base}/verify`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'x-provider-credential': CREDENTIAL,
        },
        body: JSON.stringify({
          workspaceId: 'runtime-verification',
          sessionId: '5d3c1f0e-0f6e-4a43-9a3e-6d6e0f1f2a10',
          engine: 'claude-agent-sdk',
          runSpec: {
            runtimeProfileId: 'runtime-verification',
            driver,
            networkPolicy: 'none',
            filesystem: 'read-write',
            timeoutSeconds: 30,
          },
        }),
      });

      expect(verify.status).toBe(500);
      expect(await verify.json()).toMatchObject({ error: 'internal_error' });
      expect(providerCalls).toContain(`POST ${lane.createUrl}`);
      const log = written.mock.calls.map((call) => String(call[0])).join('');
      expect(log).toContain('runner manager request failed');
      expect(log).toContain(lane.failure);
      expect(log).not.toContain(CREDENTIAL);
    });
  },
);
