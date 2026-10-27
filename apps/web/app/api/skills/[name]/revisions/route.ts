/**
 * `POST /api/skills/:name/revisions` — publish the skill as the next immutable, numbered revision an
 * agent can pin (SDK-19, N-1). Gated as `PATCH /api/skills/:name` is: a Builder publishes a skill
 * they own, an Admin any skill, a Viewer none (`rbac/declarations/SDK-19-SKILL-REVISIONS-251.ts`).
 */
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import { requireSkillName } from '../../../../../server/skills/handlers';
import {
  readJsonBody,
  readNameParam,
  toResponse,
  withWorkspaceSkillsStore,
} from '../../../../../server/skills/http';
import { ownershipOfName } from '../../../../../server/skills/ownership';
import {
  catalogNotConfigured,
  publishSkillRevisionWithId,
} from '../../../../../server/skills/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const rawName = await readNameParam(context);
  const parsed = requireSkillName(rawName);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfName(parsed.name));
  if (!access.ok) return access.response;

  const result = await withWorkspaceSkillsStore(
    request,
    async (store, catalog, rows) => {
      if (catalog === null) return catalogNotConfigured();
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return publishSkillRevisionWithId(
        store,
        catalog,
        access.principal,
        parsed.name,
        body.value,
        rows,
      );
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
