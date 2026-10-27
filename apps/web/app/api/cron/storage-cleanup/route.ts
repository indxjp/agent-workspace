/**
 * `GET /api/cron/storage-cleanup` — the storage cleanup pass on the Vercel target, called by Vercel
 * Cron and authenticated by `CRON_SECRET` alone. Inert (404) wherever `CRON_SECRET` is unset. The
 * composition root installs the pass; the logic is `server/storage/cleanup-cron.ts`.
 */
import { route } from '../../../../server/http/route';
import {
  getStorageCleanupCron,
  handleStorageCleanupCron,
} from '../../../../server/storage/cleanup-cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route({ component: 'storage', operation: 'cleanup-cron' }, (request: Request) =>
  handleStorageCleanupCron(request, getStorageCleanupCron()),
);
