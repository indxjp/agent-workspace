/**
 * Built-in lexical search over workspace files (ADR-0147, P8-4).
 *
 * Nothing extracts text on upload. A search first brings the cache up to date for the files that
 * are missing or stale, within a budget, then runs one PostgreSQL full-text query over it. What the
 * budget left undone is reported as `pending`, so a partial answer is declared and a retry
 * continues the work. A file search cannot read (unsupported type, over the size limit, refused or
 * unparseable) is recorded as an empty marker, so this version of it is not tried again.
 *
 * A whole-workspace search excludes `.attachments/` (surface visitors' uploads, ADR-0146 D6), both
 * from extraction and from the text query. A run keeps the attachments its grants name. No search
 * reads a skill's rows.
 */
import { readBytes } from '@agent-workspace/core/storage/streams';
import type { ObjectStream } from '@agent-workspace/core/storage';
import type { FileSearchResponse } from '@indx-workspace/contracts/files';

import { EXTRACT_MAX_FILE_BYTES, extractKind, extractPassages } from './extract';
import { isReservedAttachmentPath } from './handlers';
import { isGrantedPath, snippetAround, searchTerms, toTsQuery } from './search-terms';
import type { CatalogFile } from '../storage/store';
import { FILE_TEXT_MAX_CHARS, type FileTextStore } from './store';

/** Files one search request may extract, and the bytes of them it may read. */
export const SEARCH_EXTRACT_BUDGET = 20;
const SEARCH_EXTRACT_BYTES = 40 * 1024 * 1024;

export interface SearchFilesDependencies {
  readonly texts: FileTextStore;
  /** Turns the paths in scope into the file ids the text query is restricted to. */
  readonly catalog: { listFiles(): Promise<readonly CatalogFile[]> };
  /** Reads a row's object through the catalog service, old and new naming alike. */
  readonly open: (row: CatalogFile) => Promise<ObjectStream | null>;
  /** The extraction budget; defaults to {@link SEARCH_EXTRACT_BUDGET}. */
  readonly budget?: number;
}

export interface SearchFilesInput {
  readonly query: string;
  readonly limit: number;
  /** Restricts the search to the granted files of a run; `null` is the whole workspace. */
  readonly grants: readonly string[] | null;
}

const MARKER = [{ page: null, text: '', terms: '' }] as const;

/** `null` when the query holds no searchable term; the route answers that as a bad query. */
export async function searchFiles(
  dependencies: SearchFilesDependencies,
  input: SearchFilesInput,
): Promise<FileSearchResponse | null> {
  const tsquery = toTsQuery(input.query);
  if (tsquery === null) return null;
  const { texts, catalog } = dependencies;
  const { grants } = input;
  const rows = await catalog.listFiles();
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  // A skill's files are rows of the same catalog; they are found by area, not by path.
  // @story US-STO-08
  const inScope = ({ id, path }: { readonly id: string; readonly path: string }): boolean =>
    rowsById.get(id)?.area !== 'skills' &&
    (grants === null ? !isReservedAttachmentPath(path) : isGrantedPath(path, grants));
  const stale = (await texts.listStale()).filter(inScope);
  let remainingFiles = dependencies.budget ?? SEARCH_EXTRACT_BUDGET;
  let remainingBytes = SEARCH_EXTRACT_BYTES;
  let pending = 0;
  for (const file of stale) {
    const kind = extractKind(file.path, file.contentType);
    const readable = kind !== null && file.sizeBytes <= EXTRACT_MAX_FILE_BYTES;
    if (readable) {
      // ponytail: a fixed per-request budget; a background worker is the upgrade if cold searches
      // over a large workspace need more than a few retries to converge.
      if (remainingFiles <= 0 || remainingBytes < file.sizeBytes) {
        pending += 1;
        continue;
      }
      remainingFiles -= 1;
      remainingBytes -= file.sizeBytes;
    }
    const passages = readable ? await readPassages(dependencies, rowsById.get(file.id), kind) : [];
    await texts.replace(file.id, file, passages.length > 0 ? passages : MARKER);
  }

  // ponytail: a whole-workspace search passes every non-reserved file id, which grows with the
  // workspace; an excluded-prefix predicate in the file-texts SQL is the upgrade.
  const allowedFileIds = rows
    .filter((entry) => entry.kind === 'file' && inScope(entry))
    .map((entry) => entry.id);
  const hits = await texts.search(tsquery, input.limit, allowedFileIds);
  return {
    hits: hits.map((hit) => ({
      path: hit.path,
      page: hit.page,
      snippet: snippetAround(hit.text, input.query),
      score: Number(hit.score.toFixed(4)),
    })),
    pending,
  };
}

async function readBody(
  dependencies: SearchFilesDependencies,
  row: CatalogFile | undefined,
): Promise<Uint8Array | null> {
  if (row === undefined) return null;
  // @story US-STO-01
  const object = await dependencies.open(row);
  return object === null ? null : readBytes(object.body, EXTRACT_MAX_FILE_BYTES);
}

async function readPassages(
  dependencies: SearchFilesDependencies,
  row: CatalogFile | undefined,
  kind: NonNullable<ReturnType<typeof extractKind>>,
) {
  const body = await readBody(dependencies, row);
  if (body === null) return [];
  try {
    return extractPassages(kind, body, FILE_TEXT_MAX_CHARS).map((passage) => ({
      page: passage.page,
      text: passage.text,
      terms: searchTerms(passage.text).join(' '),
    }));
  } catch {
    return [];
  }
}
