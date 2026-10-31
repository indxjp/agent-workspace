import { Suspense } from 'react';

import { RunsHistoryScreen } from '../../../components/run/history-screen';
import { switchedOffPanel } from '../feature-gate';

/**
 * `/runs` — durable run history and usage/cost detail (issue #136, the Wave 9 plan
 * `W9-UI-136`). The screen itself is `RunsHistoryScreen`; this file is the seam Next.js's App
 * Router requires.
 *
 * `RunsHistoryScreen` calls `useSearchParams()` (filters, pagination and the selected run all live
 * in the URL — see that file's header), which Next.js requires a `<Suspense>` boundary around so a
 * dynamic request does not deopt the whole route to client-only rendering. `export const dynamic =
 * 'force-dynamic'` is still correct and still needed independently: every fetch this screen makes
 * carries the caller's session cookie, so — like every other route under `apps/web/app/(shell)` —
 * this page must never be prerendered.
 */
export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const off = await switchedOffPanel('runs');
  if (off !== null) return off;
  return (
    <Suspense fallback={<main className="p-8 text-[13px] text-muted">Loading…</main>}>
      <RunsHistoryScreen />
    </Suspense>
  );
}
