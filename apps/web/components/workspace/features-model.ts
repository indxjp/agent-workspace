/**
 * What each row of the Features card says and allows (ADR-0160 D3, D6, D8; issue #1497), computed
 * from the `GET /api/workspaces/:id/features` answer alone, so the card offers only the changes the
 * server would accept.
 *
 * - A feature this deployment does not install is off and cannot be switched on.
 * - A feature that is on cannot be switched off while an enabled feature needs it (the server's
 *   `409 feature_in_use`).
 * - A feature that is off cannot be switched on while a feature it needs is off.
 */
import {
  FEATURE_DEPENDENCIES,
  FEATURE_IDS,
  type FeatureId,
  type WorkspaceFeatures,
} from '@indx-workspace/contracts/features';

import { NAVIGATION } from '../shell/navigation';

type Dependencies = Readonly<Partial<Record<FeatureId, readonly FeatureId[]>>>;

/** Why a row's toggle is disabled, or `null` when it may be changed. */
export type FeatureRowReason =
  | { readonly kind: 'not_installed' }
  | { readonly kind: 'needed_by'; readonly features: readonly FeatureId[] }
  | { readonly kind: 'needs'; readonly features: readonly FeatureId[] };

export interface FeatureRow {
  readonly id: FeatureId;
  readonly installed: boolean;
  readonly enabled: boolean;
  /** The features this one needs switched on, in `FEATURE_IDS` order. */
  readonly needs: readonly FeatureId[];
  /** The features that need this one, sorted by id, whether on or off. */
  readonly neededBy: readonly FeatureId[];
  readonly canToggle: boolean;
  readonly reason: FeatureRowReason | null;
}

function dependentsAmong(
  id: FeatureId,
  among: readonly FeatureId[],
  deps: Dependencies,
): readonly FeatureId[] {
  return among.filter((feature) => (deps[feature] ?? []).includes(id)).sort();
}

function reasonFor(
  row: WorkspaceFeatures['features'][number],
  needs: readonly FeatureId[],
  enabledIds: readonly FeatureId[],
  deps: Dependencies,
): FeatureRowReason | null {
  if (!row.installed) return { kind: 'not_installed' };
  if (row.enabled) {
    const stranded = dependentsAmong(row.id, enabledIds, deps);
    return stranded.length > 0 ? { kind: 'needed_by', features: stranded } : null;
  }
  const missing = needs.filter((need) => !enabledIds.includes(need));
  return missing.length > 0 ? { kind: 'needs', features: missing } : null;
}

/** One row per feature, in the order the server listed them. */
export function rowsFor(
  state: WorkspaceFeatures,
  deps: Dependencies = FEATURE_DEPENDENCIES,
): readonly FeatureRow[] {
  const enabledIds = state.features.filter((row) => row.enabled).map((row) => row.id);
  return state.features.map((row) => {
    const needs = FEATURE_IDS.filter((id) => (deps[row.id] ?? []).includes(id));
    const reason = reasonFor(row, needs, enabledIds, deps);
    return {
      id: row.id,
      installed: row.installed,
      enabled: row.installed && row.enabled,
      needs,
      neededBy: dependentsAmong(row.id, FEATURE_IDS, deps),
      canToggle: reason === null,
      reason,
    };
  });
}

/**
 * The off set after switching `id` to `on`: the whole set `PUT` replaces (ADR-0160 D6). A feature
 * the deployment does not install is never enabled, so it stays in the set, as the server requires.
 */
export function disabledAfter(
  state: WorkspaceFeatures,
  id: FeatureId,
  on: boolean,
): readonly FeatureId[] {
  return state.features.filter((row) => (row.id === id ? !on : !row.enabled)).map((row) => row.id);
}

/** The ids of the §44 navigation entries that switching `id` off hides, in §44's order. */
export function navEntriesHiddenBy(id: FeatureId): readonly string[] {
  return navItemsHiddenBy(id).map((item) => item.id);
}

/** The §44 labels of those entries, as the sidebar prints them. */
export function navLabelsHiddenBy(id: FeatureId): readonly string[] {
  return navItemsHiddenBy(id).map((item) => item.label);
}

function navItemsHiddenBy(id: FeatureId) {
  return NAVIGATION.flatMap((group) => group.items).filter((item) => item.feature === id);
}
