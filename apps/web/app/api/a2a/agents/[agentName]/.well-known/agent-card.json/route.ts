/** `GET /api/a2a/agents/:agentName/.well-known/agent-card.json` — the A2A agent card (ADR-0135). */
import type { NextRequest } from 'next/server';

import { serveA2aCard } from '../../../../../../../server/a2a/dispatch';
import { errorResponse } from '../../../../../../../server/http/error-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/a2a/agents/[agentName]/.well-known/agent-card.json'>,
): Promise<Response> {
  try {
    const { agentName } = await context.params;
    return await serveA2aCard(request, agentName);
  } catch (cause) {
    return errorResponse(cause, { component: 'a2a', operation: 'agent-card' });
  }
}
