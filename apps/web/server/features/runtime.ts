/**
 * The per-workspace feature switches the composition root hands to the guard. Absence means every
 * feature is on (ADR-0160 D9), so an unwired process behaves as it did before features existed.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';

import { defineSlot } from '../runtime-slot';

export interface FeatureSwitches {
  /** The features on for `workspaceId`: installed in this deployment and not switched off by its Owner. */
  enabledFor(workspaceId: string): Promise<readonly FeatureId[]>;
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
