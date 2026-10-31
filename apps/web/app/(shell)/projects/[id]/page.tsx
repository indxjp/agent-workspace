import { ProjectDetail } from '../../../../components/projects/project-detail';
import { resolveProjectArchiveCapability } from '../../../../server/projects/archive-capability';
import { switchedOffPanel } from '../../feature-gate';

/**
 * `/projects/:id` — the project settings surface.
 *
 * Issue #184 puts the archive/restore control here and requires that a refused caller see no
 * actionable control at all. Whether this caller may use it is decided by the same `decide()` table
 * `POST /api/projects/:id/archive` consults, evaluated here on the server and handed down as a prop
 * — see `server/projects/archive-capability.ts` for why it is not a probe and not a role table in
 * the browser. Nothing about the decision is re-made below this line; the client only compares the
 * project's `createdBy` against the viewer's own id.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const off = await switchedOffPanel('projects');
  if (off !== null) return off;
  const [{ id }, capability] = await Promise.all([params, resolveProjectArchiveCapability()]);
  return <ProjectDetail id={id} capability={capability} />;
}
