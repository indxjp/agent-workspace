import { describe, expect, it } from 'vitest';

import { apiError, isUuid, json, MAX_JSON_BODY_BYTES, readJsonBody } from './http';

function jsonRequest(body: BodyInit, contentType = 'application/json'): Request {
  return new Request('http://web/api/x', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

describe('json and apiError', () => {
  it('always writes a JSON content type and the one error shape', async () => {
    const response = apiError(404, 'run_not_found', 'no run.');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: { code: 'run_not_found', message: 'no run.' } });
  });

  it('lets a caller add headers without losing the content type', () => {
    const response = json({ a: 1 }, 202, { Location: '/somewhere' });
    expect(response.headers.get('location')).toBe('/somewhere');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('isUuid', () => {
  it('accepts a canonical UUID in either case and rejects everything else', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('11111111-1111-4111-8111-111111111111'.toUpperCase())).toBe(true);
    for (const bad of [
      '',
      'not-a-uuid',
      '11111111111141118111111111111111',
      '11111111-1111-4111-8111-11111111111',
      '11111111-1111-4111-8111-1111111111111',
      '1111111g-1111-4111-8111-111111111111',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isUuid(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('readJsonBody', () => {
  it('parses an application/json body, with or without parameters', async () => {
    expect(await readJsonBody(jsonRequest('{"a":1}'))).toEqual({ kind: 'ok', value: { a: 1 } });
    expect(await readJsonBody(jsonRequest('{"a":1}', 'Application/JSON; charset=utf-8'))).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
  });

  it('rejects a missing or wrong Content-Type rather than sniffing the body', async () => {
    const bare = new Request('http://web/api/x', { method: 'POST', body: '{"a":1}' });
    bare.headers.delete('content-type');
    expect((await readJsonBody(bare)).kind).toBe('rejected');
    expect((await readJsonBody(jsonRequest('{"a":1}', 'text/plain'))).kind).toBe('rejected');
  });

  it('rejects unparseable JSON without exposing parser details', async () => {
    const result = await readJsonBody(jsonRequest('{'));
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('the request body is not valid JSON.');
    expect(result.reason).not.toContain('position');
  });

  it('refuses an over-large body while reading it, not after', async () => {
    // The prompt cap in api.ts runs after JSON.parse, so without this the whole body would already
    // be in memory before anything objected.
    const oversized = 'a'.repeat(MAX_JSON_BODY_BYTES + 1024);
    const result = await readJsonBody(jsonRequest(`"${oversized}"`));
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toContain('exceeds');
  });

  it('accepts a body just under the cap', async () => {
    const body = JSON.stringify({ prompt: 'a'.repeat(1000) });
    expect((await readJsonBody(jsonRequest(body))).kind).toBe('ok');
  });
});
