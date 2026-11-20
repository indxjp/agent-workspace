import type { ProjectRecord } from './projects.js';

/** The lifecycle predicate for one project row, expressed once (`isWorkspaceArchived`'s shape). */
export function isProjectArchived(project: Pick<ProjectRecord, 'archivedAt'>): boolean {
  return project.archivedAt !== null;
}
