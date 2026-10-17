/**
 * `POST /api/tokens` — issue #236 (SDK-04, S-1). Mint a short-lived, run- or session-scoped
 * bearer for a customer's own frontend.
 *
 * A five-line adapter, like every other route file of this task: `mintToken` in
 * `apps/web/server/tokens/handlers.ts` is a plain `Request` → `ApiResult` function and is tested
 * without a server.
 */
import { mintToken } from '../../../server/tokens/handlers';
import { toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return toResponse(await mintToken(request));
}
