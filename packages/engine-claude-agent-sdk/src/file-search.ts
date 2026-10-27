/**
 * `search_files` for the Claude Agent SDK (ADR-0147, #1314): the run asks the control plane to
 * search the files its run request carried and gets back paths, pages and snippets to cite.
 *
 * The decisions live in the control plane (`GET /api/sessions/:id/file-search`), which answers only
 * from the paths the run was granted; this file builds the request and renders the answer. The
 * in-process MCP server that offers the tool is built in `./boundary.ts`, the only file that imports
 * the SDK. Like `run_skill_script`, the tool is named `mcp__agent-workspace__search_files` and an
 * author lists that name in `autoApprove` to let a headless run call it unasked.
 */
import { z } from 'zod';

import type { EngineFileSearchLink } from '@agent-workspace/engine';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { FileSearchResponseSchema, MAX_SEARCH_LIMIT } from '@indx-workspace/contracts/files';

export const SEARCH_FILES_TOOL = 'search_files';

export const CLAUDE_SEARCH_FILES_INPUT = z.object({
  query: z.string().describe('Words to find in the text of the files you may read.'),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
});

export const SEARCH_FILES_DESCRIPTION =
  'Search the text of the files you were given (PDF, Office, text and CSV, Japanese included). ' +
  'Returns the path, page and a snippet of each matching passage, best first; cite them.';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type FileSearchSetup = EngineFileSearchLink & { readonly sessionId: string };

/** The tool's setup, or `null` when it is not offered: `readFiles` is off, or no control plane link. */
export function fileSearchSetup(
  request: {
    readonly sessionId: string;
    readonly portable: { readonly permissions: { readonly readFiles: boolean } };
  },
  link: EngineFileSearchLink | undefined,
): FileSearchSetup | null {
  return link !== undefined && request.portable.permissions.readFiles
    ? { ...link, sessionId: request.sessionId }
    : null;
}

/** One call: the text the model reads, and whether it is an error. Nothing here throws. */
export async function executeFileSearch(
  setup: FileSearchSetup,
  input: z.infer<typeof CLAUDE_SEARCH_FILES_INPUT>,
  signal: AbortSignal | undefined,
  doFetch: FetchLike = fetch,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  const params = new URLSearchParams({ q: input.query });
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  try {
    const response = await doFetch(
      `${setup.baseUrl}/api/sessions/${setup.sessionId}/file-search?${params.toString()}`,
      {
        headers: { authorization: `Bearer ${setup.token}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) {
      // The problem code is a stable public code, so the model can tell a bad query from a refusal.
      const problem = ApiProblemSchema.safeParse(await response.json().catch(() => null));
      const code = problem.success ? `, ${problem.data.error.code}` : '';
      return {
        text: `File search failed (HTTP ${String(response.status)}${code}).`,
        isError: true,
      };
    }
    const body = FileSearchResponseSchema.safeParse(await response.json());
    if (!body.success) return { text: 'File search answered an unreadable body.', isError: true };
    const results = body.data.hits.map(({ path, page, snippet }) => ({ path, page, snippet }));
    const note =
      body.data.pending > 0
        ? `\n${String(body.data.pending)} files are still being read; repeat the search to include them.`
        : '';
    return { text: JSON.stringify(results) + note, isError: false };
  } catch {
    return { text: 'File search could not reach the control plane.', isError: true };
  }
}
