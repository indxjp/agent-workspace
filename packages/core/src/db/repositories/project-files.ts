import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { files, projectFiles } from '../schema/index.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/**
 * ADR-0146 decision 6: a file under the reserved `.attachments/` prefix is a surface visitor's
 * upload. Renaming it out is the only operation a member may take on it, so it is never assigned to
 * a project or an agent while it is there. The first path segment compares without case, as the
 * files handler's `attachmentsRefusal` does.
 */
export const underAttachmentsPrefix = sql`lower(split_part(${files.path}, '/', 1)) = '.attachments'`;

/**
 * Thrown when a project binding names a file under `.attachments/`. The route answers it as the
 * same `400 unknown_file` an agent assignment gets, so the refusal does not confirm the file exists.
 */
class ProjectFileReservedError extends Error {
  public override readonly name = 'ProjectFileReservedError';

  public constructor() {
    super('a project cannot bind a file under the reserved .attachments/ prefix');
  }
}

/** Refuse a binding that names a file of this workspace under `.attachments/` or still pending. */
export async function refuseReservedFileBindings(
  db: Pick<Database, 'select'>,
  workspaceId: string,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const reserved = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        // Compared as text, so an id that is not a UUID reaches the insert (and its foreign key)
        // exactly as before, as `refuseToolConnectorBindings` does.
        sql`${files.id}::text = ANY(${sql.param([...fileIds])}::text[])`,
        // A pending upload is not a file yet (the storage design, §04), so it answers as unknown.
        or(underAttachmentsPrefix, ne(files.status, 'ready')),
      ),
    )
    .limit(1);
  if (reserved.length > 0) throw new ProjectFileReservedError();
}

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
            (
              await db
                .select({ id: projectFiles.fileId })
                .from(projectFiles)
                .innerJoin(
                  files,
                  and(
                    eq(files.id, projectFiles.fileId),
                    eq(files.workspaceId, projectFiles.workspaceId),
                  ),
                )
                // A grant on a row that is not ready (removed, awaiting cleanup) is not a grant.
                .where(
                  and(
                    eq(projectFiles.workspaceId, workspaceId),
                    eq(projectFiles.projectId, projectId),
                    eq(files.status, 'ready'),
                  ),
                )
                .orderBy(asc(projectFiles.fileId))
            ).map((row) => row.id)
          );
        },
        async add(projectId, fileId) {
          await refuseReservedFileBindings(db, workspaceId, [fileId]);
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
