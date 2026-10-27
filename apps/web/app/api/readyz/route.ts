/**
 * `GET /api/readyz` — the readiness probe the Helm chart points at. Unauthenticated, exempt from
 * the proxy's session gate; the logic is `server/readiness.ts`.
 */
import { applicationContext } from '../../../server/application-context';
import { readiness } from '../../../server/readiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return readiness(applicationContext());
}
