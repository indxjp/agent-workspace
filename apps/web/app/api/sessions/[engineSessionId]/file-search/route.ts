/**
 * `GET /api/sessions/:engineSessionId/file-search` — the running agent's file search (ADR-0147,
 * P8-4), confined to the files the run was granted. Runner principal only.
 */
import type { NextRequest } from 'next/server';

import { searchRunFiles } from '../../../../../server/sessions/file-search-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/sessions/[engineSessionId]/file-search'>,
): Promise<Response> {
  const { engineSessionId } = await context.params;
  return searchRunFiles(request, engineSessionId);
}
