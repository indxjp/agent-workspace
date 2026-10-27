import { apiResultResponse } from '../../../../server/http/json-transport';
import { getToolBundle } from '../../../../server/tool-bundles/handlers';
import {
  openToolBundleStore,
  toolBundlesNotConfigured,
} from '../../../../server/tool-bundles/http';
import { readRouteParam } from '../../../../server/http/json-transport';
import { requireResourceAccess } from '../../../../server/resources/authorise';

/** `GET /api/tool-bundles/:digest` (issue #790, ADR-0118 TS1): whether this workspace holds it. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ digest: string }> },
): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const store = openToolBundleStore(access.principal.workspaceId);
  if (store === null) return apiResultResponse(toolBundlesNotConfigured());
  return apiResultResponse(await getToolBundle(store, await readRouteParam(context, 'digest')));
}
