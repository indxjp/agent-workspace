/**
 * The audit trail's read side (`GET /api/audit-events`). The composition root builds it once and
 * installs it as `ApplicationContext.audit`; with no context installed `authorise` answers
 * `503 rbac_runtime_not_configured` first. Recording is not here: writers use
 * `root.recordAuditEvent`.
 */
import type {
  AuditEventRepositoryProvider,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';

export interface AuditRuntime {
  /** Resolves the scope of the workspace `authorise` has already verified the caller belongs to. */
  readonly scopes: Pick<WorkspaceScopeResolver, 'forWorkspaceId'>;
  readonly repositories: AuditEventRepositoryProvider;
}
