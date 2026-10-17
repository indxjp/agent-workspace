/**
 * `GET /api/sessions/:engineSessionId/subkeys` — spec §20.
 *
 * The `subpath`s stored under one session, which is the SDK's `listSubkeys()`. R-01 §7: without
 * it, a resume restores the main transcript and every subagent transcript is lost.
 *
 * Its own route rather than a field on the transcript, so that asking *which* subagent
 * transcripts exist does not require downloading the whole conversation.
 *
 * A sibling of `…/transcript` rather than a child of it, because the shape rule W2-INT-00 derives
 * from §34 stops at `/api/<resource>/:id/<sub>` — *"a fourth level is a resource that has not been
 * named"*. `tests/route-inventory.test.ts` rejected the deeper spelling before this one landed.
 */
import type { NextRequest } from 'next/server';

import { listTranscriptSubkeys } from '../../../../../server/sessions/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/subkeys'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return listTranscriptSubkeys(request, engineSessionId);
}
