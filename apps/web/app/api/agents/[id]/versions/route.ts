import {
  createAgentVersion,
  listAgentVersions,
} from '../../../../../server/agent-versions/handlers';
import {
  readAgentVersionBody,
  serveAgentVersionRoute,
} from '../../../../../server/agent-versions/http';
import { route } from '../../../../../server/http/route';
import { installBuiltinSkillsNamedBy } from '../../../../../server/skills/builtin';

/**
 * `GET`/`POST /api/agents/:id/versions` (S1-05, issue #443; ADR-0101). Authorisation, the
 * runtimes and the body bound live in `server/agent-versions/http.ts`; the version pipeline every
 * save and dry run share (C8) in `server/agent-versions/pipeline.ts`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function serveGet(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(request, context, 'read', ({ agent, store }) =>
    listAgentVersions(agent.id, store),
  );
}

export const GET = route({ component: 'agent-versions', operation: 'list' }, serveGet);

async function servePost(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAgentVersionRoute(
    request,
    context,
    'create-version',
    async ({
      agent,
      principal,
      store,
      ceiling,
      toolBundles,
      storageConnections,
      toolHost,
      toolDomainsRefusal,
    }) => {
      const body = await readAgentVersionBody(request);
      if (!body.ok) return body.result;
      const draft = body.value as { body?: unknown; dryRun?: unknown } | null;
      // A dry run has no side effects, so it does not install the built-in it names.
      if (draft?.dryRun !== true) await installBuiltinSkillsNamedBy(draft?.body, principal);
      return createAgentVersion(body.value, agent, principal.principalId, {
        store,
        ceiling,
        toolBundles,
        storageConnections,
        toolHost,
        toolDomainsRefusal,
      });
    },
  );
}

export const POST = route({ component: 'agent-versions', operation: 'create' }, servePost);
