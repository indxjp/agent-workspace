/**
 * The workspace-level refusal of ADR-0160 D7: a route whose feature is switched off answers
 * `404 feature_disabled`, in the ADR-0078 envelope `authorise()` answers with. Call it once the
 * route's own credential has verified, before any row is read; the workspace is the one that
 * credential is bound to, never one named by a path segment.
 */
import {
  FEATURE_PROBLEM_CODES,
  type FeatureId,
  type FeatureProblemCode,
} from '@indx-workspace/contracts/features';

import { noStoreResultResponse, problemBody, type ApiResult } from '../http/result';
import { enabledFeaturesFor } from './runtime';
import { routeFeatureOf } from './route-feature';

const FEATURE_DISABLED = 'feature_disabled' satisfies FeatureProblemCode;

/** The refusal when `method` on `pathname` belongs to a feature not in `enabled`; `null` otherwise. */
export function featureRefusal(
  method: string,
  pathname: string,
  enabled: readonly FeatureId[],
): ApiResult | null {
  const feature = routeFeatureOf(method, pathname);
  if (feature === null || feature === 'core' || enabled.includes(feature)) return null;
  const message = `The ${feature} feature is switched off for this workspace. A workspace Owner can switch it on in Settings.`;
  return {
    status: FEATURE_PROBLEM_CODES[FEATURE_DISABLED],
    body: {
      error: { ...problemBody(FEATURE_DISABLED, message, [feature]).error, detail: message },
    },
  };
}

/**
 * {@link featureRefusal} for the request's own method and path, reading the workspace's switches
 * only when the route belongs to a feature. An unreadable URL is not refused here: the caller keeps
 * its own answer for it.
 */
export async function refuseIfFeatureDisabled(
  request: Request,
  workspaceId: string,
): Promise<ApiResult | null> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const feature = routeFeatureOf(request.method, pathname);
  if (feature === null || feature === 'core') return null;
  return featureRefusal(request.method, pathname, await enabledFeaturesFor(workspaceId));
}

/** {@link refuseIfFeatureDisabled} rendered as the no-store `Response` the run, session and door handlers return. */
export async function featureRefusalResponse(
  request: Request,
  workspaceId: string,
): Promise<Response | null> {
  const refused = await refuseIfFeatureDisabled(request, workspaceId);
  return refused === null ? null : noStoreResultResponse(refused);
}
