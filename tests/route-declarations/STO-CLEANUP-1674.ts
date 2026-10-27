/**
 * STO-CLEANUP-1674 · the storage cleanup on the Vercel target — issue #1674, the storage design §04.
 *
 * A function instance does not outlive a timer, so Vercel Cron calls this route instead of the
 * in-process hourly timer. Spec §34 prints no such route, so it carries a section 16 mandate; it is
 * excluded from the published API (`API_ROUTE_EXCLUSIONS`) because only the platform cron calls it.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/cron/storage-cleanup',
    owner: 'STO-CLEANUP-1674',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 stores file bytes in object storage, whose orphans and stale uploads the cleanup job removes; on a platform with no long-lived process the job is a cron call authenticated by CRON_SECRET.',
    },
  },
];
