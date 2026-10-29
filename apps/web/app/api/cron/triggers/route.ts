/**
 * `GET /api/cron/triggers` — the schedule pass on the Vercel and Cloudflare targets, called by their
 * cron and authenticated by `CRON_SECRET` alone (ADR-0144 D5). Inert (404) wherever `CRON_SECRET` is
 * unset. The composition root reads the secret; the logic is `server/triggers/schedule-cron.ts`.
 * Each delivery also offers the agent auto-archive sweep (issue #1851), which runs at most once an
 * hour and is reported as `archive`.
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
