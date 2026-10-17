/**
 * `POST /api/runs/:id/revoke-tokens` — issue #235 (S-15).
 *
 * The named path for the capability `POST /api/runs/:id` has served since W1-CP-04; that path is
 * kept until the next major release (ADR-0078 D7) (deprecated, `tests/route-declarations/W1-CP-04.ts`) and both answer
 * through the exact same handler, `apps/web/server/runs/api.ts`'s `revokeRunTokens` — no second
 * copy of the behaviour.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { revokeRunTokens } from '../../../../../server/runs/api';

// Valid while Cache Components is off. A route handler that reads a request must not be
// prerendered; `force-dynamic` says so.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and the run API needs Node APIs.
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]/revoke-tokens'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await revokeRunTokens(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'revoke-tokens' });
  }
}
