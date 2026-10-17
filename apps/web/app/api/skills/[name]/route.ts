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
import {
  exportSkill,
  getSkill,
  patchSkill,
  problem,
  requireSkillName,
  unreadableSkillMdProblem,
} from '../../../../server/skills/handlers';
import {
  readJsonBody,
  readNameParam,
  toResponse,
  withWorkspaceSkillsStore,
} from '../../../../server/skills/http';
import { deleteSkill } from '../../../../server/skills/delete';
import {
  pendingSkillDeleteNames,
  readPendingSkillDelete,
  syncSkillCatalogRow,
} from '../../../../server/skills/pending-delete';
import { currentSkillsRuntime } from '../../../../server/skills/runtime';
import { requireResourceAccess } from '../../../../server/resources/authorise';
import type { OwnershipResolver } from '../../../../server/rbac/http';

/**
 * Issue #117: load the skill's catalog row within the caller's workspace and compare its
 * `created_by` against the caller. A name with no catalog row answers `unknown` rather than
 * `other` — see `apps/web/app/api/files/[id]/route.ts`'s `ownershipOfPath` for the same reasoning.
 *
 * #240 review: a delete interrupted after its catalog step has no row left, but its pending-delete
 * marker records the owner (ADR-0077 D3). That owner answers here, so the owning Builder can finish
 * their own delete and nobody else gains the skill.
 */
function ownershipOfName(name: string): OwnershipResolver {
  return async (principal) => {
    const runtime = currentSkillsRuntime();
    if (runtime === null || runtime.catalog === undefined) {
      return { kind: 'ownership', ownership: 'unknown' };
    }
    const skills = await (await runtime.catalog.forWorkspace(principal.workspaceId)).listSkills();
    const row = skills.find((skill) => skill.name === name);
    const owner =
      row?.ownerPrincipalId ??
      (await readPendingSkillDelete(runtime.store.forWorkspace(principal.workspaceId), name))
        ?.ownerPrincipalId ??
      null;
    if (owner === null) return { kind: 'ownership', ownership: 'unknown' };
    return { kind: 'ownership', ownership: principal.ownerPrincipalId === owner ? 'own' : 'other' };
  };
}

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
    async (store, catalog) => {
      const response = wantsExport
        ? await exportSkill(store, parsed.name)
        : await getSkill(store, parsed.name);
      // An export never carries the `id` field (`SkillExportSchema` has none) — only the plain
      // `SkillDetail` shape does, so only the plain path needs a catalog to answer at all (K-4).
      if (wantsExport) return response;
      if (catalog === null) {
        return problem(
          503,
          'skills_runtime_not_configured',
          'The skills catalog is not configured for this deployment; every skill needs a catalog ' +
            'id, and none can be produced without one.',
        );
      }
      if (response.status !== 200) return response;
      const exported = await exportSkill(store, parsed.name);
      const files =
        (exported.body as { skill?: { files?: Array<{ path: string; contentBase64: string }> } })
          .skill?.files ?? [];
      const manifest = files.find((file) => file.path === 'SKILL.md');
      // K-4: the same residual `GET /api/skills` answers `500 store_inconsistent` for. Returning
      // `response` here would answer `200` with no `id` — a body `SkillDetailSchema` rejects — and
      // leave two routes disagreeing about one row. Reachable from a pre-existing row and from
      // `patchSkill`'s rollback path, which can leave a skill without a `SKILL.md` to restore.
      //
      // `source` is the second half of that residual and not a rewording of the first: `listSkills`
      // refuses on `source === null`, which `describeSkill` sets for a *missing* `SKILL.md` **and**
      // for one whose bytes are not valid UTF-8, while `exportSkill` base64-encodes those bytes
      // just the same — so a manifest is present for a row the list route refuses. Decoding it
      // would be lossy (`U+FFFD`), non-blank, and would write mojibake into the catalog.
      const source = (response.body as { skill: { source: string | null } }).skill.source;
      if (manifest === undefined || source === null) return unreadableSkillMdProblem(parsed.name);
      const detail = (response.body as { skill: { enabled: boolean } }).skill;
      // ADR-0077 D3: a skill with a delete pending gets no new row, so it cannot be resurrected
      // or claimed by whoever reads it; with no row left it is already gone.
      const id = await syncSkillCatalogRow(
        store,
        catalog,
        {
          name: parsed.name,
          skillMd: source,
          enabled: detail.enabled,
          ownerPrincipalId: access.principal.ownerPrincipalId,
          createdBy: access.principal.userId,
        },
        {
          existing: await catalog.listSkills(),
          pendingDeletes: await pendingSkillDeleteNames(store),
        },
      );
      if (id === null) return problem(404, 'skill_not_found', 'No skill has that name.');
      return { ...response, body: { skill: { ...detail, id } } };
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
    async (store, catalog) => {
      // K-4: same refusal as GET — no catalog wired means no `id` can be produced for the
      // required field, so this refuses before the store is ever written to.
      if (catalog === null) {
        return problem(
          503,
          'skills_runtime_not_configured',
          'The skills catalog is not configured for this deployment; every skill needs a catalog ' +
            'id, and none can be produced without one.',
        );
      }
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      const patched = await patchSkill(store, parsed.name, body.value);
      if (patched.status !== 200) return patched;
      const exported = await exportSkill(store, parsed.name);
      const files =
        (exported.body as { skill?: { files?: Array<{ path: string; contentBase64: string }> } })
          .skill?.files ?? [];
      const manifest = files.find((file) => file.path === 'SKILL.md');
      // K-4: same refusal as `GET`, on both halves of the same residual — see its comments. This
      // patch's own writes are already applied when this is reached, exactly as `patchSkill`'s
      // `skill_md_removal_rejected` rollback leaves them; the refusal reports the row cannot be
      // answered with an id, it does not undo the edit.
      const source = (patched.body as { skill: { source: string | null } }).skill.source;
      if (manifest === undefined || source === null) return unreadableSkillMdProblem(parsed.name);
      const detail = (patched.body as { skill: { enabled: boolean } }).skill;
      const row = await catalog.putSkill({
        name: parsed.name,
        skillMd: source,
        enabled: detail.enabled,
        ownerPrincipalId: access.principal.ownerPrincipalId,
        createdBy: access.principal.userId,
      });
      return { ...patched, body: { skill: { ...detail, id: row.id } } };
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
    async (store, catalog) => {
      if (catalog === null) {
        return problem(
          503,
          'skills_runtime_not_configured',
          'The skills catalog is not configured for this deployment; a skill cannot be deleted ' +
            'without checking which agents it is assigned to.',
        );
      }
      return deleteSkill(store, catalog, parsed.name);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
