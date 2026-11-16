import { Suspense } from 'react';

import { ProjectsScreen } from '../../../components/projects/projects-screen';
import { switchedOffPanel } from '../feature-gate';

/**
 * `/projects` — the project list and its create form.
 *
 * `ProjectsScreen` reads `?archived=` with `useSearchParams()` (issue #184 keeps the archived
 * filter in the URL so a history view is linkable), which Next.js requires a `<Suspense>` boundary
 * around so a dynamic request does not deopt the route to client-only rendering — the same seam
 * `(shell)/runs/page.tsx` already has for the same reason. `force-dynamic` is independently
 * correct: every fetch this screen makes carries the caller's session cookie.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const off = await switchedOffPanel('projects');
  if (off !== null) return off;
  return (
    <Suspense fallback={<main className="p-8 text-[13px] text-muted">Loading…</main>}>
      <ProjectsScreen />
    </Suspense>
  );
}
