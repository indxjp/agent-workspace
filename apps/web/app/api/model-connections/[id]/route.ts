import {
  deleteModelConnection,
  getModelConnection,
  updateModelConnection,
} from '../../../../server/models/handlers';
import { readJsonBody, toResponse, withModelsRuntime } from '../../../../server/models/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return toResponse(await withModelsRuntime(request, ({ store }) => getModelConnection(store, id)));
}

// issue #149: `ownership` is `'unknown'` for both routes below — the store is workspace-bound (a
// foreign id already answers 404, issue #117), and the `model-connections` grant that decides a
// write is `any` for Owner/Admin and `none` for Builder/Viewer either way, so no ownership
// resolver is built to read the row before deciding.
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const result = await withModelsRuntime(
    request,
    async (models) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      const updated = await updateModelConnection(models.store, id, body.value);
      if (updated.status === 200) {
        const resource = updated.body as { id: string; name: string };
        await models.audit({ subjectId: resource.id, subjectLabel: resource.name });
        models.log(`model connection ${resource.id} updated`);
      }
      return updated;
    },
    { ownership: 'unknown' },
  );
  return toResponse(result);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const result = await withModelsRuntime(
    request,
    async (models) => {
      const existing = await getModelConnection(models.store, id);
      const deleted = await deleteModelConnection(models.store, id);
      if (deleted.status === 200 && existing.status === 200) {
        const resource = existing.body as { id: string; name: string };
        await models.audit({ subjectId: resource.id, subjectLabel: resource.name });
        models.log(`model connection ${resource.id} deleted`);
      }
      return deleted;
    },
    { ownership: 'unknown' },
  );
  return toResponse(result);
}
