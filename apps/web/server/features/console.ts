/**
 * What the console shell and its feature pages read about the signed-in person's workspace
 * (ADR-0160 D8, issue #1497): who they are there, and which features that workspace has on.
 *
 * `resolveIdentity` re-reads the directory on every request rather than trusting the session token
 * (issue #118), so the shell layout and each feature page answer from the same lookup. It lives
 * here, not in the layout, so a page can ask it without importing a layout module.
 *
 * Every answer falls back to "all features on" when nothing could be read: no session, no RBAC
 * runtime, or no feature switches wired. That keeps an unwired process, and a project that never
 * switched anything off, exactly as it was before features existed (ADR-0160 D9).
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';

import { applicationContext } from '../application-context';
import { getSession, type VerifiedSessionClaims } from '../auth';
import { enabledFeaturesFor, installedFeatures } from './runtime';

/**
 * The database's user name, the workspace's id and name, and the person's role there, read fresh
 * on every request, never from the session token (issue #118: the token's `role` claim is `owner`
 * on every session this build mints).
 */
export interface ResolvedIdentity {
  readonly userName: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: string;
}

/**
 * `null` when the RBAC runtime is not wired, or when the membership this session named is gone (a
 * membership removed since the session was minted takes effect on the next request).
 */
export async function resolveIdentity(
  session: VerifiedSessionClaims,
): Promise<ResolvedIdentity | null> {
  const runtime = applicationContext()?.rbac ?? null;
  if (runtime === null) return null;
  const user = await runtime.directory.findUserByEmail(session.sub);
  if (user === null) return null;
  const memberships = await runtime.directory.membershipsForUser(user.id);
  const current = memberships.find((membership) => membership.workspaceSlug === session.ws);
  if (current === undefined) return null;
  return {
    userName: user.name,
    workspaceId: current.workspaceId,
    workspaceName: current.workspaceName,
    role: current.role,
  };
}

/**
 * The features the resolved workspace has on, or every feature when no workspace resolved. Takes
 * the identity the caller already resolved, so the layout does not look the person up twice.
 */
export async function currentWorkspaceFeatures(
  identity: ResolvedIdentity | null,
): Promise<readonly FeatureId[]> {
  return identity === null ? FEATURE_IDS : enabledFeaturesFor(identity.workspaceId);
}

/**
 * Whether a feature page may render, and, when it may not, what its switched-off panel says. A
 * feature this deployment does not install (`installed: false`) cannot be switched on by any Owner,
 * so that panel names the operator instead of the workspace's Settings.
 */
export type FeatureGate =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly installed: false }
  | {
      readonly enabled: false;
      readonly installed: true;
      readonly isOwner: boolean;
      readonly workspaceName: string;
    };

/** {@link featureGate} for a session already read. Exported for its test. */
export async function featureGateFor(
  session: VerifiedSessionClaims | null,
  feature: FeatureId,
): Promise<FeatureGate> {
  const identity = session === null ? null : await resolveIdentity(session);
  const features = await currentWorkspaceFeatures(identity);
  if (identity === null || features.includes(feature)) return { enabled: true };
  if (!installedFeatures().includes(feature)) return { enabled: false, installed: false };
  return {
    enabled: false,
    installed: true,
    isOwner: identity.role === 'owner',
    workspaceName: identity.workspaceName,
  };
}

/**
 * The gate a feature page asks first. An unresolved session renders the page as before: the shell
 * layout recovers or redirects that case, and the API refuses it on its own.
 */
export async function featureGate(feature: FeatureId): Promise<FeatureGate> {
  return featureGateFor(await getSession(), feature);
}
