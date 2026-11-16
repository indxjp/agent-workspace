/**
 * The store's calls to the platform that the SDK does not wrap: the email-link sign-in, the lead
 * form, the demo allowance and the privacy facts (spec "The store app"). Each goes to the
 * platform's public API with the body its `@indx-workspace/contracts` schema types, from the
 * visitor's browser with the visitor's cookies (`credentials: 'include'`), so the platform's
 * per-client limits count the visitor's own address. An answer is the parsed value or the
 * platform's refusal code, never its message: each screen words the refusal itself.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { z } from 'zod';

/** A platform answer: the value, or the refusal code and `Retry-After` seconds when it sent one. */
export type PlatformAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly retryAfterSeconds: number | null;
    };

/** No answer could be read: the network failed or the platform answered something unexpected. */
const UNREACHABLE = 'platform_unreachable';

async function refusal(response: Response) {
  const retry = Number(response.headers.get('retry-after'));
  const parsed = ApiProblemSchema.safeParse(await response.json().catch(() => null));
  return {
    ok: false as const,
    status: response.status,
    code: parsed.success ? parsed.data.error.code : UNREACHABLE,
    retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
  };
}

/** `method path` on the platform at `platformUrl`, the answer parsed with `schema`. */
export async function callPlatform<T>(
  platformUrl: string,
  path: string,
  schema: z.ZodType<T>,
  init: { readonly method: 'GET' | 'POST'; readonly body?: unknown } = { method: 'GET' },
): Promise<PlatformAnswer<T>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, platformUrl), {
      method: init.method,
      credentials: 'include',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, status: 0, code: UNREACHABLE, retryAfterSeconds: null };
  }
  if (!response.ok) return refusal(response);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: response.status, code: UNREACHABLE, retryAfterSeconds: null };
}
