/**
 * `GET /api/me` — the principal the client's own credential resolves to.
 *
 * It sits here rather than under `resources/` on purpose. Every file in that directory is a
 * resource *family* — a class the root client exposes as a property, and which
 * `scripts/docs/lib/families.mjs` renders a `reference/sdk/<family>.mdx` page for. `me` is not a
 * family: it is one operation, it takes no id, and `docs/sdk/04-api-specification.md` §5.2 prints
 * it as `me()` with no prefix. So it is a function over the shared transport, exposed as a method
 * on {@link AgentWorkspaceClient} rather than as a nested client.
 */
import { MeResponseSchema, type MeResponse } from '@indx-workspace/contracts/team';

import type { HttpClient, RequestOptions } from './http.js';

/**
 * Who this credential is: its `principalId`, `kind`, `role` and `workspaceId`, plus `userId` and
 * a human `label` for a session caller — `userId` is `null` for exactly an API-key principal.
 *
 * `401 unauthenticated` is an {@link ApiProblemError}, and it is what a revoked key and an
 * expired session both answer; the SDK never retries it. A body outside the contract — a field
 * the server added, a `kind` neither vocabulary has — is a {@link ContractViolationError} rather
 * than a partially trusted principal.
 */
export function readMe(http: HttpClient, options: RequestOptions = {}): Promise<MeResponse> {
  return http.json({
    operation: 'me',
    method: 'GET',
    path: '/api/me',
    expect: [200],
    schema: MeResponseSchema,
    signal: options.signal,
  });
}
