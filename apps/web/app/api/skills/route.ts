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
import { SKILL_IMPORT_JSON_DEPRECATED_AT_SECONDS } from '@indx-workspace/contracts/skills';

import { readJsonBody, toResponse, withWorkspaceSkillsStore } from '../../../server/skills/http';
import { isMultipartContentType, openMultipartImport } from '../../../server/skills/multipart';
import { requireResourceAccess } from '../../../server/resources/authorise';
import { problem } from '../../../server/skills/result';
import {
  catalogNotConfigured,
  importSkillMultipartWithId,
  importSkillWithId,
  listSkillsWithIds,
} from '../../../server/skills/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/skills` — every skill in the caller's workspace. */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceSkillsStore(
    request,
    async (store, catalog, rows) => {
      if (catalog === null) return catalogNotConfigured();
      return listSkillsWithIds(store, catalog, access.principal, rows);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * `POST /api/skills` — create or import a skill, as `multipart/form-data` (a `name` field, then
 * `SKILL.md`, then one `file` part per other file, its filename the path), streamed with no base64.
 * The JSON body `{"name": "...", "files": [{"path": "SKILL.md", "contentBase64": "..."}, ...]}` is
 * still accepted, with an RFC 9745 `Deprecation: @<epoch seconds>` header.
 * See `apps/web/server/skills/handlers.ts`'s header for why this one route covers both spec §7
 * bullets "create a skill" and "import an existing Claude skill directory".
 */
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  let deprecated = false;
  const result = await withWorkspaceSkillsStore(
    request,
    async (store, catalog, rows) => {
      // K-4: as on GET, a route with no catalog wired cannot produce the `id` every `SkillDetail`
      // now requires, so it refuses before it ever writes the skill's bytes.
      if (catalog === null) return catalogNotConfigured();
      if (isMultipartContentType(request.headers.get('content-type'))) {
        const opened = openMultipartImport(request);
        if (!opened.ok) return opened.result;
        return importSkillMultipartWithId(store, catalog, access.principal, opened.reader, rows);
      }
      // Answered here so `readJsonBody`'s JSON-only 415 stays right for the other skills routes.
      const contentType = request.headers.get('content-type');
      if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
        return problem(
          415,
          'unsupported_media_type',
          'This route accepts multipart/form-data or application/json.',
        );
      }
      // storage-bridge(#1700): the JSON + base64 import is deprecated; it is removed in the next major
      // release (#1944: removals deferred to the next major release).
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      deprecated = true;
      return importSkillWithId(store, catalog, access.principal, body.value, rows);
    },
    access.principal.workspaceId,
  );
  const response = toResponse(result);
  if (deprecated)
    response.headers.set('deprecation', `@${String(SKILL_IMPORT_JSON_DEPRECATED_AT_SECONDS)}`);
  return response;
}
