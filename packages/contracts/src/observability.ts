import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { RUN_STATUSES } from './runs.js';

/**
 * One finished run as `GET /api/metrics` reports it.
 *
 * This is the control plane's **operational** projection, not the durable run store: one web
 * process keeps the last thousand runs it observed finish, in memory, and serves the caller's own
 * workspace's share of them. It is not complete across instances and does not survive a restart;
 * `GET /api/runs` is the product surface. `status` is the terminal status the launcher wrote.
 * `costUsd` is the one money field the API renders as a JSON number rather than a decimal string
 * — it is the settled cost at the moment the run ended, or `null` when the store carried none.
 */
export const RunTelemetrySchema = z
  .object({
    runId: z.string().min(1),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    status: z.enum(RUN_STATUSES),
    durationMs: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nullable(),
  })
  .strict()
  .readonly();

export type RunTelemetry = z.infer<typeof RunTelemetrySchema>;

/** The body of `GET /api/metrics`: the projection, in the order the runs were last observed. */
export const RunTelemetryListResponseSchema = z
  .object({ runs: z.array(RunTelemetrySchema).readonly() })
  .strict()
  .readonly();

export type RunTelemetryListResponse = z.infer<typeof RunTelemetryListResponseSchema>;

/**
 * The control-plane actions the audit trail records, as the `audit_events.action` column
 * restates them. An action name is a name, not a reference: values for objects a deployment does
 * not hold are still valid, and a row's subject may no longer exist when the row is read.
 */
export const AUDIT_ACTIONS = [
  'user-created',
  'user-deleted',
  'agent-changed',
  'provider-credential-changed',
  'api-key-created',
  'api-key-revoked',
  'connector-changed',
  'permission-changed',
  'runtime-profile-changed',
  'project-created',
  'project-deleted',
  'project-archived',
  'project-restored',
  'session-published',
  'public-link-revoked',
  'runnable-link-stopped',
  'public-sharing-policy-changed',
  'invitation-created',
  'invitation-resent',
  'invitation-revoked',
  'invitation-accepted',
  'endpoint-client-created',
  'endpoint-client-changed',
  'endpoint-client-revoked',
  'endpoint-tool-called',
  'oauth-client-secret-rotated',
  'oauth-grant-issued',
  'oauth-grant-revoked',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * One audit row as every item of `GET /api/audit-events` renders it: who, what, to which thing,
 * when — and nothing more. There is no free-form metadata, by design: a request body on an audit
 * row is where a secret ends up.
 *
 * The labels are snapshots taken when the row was written, so a line still reads after the actor
 * or the subject is renamed or deleted. `actorPrincipalId` is `null` only for a non-workspace
 * service or system actor; `actorUserId` is the legacy human attribution and goes `null` when the
 * user is deleted. `subjectId` is `null` for an action with no one subject.
 */
export const AuditEventSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    actorUserId: z.string().nullable(),
    actorPrincipalId: z.string().nullable(),
    actorLabel: z.string().min(1),
    action: z.enum(AUDIT_ACTIONS),
    subjectId: z.string().nullable(),
    subjectLabel: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * The body of `GET /api/audit-events`: the newest rows first, at most `limit` of them, and an
 * opaque cursor for the next page (`null` on the last).
 */
export const AuditEventListResponseSchema = z
  .object({
    events: z.array(AuditEventSchema).readonly(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();

export type AuditEventListResponse = z.infer<typeof AuditEventListResponseSchema>;

/**
 * The bounds of `GET /api/audit-events?limit=`. The route refuses anything that is not an
 * integer from 1 to {@link AUDIT_LIST_MAX_LIMIT} as `400 invalid_limit`.
 */
export const AUDIT_LIST_DEFAULT_LIMIT = 100;
export const AUDIT_LIST_MAX_LIMIT = 500;

/**
 * The query `GET /api/audit-events` accepts. `cursor` is exactly the `nextCursor` of a previous
 * page, and is refused as `400 invalid_cursor` by any other list or workspace.
 */
export interface AuditListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}
