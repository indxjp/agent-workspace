/**
 * `GET /api/sessions/:engineSessionId/state-streams` — spec §20 (ENG-06).
 *
 * Which streams a session has, which is the engine-neutral replacement for `…/subkeys`: an adapter
 * resuming a session has to know what exists before it can read it, and R-01 §7 records that a
 * resume without that listing restores the Claude main transcript and loses every subagent's.
 *
 * A sibling of `…/state-entries` rather than a child, because the §34 shape rule W2-INT-00 derives
 * stops at `/api/<resource>/:id/<sub>` — the same reason `…/subkeys` is a sibling of `…/transcript`.
 */
import type { NextRequest } from 'next/server';

import { listSessionStateStreams } from '../../../../../server/sessions/state-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/state-streams'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return listSessionStateStreams(request, engineSessionId);
}
