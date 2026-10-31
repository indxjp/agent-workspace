import { z } from 'zod';

import { AgentVersionViaSchema } from './agent-versions.js';
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
 * restates them (its CHECK is derived from this list). An action name is a name, not a
 * reference: values for objects a deployment does not hold are still valid, and a row's subject
 * may no longer exist when the row is read.
 *
 * Spec §36's list of "important control-plane actions" comes first, verbatim and in §36's order,
 * each phrase as a slug. Five of them name objects no table in the first wave held (runtime
 * profiles, projects and shares); they are here because §36 lists them. The `invitation-*`,
 * `project-archived` and `project-restored` values postdate §36: nothing is deleted by an archive
 * or a restore, so neither folds into `project-deleted`. The column is a `CHECK`, not a native
 * `pgEnum`, so adding a value is a one-line `ALTER` rather than a migration with lock implications.
 */
export const AUDIT_ACTIONS = [
  'user-created',
  'user-deleted',
  'agent-changed',
  // Issue #1847: a new agent saved by the Builder. Its row names the person, never the Builder.
  'agent-created',
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
  // ADR-0134: the lifecycle of an endpoint client, and a call made through one.
  'endpoint-client-created',
  'endpoint-client-changed',
  'endpoint-client-revoked',
  'endpoint-tool-called',
  // ADR-0134 part 3: the OAuth server's client secret and grant lifecycle.
  'oauth-client-secret-rotated',
  'oauth-grant-issued',
  'oauth-grant-revoked',
  // The storage design, §05: who did what to a file. The URL of a signed link is never a field of a row.
  'file-uploaded',
  'file-downloaded',
  'file-link-created',
  'file-moved',
  'file-deleted',
  // The storage design, §05: a connected bucket's lifecycle, and the grants of an agent onto one.
  'storage-connection-created',
  'storage-connection-updated',
  'storage-connection-deleted',
  'storage-connection-credential-changed',
  'storage-connection-tested',
  'storage-connection-written',
  'storage-grant-changed',
  // ADR-0160 D8: one row per PUT of a workspace's feature switches.
  'workspace-features-changed',
  // ADR-0161 D11: one row per exchange of a person's ID token at an app-backend endpoint client.
  'user-token-exchanged',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * What an `agent-created` row names (issue #1847), stored in `audit_events.details`, which only an
 * `agent-created` or `agent-changed` row may carry. `createdByAgentId` is for issue #1851 and is
 * unused here.
 */
export const AgentCreatedAuditDetailsSchema = z
  .object({
    agentId: z.string().min(1),
    version: z.number().int().positive(),
    via: AgentVersionViaSchema,
    builderRunId: z.string().min(1).optional(),
    createdByAgentId: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

export type AgentCreatedAuditDetails = z.infer<typeof AgentCreatedAuditDetailsSchema>;

/**
 * What an `agent-changed` row may carry in `audit_events.details`: the auto-archive sweep marks the
 * row that archived an agent with `archived: true`, and a restore marks its row `archived: false`
 * (issue #1851). A pointer move or a runtime switch writes the same action with no details.
 */
export const AgentChangedAuditDetailsSchema = z
  .object({ archived: z.boolean() })
  .strict()
  .readonly();

export type AgentChangedAuditDetails = z.infer<typeof AgentChangedAuditDetailsSchema>;

/**
 * One audit row as every item of `GET /api/audit-events` renders it: who, what, to which thing,
 * when — and nothing more. There is no free-form metadata, by design: a request body on an audit
 * row is where a secret ends up.
 *
 * The labels are snapshots taken when the row was written, so a line still reads after the actor
 * or the subject is renamed or deleted. `actorPrincipalId` is `null` only for a non-workspace
 * service or system actor; `actorUserId` is the legacy human attribution and goes `null` when the
 * user is deleted. `subjectId` is `null` for an action with no one subject.
 *
 * `builderRunId` names the Builder run that created the agent. It is present only on an
 * `agent-created` row whose stored details carry it, never on any other action.
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
    builderRunId: z.string().min(1).optional(),
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
  /**
   * Only rows of this one action (single value; a value outside {@link AUDIT_ACTIONS} is refused
   * as `400 invalid_action`). Paging keeps the same order and cursor with the filter on.
   */
  readonly action?: AuditAction;
}
