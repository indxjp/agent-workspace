/** `POST /mcp/builder` — the Builder's read-only door for an outside MCP client (#1846 slice 5b). */
import type { NextRequest } from 'next/server';

import { serveExternalBuilderMcp } from '../../../server/builder/transport/external';
import { errorResponse } from '../../../server/http/error-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    return await serveExternalBuilderMcp(request);
  } catch (cause) {
    return errorResponse(cause, { component: 'builder', operation: 'external-mcp' });
  }
}
