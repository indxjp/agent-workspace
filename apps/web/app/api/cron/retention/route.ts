/**
 * `GET /api/cron/retention` — session retention on the Vercel target, called by Vercel Cron and
 * authenticated by `CRON_SECRET` alone (ADR-0120 clause 7). Inert (404) wherever `CRON_SECRET` is
 * unset. The logic is `server/sessions/retention-cron.ts`.
 */
import {
  getRetentionCronPass,
  handleRetentionCron,
} from '../../../../server/sessions/retention-cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleRetentionCron(request, { env: process.env, pass: getRetentionCronPass() });
}
