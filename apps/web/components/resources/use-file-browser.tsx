'use client';

import { useCallback, useEffect, useState } from 'react';
import { browserClient } from '../../lib/browser-client';
import { errorText, listFiles } from './resources-model';
import {
  canonicalizeFolderPath,
  emptyFolderText,
  toFileRows,
  type FileRow,
} from './file-browser-model';
import { ENGLISH_FILES_STRINGS, type FilesStrings, type Said } from './files-messages';

/** A failure the server or the browser worded, after this screen's `lead` (empty in English). */
export function refusal(lead: string, error: unknown): Said {
  return [{ text: lead }, { text: errorText(error), english: true }];
}

interface FilesFetchState {
  readonly value: { files: FileRow[] } | null;
  readonly problem: Said | null;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
  readonly setProblem: (problem: Said | null) => void;
}

/**
 * Deliberately its own hook rather than a reuse of the shared `useJson` above: a folder switch
 * must show the "Loading…" state again rather than the previous folder's rows sitting there stale
 * until the new response lands, which is what `useJson`'s "keep the last value until the next one
 * arrives" behaviour (fine for a page that never re-points its own URL) would otherwise do here.
 */
function useFilesState(path: string, words: FilesStrings): FilesFetchState {
  const [value, setValue] = useState<{ files: FileRow[] } | null>(null);
  const [problem, setProblem] = useState<Said | null>(null);
  const reload = useCallback(async () => {
    setProblem(null);
    setValue({ files: toFileRows({ files: await listFiles(browserClient(), path) }) });
  }, [path]);
  useEffect(() => {
    setValue(null);
    void reload().catch((error: unknown) => setProblem(refusal(words.leads.list, error)));
  }, [reload, words]);
  return { value, problem, loading: value === null && problem === null, reload, setProblem };
}

/**
 * {@link emptyFolderText} for the current folder. The parent is asked only when a non-root listing
 * is empty, and until it answers the sentence is blank rather than "This folder is empty.", which
 * would be wrong for a missing folder.
 */
export function useEmptyFolderText(
  path: string,
  empty: boolean,
  words: FilesStrings = ENGLISH_FILES_STRINGS,
): string {
  const [answer, setAnswer] = useState<{ readonly path: string; readonly text: string } | null>(
    null,
  );
  useEffect(() => {
    if (!empty || path === '') return undefined;
    let current = true;
    const slash = path.lastIndexOf('/');
    listFiles(browserClient(), slash === -1 ? '' : path.slice(0, slash)).then(
      (rows) => {
        if (current) setAnswer({ path, text: emptyFolderText(path, rows, words) });
      },
      // The listing itself already loaded; a failed second look keeps the plain sentence.
      () => {
        if (current) setAnswer({ path, text: words.emptyFolder });
      },
    );
    return () => {
      current = false;
    };
  }, [path, empty, words]);
  if (path === '') return words.emptyFolder;
  return answer?.path === path ? answer.text : '';
}

/** The current folder, deep-linked through `?path=` (see this section's header), plus its listing. */
export function useFileBrowser(words: FilesStrings = ENGLISH_FILES_STRINGS) {
  const [path, setPath] = useState<string>(() =>
    typeof window === 'undefined'
      ? ''
      : canonicalizeFolderPath(new URLSearchParams(window.location.search).get('path')),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      setPath(canonicalizeFolderPath(new URLSearchParams(window.location.search).get('path')));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigateTo = useCallback((next: string) => {
    const canonical = canonicalizeFolderPath(next);
    setPath(canonical);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (canonical === '') url.searchParams.delete('path');
      else url.searchParams.set('path', canonical);
      window.history.pushState({ path: canonical }, '', url);
    }
  }, []);
  const state = useFilesState(path, words);
  return { path, navigateTo, state };
}
