import { describe, expect, it } from 'vitest';

import { noStoreResultResponse, problem, problemBody, problemWithDetail } from './result';

describe('problem', () => {
  it('wraps the code and message in the error envelope', () => {
    expect(problem(400, 'x', 'm')).toEqual({
      status: 400,
      body: { error: { code: 'x', message: 'm' } },
    });
  });

  it('omits details when none or an empty list is given', () => {
    for (const details of [undefined, []] as const) {
      const result = problem(400, 'x', 'm', details);
      expect(result.body).toEqual({ error: { code: 'x', message: 'm' } });
      expect('details' in (result.body as { error: object }).error).toBe(false);
    }
  });

  it('carries details as a copy of the input', () => {
    const details = ['a'];
    const result = problem(422, 'x', 'm', details);
    details.push('b');
    expect(result.body).toEqual({ error: { code: 'x', message: 'm', details: ['a'] } });
  });
});

describe('problemWithDetail', () => {
  it('repeats the message as detail, after code and message', () => {
    const result = problemWithDetail(403, 'forbidden', 'm');
    expect(result).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'm', detail: 'm' } },
    });
    expect(JSON.stringify(result.body)).toBe(
      '{"error":{"code":"forbidden","message":"m","detail":"m"}}',
    );
  });
});

describe('noStoreResultResponse', () => {
  it('serialises a body with no-store, the json content type and merged headers', async () => {
    const body = { a: 1 };
    const response = noStoreResultResponse({ status: 429, body, headers: { 'retry-after': '3' } });
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.text()).toBe(JSON.stringify(body));
  });

  it('answers a 204 with no body and no content type', async () => {
    const response = noStoreResultResponse({ status: 204, body: null });
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });
});

describe('problemBody', () => {
  it('builds the same envelope without a status', () => {
    expect(problemBody('x', 'm')).toEqual({ error: { code: 'x', message: 'm' } });
    expect(problemBody('x', 'm', [])).toEqual({ error: { code: 'x', message: 'm' } });
    expect(problemBody('x', 'm', ['a'])).toEqual({
      error: { code: 'x', message: 'm', details: ['a'] },
    });
  });
});
