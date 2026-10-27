/**
 * `GET`, `PATCH` and `DELETE /api/skills/:name` — skill detail (or export), edit/enable-disable/
 * upload, and delete. None is printed in spec §34's own list (only bare `GET`/`POST /api/skills`
 * are), so each carries a `mandate` citing §7, per ADR-0026 decision 2.
 *
 * `GET` serves both "selecting a skill" and "export it" (spec §7) on the **same path**, chosen
 * over a sibling `/api/skills/:name/export` route (this file's first revision) for a reason beyond
 * style: a `/:id/<sub>` route needs its `<sub>` segment classified in
 * `apps/web/server/rbac/permissions.ts`'s `SUB_RESOURCES` — owned by W2-CP-06, not this task — or
 * `apps/web/server/rbac/authorisation-matrix.test.ts` refuses every role on it as an unclassified
 * sub-resource (ADR-0015, ADR-0031). ADR-0040 gives a track its own
 * `apps/web/server/rbac/declarations/<TASK-ID>.ts` for exactly this, but the union that composes
 * it (`declared-sub-resources.ts`) is wired by written-out imports only the integration level adds
 * — the identical shape ADR-0038 already established for `instrumentation.ts`. Rather than ship a
 * route that depends on an import this task cannot add, `export` is a query flag on the resource
 * path §21 already classifies, exactly as `GET /api/files?path=…` (`W2-CP-03`) uses a query
 * parameter rather than a path segment for its own read-a-location verb. `docs/adr/
 * W2-CP-04-skill-storage-keys.md`'s "Decision 6" is the write-up.
 */
import { exportSkill, requireSkillName } from '../../../../server/skills/handlers';
import {
  readJsonBody,
  readNameParam,
  toResponse,
  withWorkspaceSkillsStore,
} from '../../../../server/skills/http';
import { deleteSkill } from '../../../../server/skills/delete';
import { withSkillMetaColumn } from '../../../../server/skills/meta-column';
import { ownershipOfName } from '../../../../server/skills/ownership';
import { problem } from '../../../../server/skills/result';
import {
  catalogNotConfigured,
  getSkillWithId,
  patchSkillWithId,
} from '../../../../server/skills/service';
import { requireResourceAccess } from '../../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * spec §7: "Selecting a skill should show: Name, Description, Instructions, Supporting Files,
 * Allowed Tools, Assigned Agents" (plain `GET`), and "export it" (`GET ?export=true` — see this
 * file's header for why export is a query flag rather than a `/export` path segment).
 *
 * **Round 2, B4.** The plain `GET` now returns five of those six fields: Name, Description,
 * Instructions (`SkillDetail.instructions` — `SKILL.md`'s Markdown body), Supporting Files
 * (`SkillDetail.files`) and Allowed Tools (`SkillDetail.allowedTools`, from frontmatter's
 * `allowed-tools`) — both of the last two read from bytes this task already stores, no new
 * dependency. **Assigned Agents is still not returned, and is not silently omitted: it is a named
 * gap.** `handlers.ts`'s own module header, "Declared gap", is the full account — surfacing it needs
 * an `AgentSkillRepository` this task's `Owns` globs cannot add (`packages/core/src/db/
 * repositories/**` is outside them, and none is exported from `@agent-workspace/core/db` today).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const rawName = await readNameParam(context);
  const parsed = requireSkillName(rawName);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfName(parsed.name));
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  const wantsExport = url.searchParams.get('export') === 'true';
  const result = await withWorkspaceSkillsStore(
    request,
    async (store, catalog, rows) => {
      // An export never carries the `id` field (`SkillExportSchema` has none) — only the plain
      // `SkillDetail` shape does, so only the plain path needs a catalog to answer at all (K-4).
      if (wantsExport) {
        return exportSkill(
          catalog === null ? store : withSkillMetaColumn(store, catalog),
          parsed.name,
          rows,
        );
      }
      if (catalog === null) return catalogNotConfigured();
      return getSkillWithId(store, catalog, access.principal, parsed.name, rows);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/** spec §7: "edit a skill", "upload supporting files", "enable/disable it". */
export async function PATCH(
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
      // K-4: same refusal as GET — no catalog wired means no `id` can be produced for the
      // required field, so this refuses before the store is ever written to.
      if (catalog === null) return catalogNotConfigured();
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return patchSkillWithId(store, catalog, access.principal, parsed.name, body.value, rows);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * `DELETE /api/skills/:name` — delete a skill no agent is assigned (S-12). `409 skill_in_use` names
 * every agent that still has it; see `server/skills/delete.ts` for how the catalog row and the
 * stored bytes are removed as one recoverable operation. Gated like `PATCH`: a Builder deletes
 * only a skill it owns, an Admin any skill (ADR-0116), and a Viewer none.
 */
export async function DELETE(
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
      if (catalog === null) {
        return problem(
          503,
          'skills_runtime_not_configured',
          'The skills catalog is not configured for this deployment; a skill cannot be deleted ' +
            'without checking which agents it is assigned to.',
        );
      }
      return deleteSkill(store, catalog, parsed.name, rows);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
