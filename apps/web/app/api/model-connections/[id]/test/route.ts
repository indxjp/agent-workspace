import { testModelConnection } from '../../../../../server/models/handlers';
import { toResponse, withModelsRuntime } from '../../../../../server/models/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

// issue #149: `parseOperation` (`server/rbac/decide.ts`) reads a `POST` under an `/:id/<sub>` as
// `write` unless `sub` is `runs` or `messages`, and `test` is neither — so this is a write for
// `decide()`'s purposes, exactly like `credential`. `ownership: 'unknown'`, for the same reason as
// the routes above: the grant is `any` or `none` regardless of the row.
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const result = await withModelsRuntime(
    request,
    async (models) => {
      const tested = await testModelConnection(models.store, id, models.probe);
      if (tested.status !== 404) {
        const resource = await models.store.get(id);
        if (resource !== null) {
          await models.audit({ subjectId: resource.id, subjectLabel: resource.name });
        }
      }
      models.log(`model connection ${id} test returned HTTP ${String(tested.status)}`);
      return tested;
    },
    { ownership: 'unknown' },
  );
  return toResponse(result);
}
