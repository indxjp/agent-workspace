/**
 * The features this deployment installs (ADR-0160 D5): `AW_DEPLOYMENT_FEATURES`, a comma-separated
 * list of feature ids, parsed with the one `FeatureListSchema` the project file uses. Unset or blank
 * means every feature. An invalid value throws, so start-up stops rather than serve a set the
 * operator did not ask for; the message names the issues, never the value.
 */
import { FEATURE_IDS, FeatureListSchema, type FeatureId } from '@indx-workspace/contracts/features';

export const DEPLOYMENT_FEATURES_ENV = 'AW_DEPLOYMENT_FEATURES';

export function readDeploymentFeatures(
  env: Readonly<Record<string, string | undefined>>,
): readonly FeatureId[] {
  const raw = env[DEPLOYMENT_FEATURES_ENV]?.trim();
  if (raw === undefined || raw === '') return FEATURE_IDS;
  const parsed = FeatureListSchema.safeParse(raw.split(',').map((id) => id.trim()));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`${DEPLOYMENT_FEATURES_ENV} is invalid: ${issues.join('; ')}`);
}
