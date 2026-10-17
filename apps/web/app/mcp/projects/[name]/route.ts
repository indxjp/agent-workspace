/** `POST /mcp/projects/:name` — an mcp-project endpoint client's public MCP endpoint (ADR-0134). */
import type { NextRequest } from 'next/server';

import { errorResponse } from '../../../../server/http/error-response';
import { serveToolEndpoint } from '../../../../server/tool-endpoint/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: RouteContext<'/mcp/projects/[name]'>,
): Promise<Response> {
  try {
    const { name } = await context.params;
    return await serveToolEndpoint(request, name);
  } catch (cause) {
    return errorResponse(cause, { component: 'tool-endpoint', operation: 'rpc' });
  }
}
