/**
 * What `/api/workspaces/:id/features` reads to reach persistence and the audit trail (ADR-0160
 * D6–D8). The composition root builds it once and installs it as
 * `ApplicationContext.workspaceFeatures`; with no context installed the route answers its own `503`.
 *
 * It is its own domain because the route acts on the workspace named in the *path*, which need not
 * be the session's: the repository is opened for that id, never for `principal.workspaceId`.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';

/** The two calls a workspace's switches need; `WorkspaceFeatureRepository` satisfies it. */
export interface WorkspaceFeatureStore {
  listDisabled(): Promise<readonly FeatureId[]>;
  /** Replace the off set; `before` is read inside the replace's own transaction, after its lock. */
  replaceDisabled(disabled: readonly FeatureId[]): Promise<{
    readonly before: readonly FeatureId[];
    readonly after: readonly FeatureId[];
  }>;
}

/** The one row {@link WorkspaceFeaturesRuntime.recordAuditEvent} is asked to write. */
export interface WorkspaceFeaturesAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string;
  readonly actorLabel: string;
  readonly action: 'workspace-features-changed';
  readonly subjectId: null;
  readonly subjectLabel: string;
}

export interface WorkspaceFeaturesRuntime {
  /** The features this deployment installs (`AW_DEPLOYMENT_FEATURES`), read once at start-up. */
  readonly deployment: readonly FeatureId[];
  /** The switches of `workspaceId`, or `null` when no workspace has that id. */
  repositoryFor(workspaceId: string): Promise<WorkspaceFeatureStore | null>;
  recordAuditEvent(event: WorkspaceFeaturesAuditEvent): Promise<void>;
  /** Ensure the Builder of `workspaceId`; never throws (a failure is logged, not raised). */
  provisionBuilder(workspaceId: string): Promise<void>;
}
