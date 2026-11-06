/**
 * The per-workspace feature switches the composition root hands to the guard. Absence means every
 * feature is on (ADR-0160 D9), so an unwired process behaves as it did before features existed.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';

import { defineSlot } from '../runtime-slot';

export interface FeatureSwitches {
  /** The features on for `workspaceId`: installed in this deployment and not switched off by its Owner. */
  enabledFor(workspaceId: string): Promise<readonly FeatureId[]>;
  /**
   * The features this deployment installs (`AW_DEPLOYMENT_FEATURES`, ADR-0160 D5), the same set
   * `/api/workspaces/:id/features` reports as `installed`. Absent means every feature, as absence
   * of the switches does.
   */
  readonly deployment?: readonly FeatureId[];
}

const slot = defineSlot<FeatureSwitches>('__agentWorkspaceFeatureSwitches__');

export function configureFeatureSwitches(switches: FeatureSwitches): void {
  slot.set(switches);
}

export function clearFeatureSwitches(): void {
  slot.clear();
}

export async function enabledFeaturesFor(workspaceId: string): Promise<readonly FeatureId[]> {
  const switches = slot.current();
  return switches === null ? FEATURE_IDS : switches.enabledFor(workspaceId);
}

/** The features this deployment installs; every feature when no switches are wired. */
export function installedFeatures(): readonly FeatureId[] {
  return slot.current()?.deployment ?? FEATURE_IDS;
}
