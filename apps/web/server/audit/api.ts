/**
 * `GET /api/audit-events` — the workspace's audit trail, newest first.
 *
 * The route goes through `authorise` like every other `/api/**` route, so `decide()` answers the
 * role question (`audit-events` carries no role override: Owner is allowed by the `EVERYTHING`
 * fallback, every other role is denied, see ADR-0075) and every refusal renders the standard
 * `{ error: { code, message } }` envelope. The workspace is the one `authorise` verified; nothing
 * about it is read from the request — a `cursor` minted for another workspace is refused, not
 * followed (S-5, ADR-0079).
 */
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
} from '@indx-workspace/contracts/observability';

import { encodeListCursor, readListCursor } from '../pagination/list-cursor';
import { authorise, problem, toResponse, type ApiResult } from '../rbac/http';
import { currentAuditRuntime } from './runtime';

function parseLimit(raw: string | null): number | null {
  if (raw === null) return AUDIT_LIST_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_LIST_MAX_LIMIT) return null;
  return limit;
}

export async function listAuditEvents(request: Request): Promise<Response> {
  const result = await authorise(
    request,
    'not-applicable',
    async ({ principal }): Promise<ApiResult> => {
      const configured = currentAuditRuntime();
      if (configured === null) {
        return problem(
          503,
          'audit_runtime_not_configured',
          'This deployment has no audit repository wired into it, so the audit trail cannot be read.',
        );
      }
      const params = new URL(request.url).searchParams;
      const limit = parseLimit(params.get('limit'));
      if (limit === null) {
        return problem(
          400,
          'invalid_limit',
          `limit must be an integer from 1 to ${String(AUDIT_LIST_MAX_LIMIT)}.`,
        );
      }
      const cursor = readListCursor(params.get('cursor'), 'audit-events', principal.workspaceId);
      if (cursor.kind === 'invalid') return problem(400, 'invalid_cursor', cursor.reason);
      const scope = await configured.scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        return problem(403, 'forbidden', 'The workspace this credential names no longer exists.');
      }
      const page = await configured.repositories.forScope(scope).list({
        limit,
        cursor: cursor.kind === 'ok' ? cursor.position : null,
      });
      return {
        status: 200,
        body: {
          events: page.items,
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeListCursor('audit-events', principal.workspaceId, page.nextCursor),
        },
      };
    },
  );
  return toResponse(result);
}
