/** The query parsing and the failure shapes both search routes share (ADR-0147). */
import { FileSearchQuerySchema } from '@indx-workspace/contracts/files';

import { problem, type FileResult } from './handlers';
import { withCatalogService } from './http';
import { applicationContext } from '../application-context';
import { searchFiles } from './search';

export type SearchQuery = ReturnType<typeof FileSearchQuerySchema.parse>;

export const invalidQuery = (): FileResult =>
  problem(
    400,
    'invalid_search_query',
    'Pass "q" (words to find, 1-256 characters) and optionally "limit" (1-50); nothing else.',
  );

/** `null` for an unknown, repeated or out-of-range parameter. */
export function parseSearchQuery(request: Request): SearchQuery | null {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const parsed = FileSearchQuerySchema.safeParse(Object.fromEntries(params));
  return parsed.success ? parsed.data : null;
}

/** Search one workspace; `grants` confines it to a run's granted paths, `null` is the caller's all. */
export function searchWorkspaceFiles(
  request: Request,
  workspaceId: string,
  query: SearchQuery,
  grants: readonly string[] | null,
): Promise<FileResult> {
  const files = applicationContext()?.files;
  const texts = files?.kind === 'serving' ? files.runtime.texts : undefined;
  return withCatalogService(
    request,
    async (storage, catalog) => {
      if (texts === undefined) {
        return problem(
          503,
          'files_runtime_not_configured',
          'File search has no text cache wired into it. This deployment cannot serve it.',
        );
      }
      try {
        const found = await searchFiles(
          {
            texts: await texts.forWorkspace(workspaceId),
            catalog,
            open: (row) => storage.open({ workspaceId }, row),
          },
          { query: query.q, limit: query.limit, grants },
        );
        return found === null ? invalidQuery() : { status: 200, kind: 'json', body: found };
      } catch {
        // No telemetry port exists yet (F-04 bars console here); the caller gets the safe envelope.
        return problem(500, 'search_unavailable', 'File search failed; retry the request.');
      }
    },
    workspaceId,
  );
}
