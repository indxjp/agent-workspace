/**
 * The platform's `search_files` tool, as a gallery suite can call it offline (ADR-0147, #1314).
 *
 * A live run asks `GET /api/sessions/:id/file-search`, which ranks passages with PostgreSQL
 * `ts_rank`. This double keeps everything the use cases depend on and replaces only that ranking:
 * the text is extracted by the platform's own `extractPassages`, the terms are the platform's own
 * `searchTerms`, a query is validated by the contract's `FileSearchQuerySchema`, a hit is cut by
 * `snippetAround`, the answer must parse as `FileSearchResponseSchema`, and a file outside the
 * agent's grants is never searched (`isGrantedPath`). A run's `fileScope` narrows the grants with
 * the platform's own `narrowFileGrants` (issue #1539), and a scope that would widen them is refused
 * as launch refuses it (`run_file_scope_not_granted`). The text the model reads is rendered as the
 * Claude adapter renders it. PostgreSQL itself is proven in `apps/web/server/files/search.test.ts`.
 *
 * ponytail: a phrase match scored by occurrence count in place of `ts_rank`; assertions here check
 * membership and citations, never the order of near-equal hits.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { FileSearchQuerySchema, FileSearchResponseSchema } from '@indx-workspace/contracts/files';
import type { FileSearchHit } from '@indx-workspace/contracts/files';

import { extractKind, extractPassages } from '../../../apps/web/server/files/extract.ts';
import {
  isGrantedPath,
  narrowFileGrants,
  searchTerms,
  snippetAround,
} from '../../../apps/web/server/files/search-terms.ts';
import type { McpToolResult } from './mcp-client.ts';

/** The longest passage the platform indexes (`FILE_TEXT_MAX_CHARS` in packages/core). */
const PASSAGE_CHARS = 20_000;

/** The name a Claude run reports for the built-in tool. */
export const SEARCH_FILES_TOOL_NAME = 'mcp__agent-workspace__search_files';

export interface FileSearchSetup {
  /** The use case's `data/` folder: a file's workspace path is its path under it, as `aw files upload` makes it. */
  readonly root: string;
  /** The agent's `files()` grants: folders (or exact files) in workspace paths. */
  readonly grants: readonly string[];
}

interface Passage {
  readonly path: string;
  readonly page: number | null;
  readonly text: string;
  readonly terms: readonly string[];
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** How many times `needle` occurs as a run of consecutive terms of `haystack`. */
function occurrences(haystack: readonly string[], needle: readonly string[]): number {
  let found = 0;
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (needle.every((term, offset) => haystack[at + offset] === term)) found += 1;
  }
  return found;
}

/** The workspace files `setup` grants, split into passages the way a search request would. */
function grantedPassages({ root, grants }: FileSearchSetup): Passage[] {
  return filesUnder(root).flatMap((file) => {
    const workspacePath = path.relative(root, file).split(path.sep).join('/');
    const kind = extractKind(workspacePath, null);
    if (kind === null || !isGrantedPath(workspacePath, grants)) return [];
    return extractPassages(kind, readFileSync(file), PASSAGE_CHARS).map((passage) => ({
      path: workspacePath,
      page: passage.page,
      text: passage.text,
      terms: searchTerms(passage.text),
    }));
  });
}

/** The paths of `passages` a run with `fileScope` may search; a widening scope throws. */
function scopedPaths(
  grants: readonly string[],
  passages: readonly Passage[],
  fileScope: readonly string[] | null,
): Set<string> {
  const paths = passages.map((passage) => passage.path);
  if (fileScope === null) return new Set(paths);
  const { widens } = narrowFileGrants(
    grants.map((grant) => ({ kind: 'directory' as const, path: grant })),
    fileScope,
  );
  if (widens.length > 0) {
    throw new Error('run_file_scope_not_granted: fileScope names a path this run cannot narrow to');
  }
  return new Set(paths.filter((file) => isGrantedPath(file, fileScope)));
}

/**
 * The tool as the model sees it: `[{ path, page, snippet }]`, best first, or the adapter's refusal
 * text with `isError` for a query the route would answer `400 invalid_search_query`.
 */
export function createFileSearch(setup: FileSearchSetup): {
  readonly call: (
    args: Record<string, unknown>,
    run?: { readonly fileScope: readonly string[] | null },
  ) => Promise<McpToolResult>;
  /** Every workspace path the grants cover and search can read. */
  readonly searchablePaths: () => string[];
} {
  const passages = grantedPassages(setup);
  return {
    searchablePaths: () => [...new Set(passages.map((passage) => passage.path))],
    call: (args, run) => {
      const inScope = scopedPaths(setup.grants, passages, run?.fileScope ?? null);
      const query = FileSearchQuerySchema.safeParse({ q: args['query'], limit: args['limit'] });
      // Like the route, a query that holds no searchable term is refused, not answered empty.
      const runs = query.success
        ? query.data.q
            .split(/\s+/u)
            .map((run) => searchTerms(run))
            .filter((terms) => terms.length > 0)
        : [];
      if (!query.success || runs.length === 0) {
        return Promise.resolve({
          text: 'File search failed (HTTP 400, invalid_search_query).',
          isError: true,
        });
      }
      const hits: FileSearchHit[] = [];
      for (const passage of passages) {
        if (!inScope.has(passage.path)) continue;
        const counts = runs.map((run) => occurrences(passage.terms, run));
        if (counts.some((count) => count === 0)) continue;
        hits.push({
          path: passage.path,
          page: passage.page,
          snippet: snippetAround(passage.text, query.data.q),
          score: counts.reduce((sum, count) => sum + count, 0),
        });
      }
      hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const response = FileSearchResponseSchema.parse({
        hits: hits.slice(0, query.data.limit),
        pending: 0,
      });
      const results = response.hits.map(({ path: file, page, snippet }) => ({
        path: file,
        page,
        snippet,
      }));
      return Promise.resolve({ text: JSON.stringify(results), isError: false });
    },
  };
}
