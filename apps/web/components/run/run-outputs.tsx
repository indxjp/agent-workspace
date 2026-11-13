'use client';

/**
 * The files a session's runs wrote to their `outputs/` directory (UX-14 in #2086), under the
 * transcript once no run is live. Before this a run's files were only in the SDK
 * (`runs.outputs`) and in Files under `runs/<runId>/outputs/`, where nobody looked.
 *
 * A session with no output files renders nothing: a region with no data is absent, not an empty
 * frame (W1-UI-03, the rule `run-view.tsx` follows), and so does a listing still loading. A failed
 * listing says so, with a retry; a caller who may not read Files (a Viewer) sees nothing.
 */
import { fileRouteId } from '@indx-workspace/contracts/files';
import { ApiProblemError, type RunOutputFile } from '@indx-workspace/sdk';
import { useEffect, useState } from 'react';

import type { VersionsLocale } from '../agents/versions-messages';
import { browserClient } from '../../lib/browser-client';
import { formatSize } from '../resources/file-browser-model';
import { errorText } from '../resources/resources-model';

export interface RunOutputsStrings {
  readonly heading: string;
  readonly description: string;
  readonly download: string;
  readonly openInFiles: string;
  readonly failed: string;
  readonly retry: string;
}

const EN: RunOutputsStrings = {
  heading: 'Files this run wrote',
  description: 'Saved in Files under the run’s outputs folder.',
  download: 'Download',
  openInFiles: 'Open in Files',
  failed: 'Could not list the files this run wrote.',
  retry: 'Try again',
};

const JA: RunOutputsStrings = {
  heading: 'このランが書いたファイル',
  description: 'ファイル画面の、このランの outputs フォルダーに保存されています。',
  download: 'ダウンロード',
  openInFiles: 'ファイルで開く',
  failed: 'このランが書いたファイルを一覧できませんでした。',
  retry: 'もう一度',
};

function runOutputsStrings(locale: VersionsLocale): RunOutputsStrings {
  return locale === 'ja' ? JA : EN;
}

/** The Files screen at a run's outputs folder. */
export function outputsFolderHref(runId: string): string {
  return `/files?${new URLSearchParams({ path: `runs/${runId}/outputs` }).toString()}`;
}

/** One output file, with the run that wrote it. */
export interface SessionOutputFile {
  readonly runId: string;
  readonly file: RunOutputFile;
}

/** Every run's output files, in run order; one failed run fails the whole listing. */
export async function loadSessionOutputs(
  runIds: readonly string[],
  outputs: (runId: string) => Promise<readonly RunOutputFile[]>,
): Promise<readonly SessionOutputFile[]> {
  const perRun = await Promise.all(
    runIds.map(async (runId) => (await outputs(runId)).map((file) => ({ runId, file }))),
  );
  return perRun.flat();
}

type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly files: readonly SessionOutputFile[] }
  | { readonly kind: 'failed'; readonly message: string };

export interface RunOutputsProps {
  readonly runIds: readonly string[];
  /** `false` while a run is live: its files are collected only when it ends. */
  readonly settled: boolean;
  readonly locale: VersionsLocale;
  /** The SDK's `runs.outputs`; tests pass their own. */
  readonly outputs?: (runId: string) => Promise<readonly RunOutputFile[]>;
}

export function RunOutputs({ runIds, settled, locale, outputs }: RunOutputsProps) {
  const strings = runOutputsStrings(locale);
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const key = runIds.join(',');

  useEffect(() => {
    if (!settled || key === '') return;
    let current = true;
    setListing({ kind: 'loading' });
    const list = outputs ?? ((runId: string) => browserClient().runs.outputs(runId));
    loadSessionOutputs(key.split(','), list).then(
      (files) => {
        if (current) setListing({ kind: 'ready', files });
      },
      (error: unknown) => {
        if (!current) return;
        // A Viewer may not read Files (`rbac/core/permissions.ts`), so it has no outputs to see.
        if (error instanceof ApiProblemError && error.status === 403) {
          setListing({ kind: 'ready', files: [] });
        } else {
          setListing({ kind: 'failed', message: errorText(error) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [settled, key, outputs, attempt]);

  if (!settled || key === '') return null;
  // Nothing while loading: most runs write no files, and a "looking…" line would flash every time.
  if (listing.kind === 'loading') return null;
  if (listing.kind === 'failed') {
    return (
      <div lang={locale} role="alert" className="mt-6 text-[13px] text-text-2">
        {strings.failed} <span className="text-muted">{listing.message}</span>{' '}
        <button
          type="button"
          onClick={() => setAttempt((count) => count + 1)}
          className="cursor-pointer border-0 bg-transparent p-0 text-accent underline"
        >
          {strings.retry}
        </button>
      </div>
    );
  }
  if (listing.files.length === 0) return null;
  const runsWithFiles = [...new Set(listing.files.map((entry) => entry.runId))];
  return (
    <section
      lang={locale}
      aria-label={strings.heading}
      className="mt-6 rounded-(--radius) border border-border bg-surface shadow-(--shadow)"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-[13px]">
        <h3 className="text-[14px]">{strings.heading}</h3>
        <span className="text-[12.5px] text-muted">{strings.description}</span>
        {runsWithFiles.length === 1 ? (
          <a
            href={outputsFolderHref(runsWithFiles[0] ?? '')}
            className="ml-auto text-[12.5px] text-accent no-underline hover:underline"
          >
            {strings.openInFiles}
          </a>
        ) : null}
      </div>
      <ul className="m-0 list-none p-0">
        {listing.files.map(({ runId, file }) => (
          <li
            key={`${runId}/${file.path}`}
            className="flex items-center gap-3.5 border-b border-border px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold [overflow-wrap:anywhere]">
                {file.name}
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted">{formatSize(file.sizeBytes)}</div>
            </div>
            <a
              href={`/api/files/${fileRouteId(file.path)}`}
              aria-label={`${strings.download} ${file.name}`}
              className="inline-flex h-[27px] items-center rounded-(--radius) border border-border-strong bg-surface px-[9px] text-[12.5px] text-text no-underline hover:bg-surface-2"
            >
              {strings.download}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
