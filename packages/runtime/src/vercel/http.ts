import { failure, failed } from './errors.js';
const REQUEST_TIMEOUT_MS = 30_000;

export function createVercelHttp(
  options: Readonly<{ teamId: string; apiBase?: string; fetch?: typeof globalThis.fetch }>,
) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? 'https://api.vercel.com').replace(/\/+$/u, '');
  async function call({
    operation,
    path,
    token,
    init,
    query = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: Readonly<{
    operation: string;
    path: string;
    token: string;
    init: RequestInit;
    query?: Record<string, string>;
    timeoutMs?: number | undefined;
  }>): Promise<Response> {
    const search = new URLSearchParams({ teamId: options.teamId, ...query });
    try {
      return await doFetch(`${apiBase}${path}?${search.toString()}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failure(operation);
    }
  }

  async function post(
    operation: string,
    path: string,
    token: string,
    body: unknown,
  ): Promise<unknown> {
    const response = await call({
      operation,
      path,
      token,
      init: { method: 'POST', body: JSON.stringify(body) },
      query: {},
    });
    if (!response.ok) throw await failed(operation, response, token);
    try {
      return await response.json();
    } catch {
      throw failure(operation);
    }
  }

  async function get(
    operation: string,
    path: string,
    token: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await call({
      operation,
      path,
      token,
      init: { method: 'GET' },
      query: query,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw await failed(operation, response, token);
    try {
      return await response.json();
    } catch {
      throw failure(operation);
    }
  }
  return { call, post, get };
}
