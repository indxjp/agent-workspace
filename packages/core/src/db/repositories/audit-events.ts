import {
  AgentChangedAuditDetailsSchema,
  AgentCreatedAuditDetailsSchema,
} from '@indx-workspace/contracts/observability';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { auditEvents, type AuditAction, type NewAuditEvent } from '../schema/index.js';
import {
  afterPosition,
  assertPageLimit,
  keysetTimestamp,
  toKeysetPage,
  type KeysetPage,
  type KeysetPosition,
} from './keyset.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/** The default and largest page {@link AuditEventRepository.list} serves. */
const DEFAULT_AUDIT_PAGE = 100;
const MAX_AUDIT_PAGE = 500;

type AuditEventRow = typeof auditEvents.$inferSelect;

interface AuditEventListInput {
  /** Rows per page, 1–500; 100 when omitted. */
  readonly limit?: number;
  /** The previous page's `nextCursor`; omitted or `null` for the newest rows. */
  readonly cursor?: KeysetPosition | null;
  /** Only rows of this action; omitted for every action. */
  readonly action?: AuditAction;
}

/**
 * The one check every audit write passes before its insert: `details` belongs to `agent-created`
 * and `agent-changed` alone and must satisfy that action's strict contracts schema. Returns the
 * event with the parsed details.
 */
export function checkedAuditEvent<T extends { action: AuditAction; details?: unknown }>(
  event: T,
): T {
  if (event.details === undefined || event.details === null) return event;
  if (event.action === 'agent-created') {
    const parsed = AgentCreatedAuditDetailsSchema.safeParse(event.details);
    if (!parsed.success) throw new Error('The audit row details are not AgentCreatedAuditDetails.');
    return { ...event, details: parsed.data };
  }
  if (event.action === 'agent-changed') {
    const parsed = AgentChangedAuditDetailsSchema.safeParse(event.details);
    if (!parsed.success) throw new Error('The audit row details are not AgentChangedAuditDetails.');
    return { ...event, details: parsed.data };
  }
  throw new Error(`An '${event.action}' audit row cannot carry details.`);
}

type AuditEventWrite = Omit<NewAuditEvent, 'workspaceId' | 'actorPrincipalId' | 'actorUserId'> & {
  /** Exact workspace actor, or null only for an explicitly non-workspace service/system event. */
  readonly actorPrincipalId: string | null;
  /** Compatibility attribution for membership principals only. */
  readonly actorUserId?: string | null;
};

export interface AuditEventRepository {
  write(event: AuditEventWrite): Promise<void>;
  count(action?: AuditAction): Promise<number>;
  /** One page of the trail, newest first by `(created_at, id)`. */
  list(input?: AuditEventListInput): Promise<KeysetPage<AuditEventRow>>;
}
export interface AuditEventRepositoryProvider {
  forScope(scope: WorkspaceScope): AuditEventRepository;
}
export function createDatabaseAuditEventRepositoryProvider(
  db: Database,
): AuditEventRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'AuditEventRepositoryProvider');
      return {
        async write(event) {
          await db.insert(auditEvents).values({ ...checkedAuditEvent(event), workspaceId });
        },
        async count(action) {
          const where = action
            ? and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, action))
            : eq(auditEvents.workspaceId, workspaceId);
          return Number(
            (await db.select({ value: count() }).from(auditEvents).where(where))[0]?.value ?? 0,
          );
        },
        async list(input = {}) {
          const limit = input.limit ?? DEFAULT_AUDIT_PAGE;
          assertPageLimit(limit, MAX_AUDIT_PAGE, 'audit event list');
          const predicates: SQL[] = [eq(auditEvents.workspaceId, workspaceId)];
          if (input.action !== undefined) predicates.push(eq(auditEvents.action, input.action));
          if (input.cursor !== undefined && input.cursor !== null) {
            predicates.push(afterPosition(auditEvents.createdAt, auditEvents.id, input.cursor));
          }
          const rows = await db
            .select({ event: auditEvents, cursorAt: keysetTimestamp(auditEvents.createdAt) })
            .from(auditEvents)
            .where(and(...predicates))
            .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
            .limit(limit + 1);
          return toKeysetPage(rows, limit, (row) => row.event);
        },
      };
    },
  };
}
