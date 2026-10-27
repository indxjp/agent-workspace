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
  AUDIT_ACTIONS,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AgentCreatedAuditDetailsSchema,
  type AuditEvent,
} from '@indx-workspace/contracts/observability';

import { encodeListCursor, readListCursor } from '../pagination/list-cursor';
import {
  noStoreResultResponse,
  problemWithDetail as problem,
  type ApiResult,
} from '../http/result';
import { authorise } from '../rbac/http';

/** A stored row as the repository returns it; `details` stays `unknown` until parsed. */
type AuditEventRow = Omit<AuditEvent, 'createdAt' | 'builderRunId'> & {
  readonly createdAt: Date;
  readonly details: unknown;
};

function parseLimit(raw: string | null): number | null {
  if (raw === null) return AUDIT_LIST_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_LIST_MAX_LIMIT) return null;
  return limit;
}

/**
 * An explicit projection: `AuditEventSchema` is strict, and `details` is not public. The one thing
 * read from it is the Builder run of an `agent-created` row, from its strictly parsed details.
 */
function toAuditEvent(row: AuditEventRow) {
  const details =
    row.action === 'agent-created' ? AgentCreatedAuditDetailsSchema.safeParse(row.details) : null;
  const builderRunId = details?.success === true ? details.data.builderRunId : undefined;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    actorPrincipalId: row.actorPrincipalId,
    actorLabel: row.actorLabel,
    action: row.action,
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    createdAt: row.createdAt,
    ...(builderRunId === undefined ? {} : { builderRunId }),
  };
}

export async function listAuditEvents(request: Request): Promise<Response> {
  const result = await authorise(
    request,
    'not-applicable',
    async ({ principal, application }): Promise<ApiResult> => {
      const configured = application.audit;
      const params = new URL(request.url).searchParams;
      const limit = parseLimit(params.get('limit'));
      if (limit === null) {
        return problem(
          400,
          'invalid_limit',
          `limit must be an integer from 1 to ${String(AUDIT_LIST_MAX_LIMIT)}.`,
        );
      }
      const rawAction = params.get('action');
      const action = AUDIT_ACTIONS.find((candidate) => candidate === rawAction);
      if (rawAction !== null && action === undefined) {
        return problem(
          400,
          'invalid_action',
          `action must be one of: ${AUDIT_ACTIONS.join(', ')}.`,
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
        ...(action === undefined ? {} : { action }),
        cursor: cursor.kind === 'ok' ? cursor.position : null,
      });
      return {
        status: 200,
        body: {
          events: page.items.map(toAuditEvent),
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeListCursor('audit-events', principal.workspaceId, page.nextCursor),
        },
      };
    },
  );
  return noStoreResultResponse(result);
}
