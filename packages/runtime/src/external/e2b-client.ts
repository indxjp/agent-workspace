import { REQUEST_TIMEOUT_MS } from './e2b-process-config.js';
import { failure, rejected, json } from './e2b-errors.js';

export const SANDBOX_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function createE2bClient({
  fetch: doFetch,
  apiBase,
}: {
  readonly fetch: typeof globalThis.fetch;
  readonly apiBase: string;
}) {
  async function call(
    operation: string,
    path: string,
    apiKey: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await doFetch(`${apiBase}${path}`, {
        ...init,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw failure(operation);
    }
  }

  async function destroy(sandboxId: string, apiKey: string): Promise<void> {
    // A kill is DELETE /sandboxes/{id}; the issue's plan names it, the API reference page for it was
    // not reachable on 2026-10-08, so the live lane (E7) is where it is proven.
    const response = await call('destroy', `/sandboxes/${encodeURIComponent(sandboxId)}`, apiKey, {
      method: 'DELETE',
    });
    if (response.ok || response.status === 404) {
      await response.body?.cancel();
      return;
    }
    throw await rejected('destroy', response, [apiKey]);
  }

  /**
   * GET /v2/sandboxes?metadata=<k>=<v>&...&state=running lists a team's running sandboxes with all
   * of that metadata (`sandboxID`, `endAt`; https://github.com/e2b-dev/infra/blob/main/spec/openapi.yml,
   * checked 2026-10-08).
   */
  async function listed(
    operation: string,
    tags: Readonly<Record<string, string>>,
    limit: number,
    apiKey: string,
  ): Promise<readonly unknown[]> {
    const query = new URLSearchParams({
      metadata: new URLSearchParams(tags).toString(),
      state: 'running',
      limit: String(limit),
    });
    const response = await call(operation, `/v2/sandboxes?${query.toString()}`, apiKey, {
      method: 'GET',
    });
    if (!response.ok) throw await rejected(operation, response, [apiKey]);
    const items = await json(operation, response);
    return Array.isArray(items) ? (items as unknown[]) : [];
  }

  /** POST /sandboxes/{id}/connect: the sandbox's addresses and tokens, for `seconds` more. */
  async function connect(
    operation: string,
    sandboxId: string,
    seconds: number,
    apiKey: string,
  ): Promise<unknown> {
    const connected = await call(
      operation,
      `/sandboxes/${encodeURIComponent(sandboxId)}/connect`,
      apiKey,
      { method: 'POST', body: JSON.stringify({ timeout: seconds }) },
    );
    if (!connected.ok) throw await rejected(operation, connected, [apiKey]);
    return await json(operation, connected);
  }

  return { call, destroy, listed, connect };
}
