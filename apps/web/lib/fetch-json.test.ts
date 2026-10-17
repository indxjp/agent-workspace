import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';

import { fetchJson } from './fetch-json';

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
  it('states the contracts version and keeps the caller headers', async () => {
    const fetchStub = vi.fn().mockResolvedValue(Response.json({ id: 'one' }));
    vi.stubGlobal('fetch', fetchStub);
    await fetchJson('/resource', z.object({ id: z.string() }), { headers: { 'x-trace': 't' } });
    const init: unknown = fetchStub.mock.calls[0]?.[1];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    expect(headers.get('x-trace')).toBe('t');
  });

  it('returns only a response that matches its schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'one' })));
    await expect(fetchJson('/resource', z.object({ id: z.string() }).strict())).resolves.toEqual({
      id: 'one',
    });
  });

  it('rejects malformed success bodies and preserves API problem messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 1 })));
    await expect(fetchJson('/resource', z.object({ id: z.string() }))).rejects.toThrow(
      'invalid response',
    );

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: 'Not available.' } }, { status: 503 }),
        ),
    );
    await expect(fetchJson('/resource', z.unknown())).rejects.toThrow('Not available.');
  });

  it('rejects non-JSON responses without leaking a parser exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json')));
    await expect(fetchJson('/resource', z.string())).rejects.toThrow('invalid response');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 502 })),
    );
    await expect(fetchJson('/resource', z.unknown())).rejects.toThrow('Request returned 502');
  });

  it('passes request options, including cancellation, through, adding only the contracts header', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', request);
    const controller = new AbortController();
    const init = { method: 'POST', signal: controller.signal } satisfies RequestInit;

    await fetchJson('/resource', z.object({ ok: z.boolean() }), init);

    const [url, sent] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/resource');
    expect(sent.method).toBe('POST');
    expect(sent.signal).toBe(controller.signal);
    expect(Object.keys(sent).sort()).toEqual(['headers', 'method', 'signal']);
  });
});
