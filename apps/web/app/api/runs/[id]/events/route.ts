/**
 * `GET /api/runs/:id/events` — spec §34, §19; contract from the R-13 research note.
 *
 * The pattern every later streaming surface copies is NOT in this file: it is in
 * `apps/web/server/runs/sse.ts`, which owns the headers, the keep-alive, the single teardown path
 * and the in-band failure frame. Spec §19.5 rule 5 forbids a second chat implementation, so this
 * repository also has no second SSE implementation. Copy the import, not the ReadableStream.
 */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../../server/http/error-response';
import { streamRunEvents } from '../../../../../server/runs/api';

// Valid while Cache Components is off (R-13). A long-lived stream must never be prerendered or
// cached; `fetchCache = 'force-no-store'` would be redundant beside this and is omitted.
export const dynamic = 'force-dynamic';
// Never 'edge': deprecated, and this handler needs Node APIs and an unbounded response.
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/runs/[id]/events'>,
): Promise<Response> {
  try {
    const { id } = await context.params;
    return await streamRunEvents(request, id);
  } catch (cause) {
    return errorResponse(cause, { component: 'runs', operation: 'stream-events' });
  }
}
