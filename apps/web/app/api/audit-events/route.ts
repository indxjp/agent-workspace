/**
 * `GET /api/audit-events` — spec §36's audit trail.
 *
 * A thin adapter. The handler is `apps/web/server/audit/api.ts`, which goes through `authorise`
 * and is tested without a server.
 */
import { listAuditEvents } from '../../../server/audit/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return listAuditEvents(request);
}
