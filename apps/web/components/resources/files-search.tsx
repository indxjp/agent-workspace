'use client';

/**
 * The Files screen's search box (UX-17 in #2086, issue #2090): `GET /api/files/search` through the
 * SDK, so a person can find a file by the words inside it. While a search is shown it takes the
 * place of the folder listing; clearing it brings the folder back.
 *
 * Search returns only files the caller may open: the route admits exactly the roles that read every
 * workspace file (`files` read is `any` or nothing, `rbac/permissions.ts`), and leaves out
 * `.attachments/` as the listing does (`server/files/search.ts`).
 */
import { useCallback, useRef, useState } from 'react';

import { fileRouteId, MAX_SEARCH_QUERY_CHARS } from '@indx-workspace/contracts/files';
import type { FileSearchHit } from '@indx-workspace/contracts/files';

import { browserClient } from '../../lib/browser-client';
import type { FilesSearchStrings } from './files-search-messages';
import { problemOf, searchFiles } from './resources-model';
import { BUTTON, CARD, INPUT } from './resource-styles';

type SearchFailure = 'noTerms' | 'unavailable' | 'switchedOff' | 'forbidden' | 'failed';

/** What the box shows: nothing (the folder listing instead), a search in flight, or its answer. */
export type FileSearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly query: string }
  | {
      readonly kind: 'done';
      readonly query: string;
      readonly hits: readonly FileSearchHit[];
      readonly pending: number;
    }
  | { readonly kind: 'failed'; readonly query: string; readonly failure: SearchFailure };

function failureOf(error: unknown): SearchFailure {
  const problem = problemOf(error);
  if (problem?.code === 'invalid_search_query') return 'noTerms';
  if (problem?.code === 'files_runtime_not_configured') return 'unavailable';
  // Files was switched off after the page loaded (server/features/guard.ts answers 404).
  if (problem?.code === 'feature_disabled') return 'switchedOff';
  // A role that may not read every file is refused (rbac/permissions.ts); trying again won't help.
  if (problem?.status === 403) return 'forbidden';
  return 'failed';
}

export function useFileSearch() {
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<FileSearchState>({ kind: 'idle' });
  // Only the latest search may answer: a slower earlier one must not overwrite it or a clear.
  const latest = useRef(0);
  const run = useCallback((raw: string) => {
    const query = raw.trim();
    latest.current += 1;
    const ticket = latest.current;
    if (query === '') {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'loading', query });
    searchFiles(browserClient(), query).then(
      (found) => {
        if (ticket === latest.current) setState({ kind: 'done', query, ...found });
      },
      (error: unknown) => {
        if (ticket === latest.current)
          setState({ kind: 'failed', query, failure: failureOf(error) });
      },
    );
  }, []);
  const clear = useCallback(() => {
    latest.current += 1;
    setDraft('');
    setState({ kind: 'idle' });
  }, []);
  return { draft, setDraft, state, run, clear, active: state.kind !== 'idle' };
}

export type FileSearchModel = ReturnType<typeof useFileSearch>;

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A workbook's `page` is its 1-based sheet; any other file's is a PDF page. */
function placeOf(hit: FileSearchHit, strings: FilesSearchStrings): string | null {
  if (hit.page === null) return null;
  return /\.xlsx$/iu.test(hit.path) ? strings.sheet(hit.page) : strings.page(hit.page);
}

function SearchResults({
  state,
  strings,
  onSearchAgain,
  onOpenFolder,
}: {
  readonly state: Exclude<FileSearchState, { readonly kind: 'idle' }>;
  readonly strings: FilesSearchStrings;
  readonly onSearchAgain: () => void;
  readonly onOpenFolder: (path: string) => void;
}) {
  if (state.kind === 'loading') {
    return (
      <p className="text-sm text-muted" role="status">
        {strings.searching}
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className="text-sm text-danger" role="alert">
        {strings[state.failure]}
      </p>
    );
  }
  return (
    <section aria-label={strings.heading(state.query)}>
      <h2 className="mb-3 text-sm font-semibold break-words text-text">
        {strings.heading(state.query)}
      </h2>
      {state.pending > 0 ? (
        <p className="mb-3 flex flex-wrap items-center gap-3 text-sm text-muted" role="status">
          {strings.partial}
          <button className={BUTTON} onClick={onSearchAgain} type="button">
            {strings.searchAgain}
          </button>
        </p>
      ) : null}
      {state.hits.length === 0 ? (
        <p className="text-sm text-muted break-words" role="status">
          {strings.noResults(state.query)}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.hits.map((hit, index) => {
            const place = placeOf(hit, strings);
            return (
              <li
                className="border-b border-border pb-3 last:border-b-0"
                key={`${hit.path}#${String(hit.page)}#${String(index)}`}
              >
                <p className="text-sm font-medium break-all text-text">
                  {hit.path}
                  {place === null ? null : (
                    <span className="ml-2 font-normal text-muted">{place}</span>
                  )}
                </p>
                <p className="mt-1 text-sm break-words whitespace-pre-line text-muted">
                  {hit.snippet}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className={BUTTON}
                    onClick={() => onOpenFolder(folderOf(hit.path))}
                    type="button"
                  >
                    {strings.openFolder}
                  </button>
                  <a className={BUTTON} href={`/api/files/${fileRouteId(hit.path)}`}>
                    {strings.download}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The box, and while a search is shown, its results. */
export function FileSearch({
  search,
  strings,
  onOpenFolder,
}: {
  readonly search: FileSearchModel;
  readonly strings: FilesSearchStrings;
  /** Shows a hit's folder; the search is cleared first so the folder listing comes back. */
  readonly onOpenFolder: (path: string) => void;
}) {
  const { state } = search;
  return (
    <div className={`${CARD} mb-5`}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          search.run(search.draft);
        }}
        role="search"
      >
        {/* 16rem basis: on a phone the box takes its own line and the buttons wrap below it. */}
        <label className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1 text-sm">
          {strings.label}
          <input
            className={INPUT}
            maxLength={MAX_SEARCH_QUERY_CHARS}
            name="q"
            onChange={(event) => {
              // Emptying the box (or the browser's own clear button) leaves the search too.
              if (event.target.value === '') search.clear();
              else search.setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') search.clear();
            }}
            placeholder={strings.placeholder}
            type="search"
            value={search.draft}
          />
        </label>
        <button className={BUTTON} disabled={state.kind === 'loading'} type="submit">
          {strings.search}
        </button>
        {search.active ? (
          <button className={BUTTON} onClick={search.clear} type="button">
            {strings.clear}
          </button>
        ) : null}
      </form>
      {state.kind === 'idle' ? null : (
        <div className="mt-4">
          <SearchResults
            onOpenFolder={(path) => {
              search.clear();
              onOpenFolder(path);
            }}
            onSearchAgain={() => search.run(state.query)}
            state={state}
            strings={strings}
          />
        </div>
      )}
    </div>
  );
}
