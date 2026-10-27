/**
 * `GET /api/cron/triggers` — the schedule pass on the Vercel and Cloudflare targets, called by their
 * cron and authenticated by `CRON_SECRET` alone (ADR-0144 D5). Inert (404) wherever `CRON_SECRET` is
 * unset. The composition root reads the secret; the logic is `server/triggers/schedule-cron.ts`.
 */
import {
  getTriggerScheduleCron,
  handleTriggerScheduleCron,
} from '../../../../server/triggers/schedule-cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleTriggerScheduleCron(request, getTriggerScheduleCron());
}
