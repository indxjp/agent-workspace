import { apiResultResponse } from '../../../server/http/json-transport';
import { uploadToolBundle } from '../../../server/tool-bundles/handlers';
import {
  openToolBundleStore,
  readToolBundleBody,
  toolBundlesNotConfigured,
} from '../../../server/tool-bundles/http';
import { requireResourceAccess } from '../../../server/resources/authorise';

/**
 * `POST /api/tool-bundles` (issue #790, ADR-0118 TS1): store a code tool's bundle under its
 * SHA-256, once. The operations live in `server/tool-bundles/`; this file holds the two calls.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const store = openToolBundleStore(access.principal.workspaceId);
  if (store === null) return apiResultResponse(toolBundlesNotConfigured());
  const body = await readToolBundleBody(request);
  if (!body.ok) return apiResultResponse(body.result);
  return apiResultResponse(await uploadToolBundle(store, body.value));
}
