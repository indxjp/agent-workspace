/**
 * The team screen's two capabilities, resolved together for one request — issue #186.
 *
 * `/admin/users` gates two resources with two different §21 grants: `memberships` (#185's members
 * table) and `invitations` (#186's invitations section). The grants stay with their resource in
 * `./membership-capability.ts` and `./invitation-capability.ts`; what is here is the composition —
 * the RBAC runtime, the session, and the single `./team-viewer.ts` resolution both of them are
 * derived from.
 *
 * Resolving the viewer once is the whole reason this module exists. Two independent resolvers would
 * issue `findUserByEmail` and `membershipsForUser` twice per render of the same page for an answer
 * that cannot differ between them, and a second answer that *could* differ — because it was read a
 * moment later — would be worse than the cost.
 *
 * The two capabilities are separate values rather than one flattened object on purpose: they
 * describe different resources, and a single contract answering for both would let a change to §21's
 * `memberships` clause silently move an invitation control.
 */
import { NO_INVITATION_CAPABILITY, type InvitationCapability } from '../../contracts/invitations';
import { NO_MEMBERSHIP_CAPABILITY, type MembershipCapability } from '../../contracts/team';
import { getSession } from '../auth';
import { currentRbacRuntime } from '../rbac/runtime';
import { invitationCapabilityForViewer } from './invitation-capability';
import { membershipCapabilityForViewer } from './membership-capability';
import { resolveTeamViewer, type TeamViewerDirectory, type TeamViewerSession } from './team-viewer';

/** What `/admin/users` may show this caller, one value per resource it gates. */
export interface TeamCapability {
  readonly membership: MembershipCapability;
  readonly invitation: InvitationCapability;
}

/** The answer for a caller nothing could be established about. Both halves deny. */
export const NO_TEAM_CAPABILITY: TeamCapability = {
  membership: NO_MEMBERSHIP_CAPABILITY,
  invitation: NO_INVITATION_CAPABILITY,
};

/**
 * Resolve both capabilities from a verified session against a directory.
 *
 * The directory and the session are parameters rather than lookups so the role matrix is testable
 * without a session cookie, which `next/headers` will not produce outside a real request.
 */
export async function teamCapabilityFor(
  directory: TeamViewerDirectory,
  session: TeamViewerSession,
): Promise<TeamCapability> {
  const viewer = await resolveTeamViewer(directory, session);
  return {
    membership: membershipCapabilityForViewer(viewer),
    invitation: invitationCapabilityForViewer(viewer),
  };
}

/**
 * The signed-in caller's team capability for the current request.
 *
 * The RBAC runtime is checked before the session deliberately: an unwired runtime is this
 * application's declared fail-closed state (`rbac/runtime.ts`), it is the cheaper question, and
 * asking it first means the answer for an unconfigured deployment does not depend on `next/headers`
 * having a request to read.
 */
export async function resolveTeamCapability(): Promise<TeamCapability> {
  const runtime = currentRbacRuntime();
  if (runtime === null) return NO_TEAM_CAPABILITY;
  const session = await getSession();
  if (session === null) return NO_TEAM_CAPABILITY;
  return teamCapabilityFor(runtime.directory, session);
}
