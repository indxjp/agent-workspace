/**
 * `/api/auth/cli-token` — issue #242 (SDK-10, S-22). ADR-0083.
 *
 * `POST` exchanges the device code for the user token once the person approved (RFC 8628 §3.4);
 * `DELETE` is `aw logout`, revoking the presented token server-side.
 */
import { exchangeDeviceCode, revokeCliToken } from '../../../../server/cli-auth/handlers';
import { toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return toResponse(await exchangeDeviceCode(request));
}

export async function DELETE(request: Request): Promise<Response> {
  return toResponse(await revokeCliToken(request));
}
