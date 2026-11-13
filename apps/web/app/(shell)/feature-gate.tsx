/**
 * The first thing each feature page asks (ADR-0160 D8, issue #1497): is its feature on for this
 * workspace? When it is not, the page renders the switched-off panel in the request's language in
 * place of its screen, so a deep link explains instead of ending in a bare 404. The API routes
 * refuse the same feature on their own (`404 feature_disabled`), so nothing leaks through the
 * screen's own requests either.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';
import { headers } from 'next/headers';
import type { ReactElement } from 'react';

import { versionsLocaleOf } from '../../components/agents/versions-messages';
import { FeatureSwitchedOff } from '../../components/shell/feature-off';
import { featureGate } from '../../server/features/console';

/** The switched-off panel when `feature` is off for the caller's workspace; `null` otherwise. */
export async function switchedOffPanel(feature: FeatureId): Promise<ReactElement | null> {
  const gate = await featureGate(feature);
  if (gate.enabled) return null;
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return <FeatureSwitchedOff feature={feature} cause={gate} locale={locale} />;
}
