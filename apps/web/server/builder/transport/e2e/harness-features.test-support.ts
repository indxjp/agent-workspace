import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { workspaceFeatureSwitches } from '../../../composition/feature-switches';
import { configureFeatureSwitches } from '../../../features/runtime';
import type { WorkspaceFeatureStore } from '../../../identity';
import type { AuditDeps } from '../../adapters/audit/store';

export function createHarnessFeatures(scopes: AuditDeps['scopes']) {
  let disabledFeatures: readonly FeatureId[] = [];
  const workspaceFeatures: WorkspaceFeatureStore = {
    listDisabled: () => Promise.resolve(disabledFeatures),
    replaceDisabled(next) {
      const before = disabledFeatures;
      disabledFeatures = FEATURE_IDS.filter((id) => next.includes(id));
      return Promise.resolve({ before, after: disabledFeatures });
    },
  };
  configureFeatureSwitches(
    workspaceFeatureSwitches(
      { scopes, workspaceFeatures: { forScope: () => workspaceFeatures } },
      FEATURE_IDS,
    ),
  );

  return workspaceFeatures;
}
