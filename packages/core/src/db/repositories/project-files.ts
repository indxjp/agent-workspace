import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { projectFiles } from '../schema/index.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface ProjectFileRepository {
  list(projectId: string): Promise<readonly string[]>;
  add(projectId: string, fileId: string): Promise<void>;
  remove(projectId: string, fileId: string): Promise<void>;
}
export interface ProjectFileRepositoryProvider {
  forScope(scope: WorkspaceScope): ProjectFileRepository;
}
export function createDatabaseProjectFileRepositoryProvider(
  db: Database,
): ProjectFileRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'ProjectFileRepositoryProvider');
      return {
        async list(projectId) {
          return (
            await db
              .select({ id: projectFiles.fileId })
              .from(projectFiles)
              .where(
                and(
                  eq(projectFiles.workspaceId, workspaceId),
                  eq(projectFiles.projectId, projectId),
                ),
              )
              .orderBy(asc(projectFiles.fileId))
          ).map((row) => row.id);
        },
        async add(projectId, fileId) {
          await db
            .insert(projectFiles)
            .values({ workspaceId, projectId, fileId })
            .onConflictDoNothing();
        },
        async remove(projectId, fileId) {
          await db
            .delete(projectFiles)
            .where(
              and(
                eq(projectFiles.workspaceId, workspaceId),
                eq(projectFiles.projectId, projectId),
                eq(projectFiles.fileId, fileId),
              ),
            );
        },
      };
    },
  };
}
