/**
 * E5-VERCEL-CRON-830 · session retention on the Vercel target — issue #830, ADR-0120 clause 7.
 *
 * A function instance does not outlive a timer, so Vercel Cron calls this route instead of the
 * in-process interval. Spec §34 prints no such route, so it carries a section 20 mandate; it is excluded from
 * the published API (`API_ROUTE_EXCLUSIONS`) because only Vercel Cron calls it.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/cron/retention',
    owner: 'E5-VERCEL-CRON-830',
    landed: true,
    mandate: {
      section: '20',
      because:
        'The durable session store of section 20 is purged under the retention policy; on a platform with no long-lived process the scheduler is a cron call.',
    },
  },
];
