/**
 * `POST /api/auth/cli-device` — issue #242 (SDK-10, S-22): start `aw login`'s device
 * authorization grant (RFC 8628 §3.1). Pre-authentication, writes nothing, and is rate-limited per
 * client. ADR-0083.
 */
import { startDeviceAuthorization } from '../../../../server/cli-auth/handlers';
import { toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Response {
  return toResponse(startDeviceAuthorization(request));
}
