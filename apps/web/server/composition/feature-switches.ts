/**
 * The per-workspace feature switches the composition root installs (ADR-0160 D6): a
 * `workspace_features` row means off, and an unknown workspace has nothing enabled.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';

import type { FeatureSwitches } from '../features/runtime';
import type {
  WorkspaceFeatureStore,
  WorkspaceFeaturesAuditEvent,
  WorkspaceFeaturesRuntime,
} from '../workspaces/features-runtime';

/** The two database reads the switches need; the composition root passes its `DatabaseRoot`. */
interface FeatureSwitchRows<Scope> {
  readonly scopes: { forWorkspaceId(workspaceId: string): Promise<Scope | null> };
  readonly workspaceFeatures: {
    forScope(scope: Scope): { listDisabled(): Promise<readonly FeatureId[]> };
  };
}

/** What the features route needs of the root: the rows it may also write, and the audit sink. */
interface WorkspaceFeaturesRows<Scope> {
  readonly scopes: FeatureSwitchRows<Scope>['scopes'];
  readonly workspaceFeatures: { forScope(scope: Scope): WorkspaceFeatureStore };
  recordAuditEvent(event: WorkspaceFeaturesAuditEvent): Promise<void>;
}

export function workspaceFeatureSwitches<Scope>(
  rows: FeatureSwitchRows<Scope>,
  deploymentFeatures: readonly FeatureId[],
): FeatureSwitches {
  return {
    enabledFor: async (workspaceId) => {
      const scope = await rows.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return [];
      const off = await rows.workspaceFeatures.forScope(scope).listDisabled();
      return deploymentFeatures.filter((feature) => !off.includes(feature));
    },
  };
}

/** `/api/workspaces/:id/features`: the same rows, opened for the workspace the path names. */
export function workspaceFeaturesRuntime<Scope>(
  root: WorkspaceFeaturesRows<Scope>,
  deploymentFeatures: readonly FeatureId[],
  provisionBuilder: WorkspaceFeaturesRuntime['provisionBuilder'],
): WorkspaceFeaturesRuntime {
  return {
    provisionBuilder,
    deployment: deploymentFeatures,
    repositoryFor: async (workspaceId) => {
      const scope = await root.scopes.forWorkspaceId(workspaceId);
      return scope === null ? null : root.workspaceFeatures.forScope(scope);
    },
    recordAuditEvent: (event) => root.recordAuditEvent(event),
  };
}
