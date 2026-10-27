/**
 * `GET /api/files/search?q=…&limit=…` — lexical search over the text of the workspace's files
 * (ADR-0147, P8-4). It sits beside `GET /api/files/:id`; the static segment wins over the dynamic
 * one, and `tests/route-declarations/P8-4-FILE-SEARCH-1314.ts` declares it.
 */
import { toResponse } from '../../../../server/files/http';
import {
  invalidQuery,
  parseSearchQuery,
  searchWorkspaceFiles,
} from '../../../../server/files/search-http';
import { requireResourceAccess } from '../../../../server/resources/authorise';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function searchFiles(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const query = parseSearchQuery(request);
  if (query === null) return toResponse(invalidQuery());
  return toResponse(await searchWorkspaceFiles(request, access.principal.workspaceId, query, null));
}

export const GET = route({ component: 'files', operation: 'search' }, searchFiles);
