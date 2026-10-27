/**
 * `GET /api/cron/retention` — session retention on the Vercel target, called by Vercel Cron and
 * authenticated by `CRON_SECRET` alone (ADR-0120 clause 7). Inert (404) wherever `CRON_SECRET` is
 * unset. The logic is `server/sessions/retention-cron.ts`.
 */
import { applicationContext } from '../../../../server/application-context';
import { handleRetentionCron } from '../../../../server/sessions/retention-cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  const retention = applicationContext()?.sessions.retention;
  const pass = retention?.kind === 'cron' ? retention.pass : null;
  return handleRetentionCron(request, { env: process.env, pass });
}
