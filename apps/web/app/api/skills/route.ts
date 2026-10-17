/**
 * `GET /api/skills` and `POST /api/skills` — spec §34 prints both verbatim, so neither needs a
 * `mandate` (ADR-0026 decision 2). The `:name`-addressed routes are in `[name]/route.ts` and
 * `[name]/export/route.ts`.
 *
 * Kept deliberately trivial, the same way `apps/web/app/api/files/route.ts` is: everything worth
 * testing lives in `apps/web/server/skills/`, importable by a test with no Next.js framework
 * involved. Imports are relative rather than `@/…` for the same reason that file gives — the `@/`
 * alias is a bundler setting Vitest does not resolve, so a test cannot import a route file that
 * uses it.
 */
import { importSkill, listSkills, problem } from '../../../server/skills/handlers';
import { readJsonBody, toResponse, withWorkspaceSkillsStore } from '../../../server/skills/http';
import { requireResourceAccess } from '../../../server/resources/authorise';
import { skillFilesPrefix, skillMetaKey } from '../../../server/skills/keys';
import {
  pendingSkillDeleteNames,
  syncSkillCatalogRow,
} from '../../../server/skills/pending-delete';
import { walkFiles } from '../../../server/skills/tree';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/skills` — every skill in the caller's workspace. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceSkillsStore(
    request,
    async (store, catalog) => {
      // K-4: every `SkillDetail` now carries a required `id`, and an id comes only from a catalog
      // row. A route with no catalog wired can no longer answer 200 without one — that would be
      // handing out a body the published contract says cannot exist. See `docs/sdk/
      // 04-api-specification.md` and this unit's implementation plan, Impact & risks.
      if (catalog === null) {
        return problem(
          503,
          'skills_runtime_not_configured',
          'The skills catalog is not configured for this deployment; every skill needs a catalog ' +
            'id, and none can be produced without one.',
        );
      }
      const listed = await listSkills(store);
      if (listed.status !== 200) return listed;
      // `listSkills` already returns each skill's SKILL.md text as `source` (see `SkillDetail`),
      // so the catalog row is upserted from what this response is carrying anyway. Exporting each
      // skill here instead — the first shape of this route — base64-encoded every byte of every
      // supporting file in the workspace on every list request, to recover one string already in
      // hand.
      // `source: string`, not `string | null`: `listSkills` already refused (above) the one case
      // that would have made it null, so every summary here has SKILL.md text to upsert.
      const body = listed.body as {
        skills: Array<{ name: string; enabled: boolean; source: string }>;
      };
      // Resolved once per request: `putSkill`'s `created_by` is stamped only on the first sync of
      // a name (issue #117 — its `onConflictDoUpdate` never touches the column again), so every
      // later sync of the same row passes this and it is simply ignored.
      //
      // K-4: `listSkills` itself now refuses (500 store_inconsistent) the moment any row has
      // `source === null`, so every summary reaching this map has SKILL.md text to upsert — the
      // `summary.source === null` branch this loop used to carry is unreachable and was removed.
      //
      // ADR-0077 D3: a skill with a delete pending gets no new row — a list must not resurrect a
      // half-deleted skill, nor hand it to the caller as owner — and one with no row left is left
      // out, since it is already gone.
      const syncContext = {
        existing: await catalog.listSkills(),
        pendingDeletes: await pendingSkillDeleteNames(store),
      };
      const synced = await Promise.all(
        body.skills.map(async (summary) => {
          const id = await syncSkillCatalogRow(
            store,
            catalog,
            {
              name: summary.name,
              skillMd: summary.source,
              enabled: summary.enabled,
              ownerPrincipalId: access.principal.ownerPrincipalId,
              createdBy: access.principal.userId,
            },
            syncContext,
          );
          return id === null ? null : { ...summary, id };
        }),
      );
      const skills = synced.filter((skill) => skill !== null);
      return { ...listed, body: { skills } };
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * `POST /api/skills` — create or import a skill. Body:
 * `{"name": "...", "files": [{"path": "SKILL.md", "contentBase64": "..."}, ...]}`.
 * See `apps/web/server/skills/handlers.ts`'s header for why this one route covers both spec §7
 * bullets "create a skill" and "import an existing Claude skill directory".
 */
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceSkillsStore(
    request,
    async (store, catalog) => {
      // K-4: as on GET, a route with no catalog wired cannot produce the `id` every `SkillDetail`
      // now requires, so it refuses before it ever writes the skill's bytes.
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
      const imported = await importSkill(store, body.value);
      if (imported.status !== 201) return imported;
      const raw = body.value as {
        name: string;
        files: Array<{ path: string; contentBase64: string }>;
      };
      const manifest = raw.files.find((file) => file.path === 'SKILL.md');
      if (manifest === undefined) return imported;
      try {
        const row = await catalog.putSkill({
          name: raw.name,
          skillMd: Buffer.from(manifest.contentBase64, 'base64').toString('utf8'),
          enabled: true,
          ownerPrincipalId: access.principal.ownerPrincipalId,
          createdBy: access.principal.userId,
        });
        return {
          ...imported,
          body: { skill: { ...(imported.body as { skill: object }).skill, id: row.id } },
        };
      } catch (error) {
        // Meta first: a crash part-way leaves invisible bytes, never a listed skill without SKILL.md.
        await store.delete(skillMetaKey(raw.name));
        for (const file of await walkFiles(store, skillFilesPrefix(raw.name)))
          await store.delete(file.key);
        throw error;
      }
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
