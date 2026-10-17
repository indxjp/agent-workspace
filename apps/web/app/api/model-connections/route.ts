import { createModelConnection, listModelConnections } from '../../../server/models/handlers';
import { readJsonBody, toResponse, withModelsRuntime } from '../../../server/models/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Out-of-glob addition, issue #130 — see `docs/adr/W9-MODEL-130-model-connections-list-route.md`. */
export async function GET(request: Request): Promise<Response> {
  return toResponse(await withModelsRuntime(request, ({ store }) => listModelConnections(store)));
}

// issue #149: a collection route names no single row, so `ownership` is `'not-applicable'` — the
// `model-connections` grant that decides this is `any` for Owner/Admin and `none` for
// Builder/Viewer, and neither reads a row before deciding.
export async function POST(request: Request): Promise<Response> {
  const result = await withModelsRuntime(
    request,
    async (context) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      const created = await createModelConnection(context.store, body.value);
      if (created.status === 201) {
        const resource = created.body as { id: string; name: string };
        await context.audit({ subjectId: resource.id, subjectLabel: resource.name });
        context.log(`model connection ${resource.id} created`);
      }
      return created;
    },
    { ownership: 'not-applicable' },
  );
  return toResponse(result);
}
