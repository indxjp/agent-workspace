import { errorResponse } from './error-response';
import { apiResultResponse } from './json-transport';
import type { ApiResult } from './result';

/** Which route failed, for the server-side log line; never sent to the client. */
type RouteName = Readonly<{ component: string; operation: string }>;

/**
 * The one error boundary an API route handler goes through (engineering audit F-11).
 *
 * The handler answers with an {@link ApiResult} or a ready `Response`. Anything it throws or
 * rejects with — including from `withWorkspaceStore`, `authorise` or a store — is rendered by
 * {@link errorResponse}: a typed `DomainError` as its own envelope, anything else as
 * `500 internal_error` with the generic message, logged server-side under `name`. Without it the
 * failure escapes to Next.js, which answers a bodiless 500 and logs no route context (audit I-02).
 *
 * The name comes first so the handler can stay the last argument and keep its indentation.
 */
export function route<Args extends readonly unknown[]>(
  name: RouteName,
  handler: (...args: Args) => Promise<ApiResult | Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      const answer = await handler(...args);
      return answer instanceof Response ? answer : apiResultResponse(answer);
    } catch (error) {
      return errorResponse(error, name);
    }
  };
}
