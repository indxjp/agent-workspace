/**
 * `POST /api/agents/:id/restore` (issue #1851): un-archive an agent, with no request body.
 * Who may: the Owner, an Admin, or the agent's owner — the same decision as any agent write.
 */
import { restoreAgent } from '../../../../../server/agents/handlers';
import {
  agentOwnership,
  readAgentIdParam,
  readNoBody,
  withAuthorisedWorkspaceStore,
} from '../../../../../server/agents/http';
import { route } from '../../../../../server/http/route';
import type { ApiResult } from '../../../../../server/http/result';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function servePost(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<ApiResult> {
  const id = await readAgentIdParam(context);
  return withAuthorisedWorkspaceStore(
    request,
    agentOwnership(id, 'update'),
    async (store, _runtime, _workspaceId, principal) =>
      (await readNoBody(request)) ?? restoreAgent(store, id, principal),
  );
}

export const POST = route({ component: 'agents', operation: 'restore' }, servePost);
