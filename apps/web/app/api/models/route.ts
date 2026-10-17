import { listDiscoveredModels } from '../../../server/models/handlers';
import { toResponse, withModelsRuntime } from '../../../server/models/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return toResponse(
    await withModelsRuntime(request, ({ store, discover }) =>
      listDiscoveredModels(store, discover),
    ),
  );
}
