import { ApiProblemSchema } from '@indx-workspace/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppStoreError } from '../db/errors.js';
import { AppServerError, fromStoreError, problem, problemFromError } from './problem.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  ApiProblemSchema.parse(body);
  return body.error;
}

describe('problem', () => {
  it('renders code, message and details with no-store, and never a detail key', async () => {
    const response = problem('invalid_body', 400, 'The record is not valid.', ['title']);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const error = await bodyOf(response);
    expect(error).toEqual({
      code: 'invalid_body',
      message: 'The record is not valid.',
      details: ['title'],
    });
    expect(error).not.toHaveProperty('detail');
  });

  it('leaves details out when there are none', async () => {
    expect(Object.keys(await bodyOf(problem('forbidden', 403, 'No.')))).toEqual([
      'code',
      'message',
    ]);
  });
});

describe('fromStoreError', () => {
  it('renders the store’s code, status, fixed message and details', async () => {
    const response = fromStoreError(new AppStoreError('invalid_query', { details: ['where.x'] }));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      code: 'invalid_query',
      message: 'The query is not one this list accepts.',
      details: ['where.x'],
    });
  });
});

describe('problemFromError', () => {
  it('hides an internal error’s text from the answer and the log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = problemFromError(new Error('password=hunter2 at 10.0.0.1'));
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({
      code: 'internal_error',
      message: 'The request failed.',
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('hunter2');
  });

  it('logs the cause of a store’s internal_error by name only', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = problemFromError(
      new AppStoreError('internal_error', { cause: new Error('relation "secret" does not exist') }),
    );
    expect(await bodyOf(response)).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  });

  it('renders a server error with its fixed message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = problemFromError(
      new AppServerError('upstream_failure', { cause: new Error('token awo_live_x') }),
    );
    expect(response.status).toBe(502);
    const error = await bodyOf(response);
    expect(error['code']).toBe('upstream_failure');
    expect(JSON.stringify(error)).not.toContain('awo_live_x');
  });

  it('logs nothing for a refusal', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    problemFromError(new AppStoreError('forbidden'));
    problemFromError(new AppServerError('app_misconfigured'));
    expect(errors).not.toHaveBeenCalled();
  });
});
