/**
 * `POST /api/builder/mcp` — the `aw-control` door a run's gateway calls with the run token. The
 * logic is `server/builder/transport/mcp.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { serveBuilderMcp } from '../../../../server/builder/transport/mcp';
import { route } from '../../../../server/http/route';
import { apiError } from '../../../../server/runs/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(
  { component: 'builder', operation: 'mcp' },
  async (request: Request): Promise<Response> => {
    const context = applicationContext();
    if (context === null) {
      return apiError(503, 'builder_not_configured', 'the Builder is not configured.');
    }
    return serveBuilderMcp(request, context.builder);
  },
);
