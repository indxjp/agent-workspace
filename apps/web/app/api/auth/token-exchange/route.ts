/**
 * `/api/auth/token-exchange` — ADR-0161. An app backend exchanges the signed-in person's OIDC ID
 * token for a short-lived access token of its `app-backend` endpoint client.
 */
import { exchangeToken } from '../../../../server/auth/token-exchange';
import { route } from '../../../../server/http/route';
import { toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function exchange(request: Request): Promise<Response> {
  return toResponse(await exchangeToken(request));
}

export const POST = route({ component: 'auth', operation: 'token-exchange' }, exchange);
