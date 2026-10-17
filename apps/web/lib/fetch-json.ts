import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import type { z } from 'zod';

function responseErrorMessage(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const error = (body as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const record = error as Record<string, unknown>;
      const message = record['message'] ?? record['detail'];
      if (typeof message === 'string' && message.trim() !== '') return message;
    }
    if (typeof error === 'string' && error.trim() !== '') return error;
  }
  return `Request returned ${String(status)}`;
}

/**
 * Fetch JSON and validate the remote value before it enters application state. Like the SDK, it
 * states the contracts version the screen was built against (issue #244, S-7).
 */
export async function fetchJson<Schema extends z.ZodType>(
  input: RequestInfo | URL,
  schema: Schema,
  init?: RequestInit,
): Promise<z.infer<Schema>> {
  const headers = new Headers(init?.headers);
  headers.set(CONTRACTS_VERSION_HEADER, CONTRACTS_VERSION);
  const response = await fetch(input, { ...init, headers });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseErrorMessage(response.status, body));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`The server returned an invalid response: ${parsed.error.message}`);
  }
  return parsed.data;
}
