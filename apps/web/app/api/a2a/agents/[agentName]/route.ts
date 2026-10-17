/** `POST /api/a2a/agents/:agentName` — a published agent's A2A v0.3 JSON-RPC endpoint (ADR-0135). */
import type { NextRequest } from 'next/server';

import { serveA2aRpc } from '../../../../../server/a2a/dispatch';
import { errorResponse } from '../../../../../server/http/error-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/a2a/agents/[agentName]'>,
): Promise<Response> {
  try {
    const { agentName } = await context.params;
    return await serveA2aRpc(request, agentName);
  } catch (cause) {
    return errorResponse(cause, { component: 'a2a', operation: 'rpc' });
  }
}
