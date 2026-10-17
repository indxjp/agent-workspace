import {
  getModelConnection,
  rotateModelConnectionCredential,
} from '../../../../../server/models/handlers';
import { readJsonBody, toResponse, withModelsRuntime } from '../../../../../server/models/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/**
 * #126's write-only rotation route: a caller who already knows this connection exists may replace
 * its credential without ever supplying or learning the value currently stored. `PATCH` on the
 * parent resource continues to reject an `apiKey` field outright — this is the one HTTP path that
 * may write a provider key after creation.
 *
 * issue #149: `ownership: 'unknown'` — the `model-connections` grant is `any` for Owner/Admin and
 * `none` for Builder/Viewer either way, so no row is read to decide.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const result = await withModelsRuntime(
    request,
    async (models) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      const existing = await getModelConnection(models.store, id);
      const rotated = await rotateModelConnectionCredential(models.store, id, body.value);
      if (rotated.status === 204 && existing.status === 200) {
        const resource = existing.body as { id: string; name: string };
        await models.audit({ subjectId: resource.id, subjectLabel: resource.name });
        models.log(`model connection ${resource.id} credential rotated`);
      }
      return rotated;
    },
    { ownership: 'unknown' },
  );
  return toResponse(result);
}
