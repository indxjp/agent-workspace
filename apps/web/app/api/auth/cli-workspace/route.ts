/**
 * `POST /api/auth/cli-workspace` — issue #242 (SDK-10, S-22): `aw workspaces select`, moving the
 * presented user token to another of the person's memberships. ADR-0083.
 */
import { switchCliWorkspace } from '../../../../server/cli-auth/handlers';
import { toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return toResponse(await switchCliWorkspace(request));
}
