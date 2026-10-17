import { describe, expect, it, vi } from 'vitest';

import {
  apiResultResponse,
  jsonBodyResponse,
  readBoundedJson,
  readRouteParam,
  readSizedJson,
} from './json-transport';

type Result = Readonly<{ status: number; body: unknown }>;

const problem = (status: number, code: string, message: string): Result => ({
  status,
  body: { error: { code, message } },
});

function request(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request('http://web.test/resource', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('readBoundedJson', () => {
  it('parses JSON within its caller-owned limit', async () => {
    await expect(
      readBoundedJson(request('{"ok":true}'), { maxBytes: 64, problem }),
    ).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
    await expect(readSizedJson(request('{"ok":true}'), { maxBytes: 64, problem })).resolves.toEqual(
      { ok: true, value: { ok: true }, bytes: 11 },
    );
  });

  it('rejects unsupported media, invalid lengths, UTF-8, JSON, and empty bodies distinctly', async () => {
    const cases = [
      request('{}', { 'content-type': 'text/plain' }),
      request('{}', { 'content-length': 'invalid' }),
      request(new Uint8Array([0xff])),
      request('{'),
      request(''),
    ];
    for (const candidate of cases) {
      const result = await readBoundedJson(candidate, { maxBytes: 64, problem });
      expect(result.ok).toBe(false);
    }
  });

  it('cancels a streaming body as soon as its limit is crossed', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"too":"large"}'));
      },
      cancel,
    });
    const streamingRequest = new Request('http://web.test/resource', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const result = await readBoundedJson(streamingRequest, { maxBytes: 4, problem });
    expect(result).toMatchObject({ ok: false, result: { status: 413 } });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('response and route parameter transport', () => {
  it('keeps empty responses bodyless and JSON responses typed', async () => {
    expect((await apiResultResponse({ status: 204, body: null }).text()).length).toBe(0);
    const response = jsonBodyResponse(200, { ok: true }, { 'x-content-type-options': 'nosniff' });
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('reads only the named parameter from a resolved object', async () => {
    await expect(readRouteParam({ params: Promise.resolve({ id: 'one' }) }, 'id')).resolves.toBe(
      'one',
    );
    await expect(readRouteParam({ params: Promise.resolve(null) }, 'id')).resolves.toBeUndefined();
  });
});
