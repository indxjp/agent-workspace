/** A status and a body, before either becomes an HTTP `Response`. Mirrors `files/handlers.ts`. */
export type ApiResult = { readonly status: number; readonly kind: 'json'; readonly body: unknown };

export interface ApiProblem {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly string[];
  };
}

export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): ApiResult {
  const error =
    details === undefined || details.length === 0
      ? { code, message }
      : { code, message, details: [...details] };
  return { status, kind: 'json', body: { error } satisfies ApiProblem };
}

export function json(status: number, body: unknown): ApiResult {
  return { status, kind: 'json', body };
}
