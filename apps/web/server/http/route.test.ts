import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '../errors';
import { route } from './route';

const NAME = { component: 'test', operation: 'serve' } as const;
const SENTINEL = 'postgresql://admin:TOP-SECRET@internal.example/workspace';

describe('route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an ApiResult, keeping the empty arm body-less', async () => {
    const ok = await route(NAME, () => Promise.resolve({ status: 201, body: { id: 'a' } }))();
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ id: 'a' });

    const empty = await route(NAME, () => Promise.resolve({ status: 204, body: null }))();
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });

  it('passes a Response through and hands the handler every argument', async () => {
    const answer = new Response('raw', { status: 202 });
    const handler = vi.fn<(request: Request, id: string) => Promise<Response>>(() =>
      Promise.resolve(answer),
    );
    const request = new Request('http://localhost/');

    expect(await route(NAME, handler)(request, 'id-1')).toBe(answer);
    expect(handler).toHaveBeenCalledWith(request, 'id-1');
  });

  it('renders a thrown DomainError as its own envelope', async () => {
    const response = await route(NAME, () =>
      Promise.reject(
        new DomainError({ category: 'conflict', code: 'taken', publicMessage: 'Taken.' }),
      ),
    )();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'taken', message: 'Taken.' } });
  });

  it('renders an unknown failure as 500 internal_error and logs it server-side only', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const failure = new Error(SENTINEL);

    const response = await route(NAME, () => {
      throw failure;
    })();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(SENTINEL);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal_error', message: 'The request could not be completed.' },
    });
    expect(log).toHaveBeenCalledWith('[test] serve failed', {
      error: expect.objectContaining({ cause: failure }) as unknown,
    });
  });
});
