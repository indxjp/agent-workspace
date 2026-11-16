import type { DemoEntryStates } from './ports';
import { describe, expect, it, vi } from 'vitest';

import { NO_DEMO_OPERATOR, type DemoOperatorRuntime } from '../operator';
import { createDemoMaintenanceOperations } from './operations';
import { createDemoReadinessCheck, READINESS_TIMEOUT_MS } from './readiness';
import { getDemoReadiness, getStoreDemos, MAX_BODY_BYTES, putDemoMaintenance } from './routes';

const TOKEN = 't'.repeat(40);
const KEY = 'sk-ant-canary-0123456789abcdefghijklmnopqrstuv';
const NOW = new Date('2026-11-16T10:00:00.000Z');

function memoryStates(): DemoEntryStates {
  const rows = new Map<string, string>();
  return {
    set: ({ entry, state }) => {
      rows.set(entry, state);
      return Promise.resolve();
    },
    underMaintenance: () =>
      Promise.resolve(
        [...rows]
          .filter(([, state]) => state === 'maintenance')
          .map(([e]) => e)
          .sort(),
      ),
  };
}

function runtime(overrides: Partial<DemoOperatorRuntime> = {}): DemoOperatorRuntime {
  return {
    ...NO_DEMO_OPERATOR,
    token: TOKEN,
    maintenance: createDemoMaintenanceOperations(memoryStates()),
    readiness: { check: () => Promise.resolve({ apiKeyConfigured: true, apiReachable: true }) },
    ...overrides,
  };
}

const put = (body: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  new Request('https://platform.example.test/api/demo/maintenance/crm', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(auth === null ? {} : { authorization: auth }),
    },
    body: JSON.stringify(body),
  });
const get = (auth: string | null = `Bearer ${TOKEN}`) =>
  new Request('https://platform.example.test/api/demo/readiness', {
    headers: auth === null ? {} : { authorization: auth },
  });

const VERDICT = { state: 'maintenance', reason: 'the moment did not happen' };

describe('the maintenance limits', () => {
  it('reads at most 4 KiB of a verdict and waits at most 10 seconds for the Anthropic API', () => {
    expect(MAX_BODY_BYTES).toBe(4 * 1024);
    expect(READINESS_TIMEOUT_MS).toBe(10_000);
  });
});

describe('PUT /api/demo/maintenance/{entry}', () => {
  it('refuses a body over the limit with 413 and keeps nothing', async () => {
    const rt = runtime();
    const big = { ...VERDICT, reason: 'x'.repeat(MAX_BODY_BYTES) };
    const answer = await putDemoMaintenance(put(big), 'crm', rt, () => NOW);
    expect(answer.status).toBe(413);
    expect(await (await getStoreDemos(rt)).json()).toEqual({ maintenance: [] });
  });

  it('is absent (404) without a deployment token, and 401 to a wrong or missing one', async () => {
    const without = runtime({ token: null });
    expect((await putDemoMaintenance(put(VERDICT), 'crm', without, () => NOW)).status).toBe(404);
    for (const auth of [null, 'Bearer nope']) {
      expect(
        (await putDemoMaintenance(put(VERDICT, auth), 'crm', runtime(), () => NOW)).status,
      ).toBe(401);
    }
  });

  it('keeps the verdict (204) and the store then lists the entry; a later "available" takes it back', async () => {
    const rt = runtime();
    const answer = await putDemoMaintenance(put(VERDICT), 'crm', rt, () => NOW);
    expect(answer.status).toBe(204);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await (await getStoreDemos(rt)).json()).toEqual({ maintenance: ['crm'] });

    await putDemoMaintenance(
      put({ state: 'available', reason: 'it passed' }),
      'crm',
      rt,
      () => NOW,
    );
    expect(await (await getStoreDemos(rt)).json()).toEqual({ maintenance: [] });
  });

  it('refuses a bad body (400), an unknown entry (404) and a deployment with no database (503)', async () => {
    const rt = runtime();
    for (const body of [
      {},
      { state: 'broken', reason: 'x' },
      { state: 'available', reason: ' ' },
    ]) {
      expect((await putDemoMaintenance(put(body), 'crm', rt, () => NOW)).status).toBe(400);
    }
    expect((await putDemoMaintenance(put(VERDICT), 'No Such!', rt, () => NOW)).status).toBe(404);
    const none = runtime({ maintenance: null });
    expect((await putDemoMaintenance(put(VERDICT), 'crm', none, () => NOW)).status).toBe(503);
  });
});

describe('GET /api/store/demos', () => {
  it('is public and no-store, and lists nothing where there are no operations', async () => {
    for (const rt of [null, NO_DEMO_OPERATOR]) {
      const answer = await getStoreDemos(rt);
      expect(answer.status).toBe(200);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(await answer.json()).toEqual({ maintenance: [] });
    }
  });
});

describe('GET /api/demo/readiness', () => {
  it('is operator-only: 404 without a token configured, 401 for a wrong one, 200 otherwise', async () => {
    expect((await getDemoReadiness(get(), runtime({ token: null }))).status).toBe(404);
    expect((await getDemoReadiness(get('Bearer nope'), runtime())).status).toBe(401);
    const ok = await getDemoReadiness(get(), runtime());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ apiKeyConfigured: true, apiReachable: true });
  });
});

describe('the readiness check', () => {
  it('reports no key as not configured and not reachable, without calling out', async () => {
    const request = vi.fn();
    const result = await createDemoReadinessCheck({ apiKey: null, request }).check();
    expect(result).toEqual({ apiKeyConfigured: false, apiReachable: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('lists models with the key and reports reachable on an answer', async () => {
    const request = vi.fn<typeof fetch>((_url, init) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe(KEY);
      return Promise.resolve(new Response('{"data":[]}', { status: 200 }));
    });
    const result = await createDemoReadinessCheck({ apiKey: KEY, request }).check();
    expect(result).toEqual({ apiKeyConfigured: true, apiReachable: true });
    expect(request).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.anything());
  });

  it('is not reachable on a refusal, an error or a timeout, and never carries the key', async () => {
    const failures: ((...args: unknown[]) => Promise<Response>)[] = [
      () => Promise.resolve(new Response(KEY, { status: 401 })),
      () => Promise.reject(new Error(`connect failed for ${KEY}`)),
    ];
    const hangs = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    for (const failure of [...failures, hangs]) {
      const result = await createDemoReadinessCheck({
        apiKey: KEY,
        request: failure,
        timeoutMs: 20,
      }).check();
      expect(result).toEqual({ apiKeyConfigured: true, apiReachable: false });
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});
