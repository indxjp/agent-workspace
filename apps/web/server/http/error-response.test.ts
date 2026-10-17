import { describe, expect, it, vi } from 'vitest';

import { DomainError, InfrastructureError } from '../errors';
import { errorResponse } from './error-response';

async function body(response: Response): Promise<{
  error: { code: string; message: string };
}> {
  return (await response.json()) as { error: { code: string; message: string } };
}

describe('errorResponse', () => {
  it('returns explicitly public domain details', async () => {
    const response = errorResponse(
      new DomainError({
        category: 'validation',
        code: 'invalid_example',
        publicMessage: 'The example is invalid.',
      }),
      { component: 'test', operation: 'validate' },
    );

    expect(response.status).toBe(400);
    await expect(body(response)).resolves.toEqual({
      error: { code: 'invalid_example', message: 'The example is invalid.' },
    });
  });

  it('adds Retry-After only for a typed rate limit', () => {
    const response = errorResponse(
      new DomainError({
        category: 'rate-limit',
        code: 'visitor_quota_reached',
        publicMessage: 'Try again later.',
        retryAfterSeconds: 60,
      }),
      { component: 'test', operation: 'rate-limit' },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('wraps unknown failures without exposing their message', async () => {
    const sentinel = 'postgres password=TOP-SECRET';
    const log = vi.fn<(message: string, error: InfrastructureError) => void>();
    const response = errorResponse(new Error(sentinel), {
      component: 'projects',
      operation: 'create',
      log,
    });

    expect(response.status).toBe(500);
    const result = await body(response);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result).toEqual({
      error: { code: 'internal_error', message: 'The request could not be completed.' },
    });
    expect(log).toHaveBeenCalledWith('[projects] create failed', expect.any(InfrastructureError));
    const failure = log.mock.calls[0]?.[1];
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect(failure?.cause).toBeInstanceOf(Error);
  });

  it('uses fixed messages for typed upstream and unavailable failures', async () => {
    const upstream = errorResponse(
      new InfrastructureError({
        component: 'models',
        operation: 'discover',
        failureKind: 'upstream',
        cause: new Error('private upstream detail'),
      }),
      { component: 'models', operation: 'discover', log: vi.fn() },
    );
    const unavailable = errorResponse(
      new InfrastructureError({
        component: 'database',
        operation: 'query',
        failureKind: 'unavailable',
        cause: new Error('private database detail'),
      }),
      { component: 'database', operation: 'query', log: vi.fn() },
    );

    expect(upstream.status).toBe(502);
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await body(upstream))).not.toContain('private upstream detail');
    expect(JSON.stringify(await body(unavailable))).not.toContain('private database detail');
  });
});
