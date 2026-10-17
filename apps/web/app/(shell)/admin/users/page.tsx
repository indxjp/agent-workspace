import { TeamScreen } from '../../../../components/team/team-screen';
import { resolveTeamCapability } from '../../../../server/team/team-capability';

/**
 * `/admin/users` — the team management surface.
 *
 * Issue #185 replaced the previous `POST /api/users` form and name/address list with a members
 * table over `GET /api/memberships` and its landed `PATCH`/`DELETE`; issue #186 added the
 * invitations section over `/api/invitations`. Which controls this caller may use is decided for
 * both resources by the same `decide()` table and the same `conferRole` comparison those routes
 * themselves consult, evaluated here on the server and handed down as props — see
 * `server/team/invitation-capability.ts` and `server/team/membership-capability.ts` for why neither
 * is a probe and neither is a role table in the browser, and `server/team/team-capability.ts` for
 * why one session and directory resolution answers both. Nothing about either decision is re-made
 * below this line.
 */
export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const capability = await resolveTeamCapability();
  return (
    <TeamScreen capability={capability.membership} invitationCapability={capability.invitation} />
  );
}
