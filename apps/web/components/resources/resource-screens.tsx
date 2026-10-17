'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { CREDENTIAL_INPUT_PROPS } from '../shell/credential-input';

import { resourcePathHeaders } from '../../contracts/files';

const CARD = 'rounded-(--radius) border border-border bg-surface p-5 shadow-(--shadow)';
const INPUT = 'rounded border border-border-strong bg-bg px-3 py-2 text-sm text-text';
const BUTTON = 'rounded border border-border-strong px-3 py-2 text-sm font-medium';

function title(name: string, description: string, action?: React.ReactNode) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-text">{name}</h1>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

function useJson(url: string) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setProblem(null);
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(problemMessage(body, response.status));
    setValue(body);
  }, [url]);
  useEffect(() => {
    void reload().catch((error: unknown) =>
      setProblem(error instanceof Error ? error.message : String(error)),
    );
  }, [reload]);
  return { value, problem, loading: value === null && problem === null, reload, setProblem };
}

function problemMessage(body: Record<string, unknown>, status: number): string {
  const error = body['error'];
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message'];
    const details = (error as Record<string, unknown>)['details'];
    if (typeof message === 'string') {
      return Array.isArray(details) && details.every((detail) => typeof detail === 'string')
        ? `${message} ${details.join(' ')}`
        : message;
    }
  }
  return `Request returned ${String(status)}.`;
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(problemMessage(body, response.status));
  return body;
}

/**
 * Sends a destructive `DELETE` and reloads the list. A refusal or a network failure shows in the
 * screen's status line instead of a silent reload that looks like success.
 */
function deleteThenReload(state: ReturnType<typeof useJson>, url: string): void {
  void fetch(url, { method: 'DELETE' })
    .then(checkedJson)
    .then(() => state.reload())
    .catch((error: unknown) =>
      state.setProblem(error instanceof Error ? error.message : String(error)),
    );
}

function rows(value: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
  const collection = value?.[key];
  return Array.isArray(collection)
    ? collection.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

type RowWithStrings<Key extends string> = Record<string, unknown> & Readonly<Record<Key, string>>;

/** Keep malformed successful API rows out of render paths that require named string fields. */
function rowsWithStrings<const Key extends string>(
  value: Record<string, unknown> | null,
  collection: string,
  ...fields: readonly Key[]
): RowWithStrings<Key>[] {
  return rows(value, collection).filter((row): row is RowWithStrings<Key> =>
    fields.every((field) => typeof row[field] === 'string'),
  );
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function display(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function updateSkillSource(
  current: string,
  name: string,
  description: string,
  instructions: string,
): string {
  const lines = current.split(/\r\n|\r|\n/u);
  if ((lines[0] ?? '').trim() !== '---')
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (end < 0) return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;
  const frontmatter = lines.slice(1, end + 1);
  const replace = (key: string, value: string) => {
    const index = frontmatter.findIndex((line) => new RegExp(`^${key}\\s*:`, 'u').test(line));
    if (index < 0) frontmatter.push(`${key}: ${value}`);
    else frontmatter[index] = `${key}: ${value}`;
  };
  replace('name', name);
  replace('description', description);
  return `---\n${frontmatter.join('\n')}\n---\n\n${instructions}\n`;
}

function Status({ problem }: { problem: string | null }) {
  return problem === null ? null : (
    <p className="mb-4 text-sm text-danger" role="alert">
      {problem}
    </p>
  );
}

/**
 * The `:id` segment `/api/files/[id]` accepts: the base64url of the workspace-relative path, as
 * minted by `server/files/file-id.ts`. `GET /api/files` reports the relational catalog id in
 * `id` — the value the agent editor assigns resources with — which that route does not resolve.
 */
function fileRouteId(path: string): string {
  return base64(path).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * ## The nested file browser (issue #132)
 *
 * `GET /api/files?path=<folder>` already lists one level under any workspace-relative folder
 * (W9.2's `#131`/its predecessors); this screen's job is only to drive that query with a
 * canonical current folder instead of the flat root list the previous revision fetched once. No
 * change reaches `apps/web/server/files/**` or `apps/web/app/api/files/**` — see this task's PR
 * for what that leaves as a declared gap (an explicitly empty folder cannot be created, only
 * implied by the first thing put under it).
 *
 * ### Why the current folder lives in `window.location`/`history`, not `useSearchParams()`
 *
 * `agent-form.tsx`'s header (see `agents-screens.test.ts`) already established that
 * `next/navigation`'s `useRouter()`/`useSearchParams()` throw outside a mounted app router, which
 * is exactly the harness `resource-screens.test.ts` renders every screen in
 * (`renderToStaticMarkup`, no router). The card's own minimum implementation is explicit that this
 * task adds no new page file — so `apps/web/app/(shell)/files/page.tsx` still renders
 * `<FilesScreen />` with no `searchParams` prop to thread through. The browser's own
 * `history.pushState`/`popstate` give the same deep-link and back-button behaviour without either
 * constraint: `?path=<folder>` still round-trips through the URL bar and survives a reload, and
 * every read of it goes through {@link canonicalizeFolderPath} below.
 *
 * ### Why the client canonicalises at all, given the server already refuses a bad path
 *
 * `packages/core/src/storage/key-safety.ts` is a *filter*, not a rewriter — `../etc`,
 * `/absolute`, and a percent-encoded dot-segment are every one of them refused outright,
 * server-side, with a 400. That is sufficient for the request to fail safely, but this task's
 * verifier attack asks something stronger of the client: hand-editing the URL to any of those
 * forms must never even produce a request that *contains* a traversal, because the string that
 * ends up in the visible address bar and in `GET /api/files?path=…` is the same string a person
 * screen-sharing this page would see leave. {@link canonicalizeFolderPath} is therefore a second,
 * independent guard, and it resolves rather than refuses: unlike the server's filter, it clamps
 * an out-of-bounds `..` at the root instead of rejecting the whole path, and a folder canonicalised
 * this way that no longer exists renders as the ordinary empty-folder state (see below) rather
 * than a distinct "not found" one — this table has no independent notion of a folder's existence
 * apart from what is listed under it. Recorded as a decision in
 * `docs/adr/W9-FILES-132-client-side-path-canonicalisation.md`.
 */
export function canonicalizeFolderPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '';
  const segments: string[] = [];
  for (const rawSegment of raw.split('/')) {
    let segment = rawSegment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      // Not valid percent-encoding (a bare "%", a truncated sequence): kept as the literal
      // segment text it is, never treated as licence to interpret it as something else.
    }
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop(); // clamps at the root rather than going negative
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** `path` split into the crumbs a breadcrumb bar renders, each carrying the path it navigates to. */
export function breadcrumbSegments(
  path: string,
): { readonly name: string; readonly path: string }[] {
  if (path === '') return [];
  const parts = path.split('/');
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/** Preview metadata (spec §16) formatted for the table: size, in the smallest unit that reads as a single decimal. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/**
 * `lastModified` formatted without a locale/timezone dependency (`toLocaleString` would make this
 * screen's own rendering depend on the viewer's browser settings, which a component test cannot
 * pin). The API always reports UTC (`Date.toISOString()`, `server/files/handlers.ts`), so the
 * offset is never lost — only formatted plainly.
 */
export function formatModified(iso: string | null): string {
  if (iso === null) return '—';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(iso);
  return match === null ? iso : `${match[1]} ${match[2]} UTC`;
}

/** One row of `GET /api/files?path=…`, narrowed from the loosely-typed JSON body. */
export interface FileRow {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly lastModified: string | null;
}

export function toFileRows(body: Record<string, unknown>): FileRow[] {
  const list = Array.isArray(body['files']) ? body['files'] : [];
  return list
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      id: String(entry['id']),
      path: String(entry['path']),
      kind: entry['kind'] === 'folder' ? 'folder' : 'file',
      sizeBytes: typeof entry['sizeBytes'] === 'number' ? entry['sizeBytes'] : null,
      contentType: typeof entry['contentType'] === 'string' ? entry['contentType'] : null,
      lastModified: typeof entry['lastModified'] === 'string' ? entry['lastModified'] : null,
    }));
}

/** Folder-first, then by name — the shape the card's "folder-first rows" line asks for. */
export function sortedRows(fileRows: readonly FileRow[]): FileRow[] {
  return [...fileRows].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return fileName(a.path).localeCompare(fileName(b.path));
  });
}

interface FilesFetchState {
  readonly value: { files: FileRow[] } | null;
  readonly problem: string | null;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
  readonly setProblem: (problem: string | null) => void;
}

/**
 * Deliberately its own hook rather than a reuse of the shared `useJson` above: a folder switch
 * must show the "Loading…" state again rather than the previous folder's rows sitting there stale
 * until the new response lands, which is what `useJson`'s "keep the last value until the next one
 * arrives" behaviour (fine for a page that never re-points its own URL) would otherwise do here.
 */
function useFilesState(path: string): FilesFetchState {
  const [value, setValue] = useState<{ files: FileRow[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setProblem(null);
    const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(problemMessage(body, response.status));
    setValue({ files: toFileRows(body) });
  }, [path]);
  useEffect(() => {
    setValue(null);
    void reload().catch((error: unknown) =>
      setProblem(error instanceof Error ? error.message : String(error)),
    );
  }, [reload]);
  return { value, problem, loading: value === null && problem === null, reload, setProblem };
}

/** The current folder, deep-linked through `?path=` (see this section's header), plus its listing. */
function useFileBrowser() {
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
  const state = useFilesState(path);
  return { path, navigateTo, state };
}

export function Breadcrumbs({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (path: string) => void;
}) {
  const crumbs = breadcrumbSegments(path);
  return (
    <nav aria-label="Folder breadcrumb" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <button
        className={path === '' ? 'font-semibold text-text' : 'text-accent underline'}
        onClick={() => onNavigate('')}
        type="button"
      >
        Home
      </button>
      {crumbs.map((crumb, index) => (
        <span className="flex items-center gap-2" key={crumb.path}>
          <span aria-hidden="true">/</span>
          <button
            className={
              index === crumbs.length - 1 ? 'font-semibold text-text' : 'text-accent underline'
            }
            onClick={() => onNavigate(crumb.path)}
            type="button"
          >
            {crumb.name}
          </button>
        </span>
      ))}
      <button
        className={`${BUTTON} ml-auto`}
        disabled={path === ''}
        onClick={() => onNavigate(parentPath(path))}
        type="button"
      >
        Back
      </button>
    </nav>
  );
}

const TH =
  'border-b border-border bg-surface-2 px-4 py-[9px] text-left text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap text-muted uppercase';
const TD = 'border-b border-border px-4 py-[11px] align-middle';

interface FileTableRenameState {
  readonly id: string;
  readonly value: string;
}

interface FileTableProps {
  readonly rows: readonly FileRow[];
  readonly onNavigate: (path: string) => void;
  readonly onRenameStart?: (row: FileRow) => void;
  readonly onDelete?: (row: FileRow) => void;
  readonly renaming?: FileTableRenameState | null;
  readonly onRenameChange?: (value: string) => void;
  readonly onRenameSave?: (row: FileRow) => void;
  readonly onRenameCancel?: () => void;
  readonly selection?: {
    readonly selected: ReadonlySet<string>;
    readonly onToggle: (row: FileRow) => void;
  };
}

/**
 * The one row-rendering table shared by {@link FilesScreen} (full actions) and {@link FilePicker}
 * (checkboxes, for `#133`'s reuse) — folders open on click *and* on Enter for free, because each
 * is a real `<button>` rather than a `<div onClick>`, and Download is structurally absent from
 * every folder row rather than merely hidden by a condition a future edit could invert.
 */
export function FileTable({
  rows: fileRows,
  onNavigate,
  onRenameStart,
  onDelete,
  renaming,
  onRenameChange,
  onRenameSave,
  onRenameCancel,
  selection,
}: FileTableProps) {
  if (fileRows.length === 0) {
    return <p className="text-sm text-muted">This folder is empty.</p>;
  }
  const hasActions = onRenameStart !== undefined || onDelete !== undefined;
  const columnCount = 5 + (selection === undefined ? 0 : 1) + (hasActions ? 1 : 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {selection === undefined ? null : (
              <th className={TH}>
                <span className="sr-only">Select</span>
              </th>
            )}
            <th className={TH}>Name</th>
            <th className={TH}>Type</th>
            <th className={TH}>Size</th>
            <th className={TH}>Content type</th>
            <th className={TH}>Modified</th>
            {hasActions ? <th className={TH}>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {fileRows.map((row) => {
            const name = fileName(row.path);
            if (renaming != null && renaming.id === row.id) {
              return (
                <tr key={row.id}>
                  <td className={TD} colSpan={columnCount}>
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        onRenameSave?.(row);
                      }}
                    >
                      <label className="sr-only" htmlFor={`rename-${row.id}`}>
                        New path for {name}
                      </label>
                      <input
                        className={INPUT}
                        id={`rename-${row.id}`}
                        onChange={(event) => onRenameChange?.(event.target.value)}
                        value={renaming.value}
                      />
                      <button className={BUTTON} type="submit">
                        Save
                      </button>
                      <button className={BUTTON} onClick={onRenameCancel} type="button">
                        Cancel
                      </button>
                    </form>
                  </td>
                </tr>
              );
            }
            return (
              <tr className="hover:bg-surface-2" key={row.id}>
                {selection === undefined ? null : (
                  <td className={TD}>
                    <input
                      aria-label={`Select ${name}`}
                      checked={selection.selected.has(row.id)}
                      onChange={() => selection.onToggle(row)}
                      type="checkbox"
                    />
                  </td>
                )}
                <td className={TD}>
                  {row.kind === 'folder' ? (
                    <button
                      className="font-medium text-accent underline"
                      onClick={() => onNavigate(row.path)}
                      type="button"
                    >
                      {name}/
                    </button>
                  ) : (
                    name
                  )}
                </td>
                <td className={TD}>{row.kind}</td>
                <td className={TD}>{formatSize(row.sizeBytes)}</td>
                <td className={TD}>{row.contentType ?? '—'}</td>
                <td className={`${TD} whitespace-nowrap`}>{formatModified(row.lastModified)}</td>
                {hasActions ? (
                  <td className={`${TD} whitespace-nowrap`}>
                    <div className="flex gap-2">
                      {row.kind === 'file' ? (
                        <a className={BUTTON} href={`/api/files/${fileRouteId(row.path)}`}>
                          Download
                        </a>
                      ) : null}
                      {onRenameStart ? (
                        <button className={BUTTON} onClick={() => onRenameStart(row)} type="button">
                          Rename
                        </button>
                      ) : null}
                      {onDelete ? (
                        <button className={BUTTON} onClick={() => onDelete(row)} type="button">
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FilesScreen() {
  const browser = useFileBrowser();
  const [renaming, setRenaming] = useState<FileTableRenameState | null>(null);
  const fileRows = sortedRows(browser.state.value === null ? [] : browser.state.value.files);

  const createFolderFrom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const name = formString(new FormData(element), 'name').trim();
    if (name === '' || name.includes('/')) {
      browser.state.setProblem('A folder name is a single name, not a path.');
      return;
    }
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: resourcePathHeaders('x-folder-path', joinPath(browser.path, name)),
    });
    await checkedJson(response);
    element.reset();
    await browser.state.reload();
  };

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return;
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        ...resourcePathHeaders('x-file-path', joinPath(browser.path, file.name)),
      },
      body: file,
    });
    if (!response.ok) throw new Error(`Upload returned ${String(response.status)}.`);
    element.reset();
    await browser.state.reload();
  };

  const saveRename = async (row: FileRow) => {
    if (renaming === null) return;
    const newPath = renaming.value.trim();
    if (newPath === '' || newPath === row.path) {
      setRenaming(null);
      return;
    }
    try {
      const response = await fetch(`/api/files/${fileRouteId(row.path)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPath }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(problemMessage(body, response.status));
      // `PATCH` reports a subtree move as `200` with `{status:'partial'|'ok'}` rather than a
      // non-2xx status (`server/files/handlers.ts`'s `moveSubtree`) — `response.ok` alone cannot
      // tell "moved" from "moved some of it and stopped", so the body is inspected either way.
      if (body['status'] === 'partial') {
        throw new Error(
          `Move did not finish: ${String(body['moved'])} of ${String(body['total'])} items moved; the rest are still at the old location.`,
        );
      }
      setRenaming(null);
      await browser.state.reload();
    } catch (error) {
      browser.state.setProblem(error instanceof Error ? error.message : String(error));
      await browser.state.reload();
    }
  };

  const handleDelete = async (row: FileRow) => {
    const impact =
      row.kind === 'folder'
        ? `Delete "${fileName(row.path)}"? If it contains anything you will be asked to confirm removing it too.`
        : `Delete "${fileName(row.path)}"? This cannot be undone.`;
    if (!window.confirm(impact)) return;
    try {
      let response = await fetch(`/api/files/${fileRouteId(row.path)}`, { method: 'DELETE' });
      if (response.status === 409) {
        // Non-empty folder without `?recursive=true` (`server/files/handlers.ts`'s
        // `deleteSubtree`) — the confirmation states the descendant impact before retrying with
        // recursive semantics, rather than silently escalating or silently giving up.
        const conflict = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const code = (conflict['error'] as Record<string, unknown> | undefined)?.['code'];
        if (
          code !== 'folder_not_empty' ||
          !window.confirm(
            `"${fileName(row.path)}" is not empty. Delete it and everything inside it?`,
          )
        ) {
          throw new Error(problemMessage(conflict, response.status));
        }
        response = await fetch(`/api/files/${fileRouteId(row.path)}?recursive=true`, {
          method: 'DELETE',
        });
      }
      if (response.status !== 204) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) throw new Error(problemMessage(body, response.status));
        // Same `200` vs. body-status distinction as the rename path above, for `deleteSubtree`.
        if (body['status'] === 'partial') {
          const deleted = Array.isArray(body['deleted']) ? body['deleted'].length : 0;
          const remaining = Array.isArray(body['remaining']) ? body['remaining'].length : 0;
          throw new Error(
            `Delete did not finish: ${String(deleted)} removed, ${String(remaining)} still present. Try again.`,
          );
        }
      }
      await browser.state.reload();
    } catch (error) {
      browser.state.setProblem(error instanceof Error ? error.message : String(error));
      // Never remove the row optimistically: reload and let the server's own listing say what is
      // actually still there, which is what keeps a `partial` result from looking like success.
      await browser.state.reload();
    }
  };

  return (
    <>
      {title('Files', 'Browse workspace folders, upload inputs, and manage stored outputs.')}
      <Status problem={browser.state.problem} />
      <Breadcrumbs onNavigate={browser.navigateTo} path={browser.path} />
      {browser.state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          Loading files…
        </p>
      ) : null}
      <form
        className={`${CARD} mb-5 flex flex-wrap items-center gap-3`}
        onSubmit={(event) =>
          void upload(event).catch((error: unknown) =>
            browser.state.setProblem(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        <label className="flex flex-col gap-1 text-sm">
          Upload a file to this folder
          <input className={INPUT} name="file" required type="file" />
        </label>
        <button className={BUTTON} type="submit">
          Upload here
        </button>
        <p className="w-full text-sm text-muted">
          Agents see a file only after it is granted. Add{' '}
          <code>files(&apos;&lt;folder or file path&gt;&apos;)</code> to the agent&apos;s
          definition. Chat attachments are not supported yet.
        </p>
      </form>
      <form
        className={`${CARD} mb-5 flex flex-wrap items-center gap-3`}
        onSubmit={(event) =>
          void createFolderFrom(event).catch((error: unknown) =>
            browser.state.setProblem(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        <label className="flex flex-col gap-1 text-sm">
          New folder name
          <input className={INPUT} name="name" placeholder="reports" required />
        </label>
        <button className={BUTTON} type="submit">
          Create folder here
        </button>
      </form>
      {browser.state.value === null ? null : (
        <div className={CARD}>
          <FileTable
            onDelete={(row) => void handleDelete(row)}
            onNavigate={browser.navigateTo}
            onRenameCancel={() => setRenaming(null)}
            onRenameChange={(value) =>
              setRenaming((previous) => (previous === null ? previous : { ...previous, value }))
            }
            onRenameSave={(row) => void saveRename(row)}
            onRenameStart={(row) => setRenaming({ id: row.id, value: row.path })}
            renaming={renaming}
            rows={fileRows}
          />
        </div>
      )}
    </>
  );
}

/** One selected row, as {@link FilePicker} reports it — `id` is the stable catalog id `GET
 * /api/files` resolves every entry to (`apps/web/app/api/files/route.ts` syncs it from
 * `ResourceCatalogRepository.putFile` before responding), the same id an agent/project
 * resource-assignment form already keys its own selections by. */
export interface FilePickerSelection {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
}

/**
 * The reusable picker mode issue #132's card publishes for `#133` to adopt in W9.5 — not adopted
 * by any form in this task (declared gap G-3). Browsing is identical to {@link FilesScreen}; the
 * only difference is that a row is checked rather than acted on, and the current full selection is
 * reported to the caller on every change.
 */
export function FilePicker({
  onChange,
}: {
  readonly onChange: (selection: readonly FilePickerSelection[]) => void;
}) {
  const browser = useFileBrowser();
  const [selected, setSelected] = useState<readonly FilePickerSelection[]>([]);
  const fileRows = sortedRows(browser.state.value === null ? [] : browser.state.value.files);

  const toggle = (row: FileRow) => {
    const next = selected.some((entry) => entry.id === row.id)
      ? selected.filter((entry) => entry.id !== row.id)
      : [...selected, { id: row.id, path: row.path, kind: row.kind }];
    setSelected(next);
    onChange(next);
  };

  return (
    <>
      <Status problem={browser.state.problem} />
      <Breadcrumbs onNavigate={browser.navigateTo} path={browser.path} />
      {browser.state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          Loading files…
        </p>
      ) : null}
      {browser.state.value === null ? null : (
        <div className={CARD}>
          <FileTable
            onNavigate={browser.navigateTo}
            rows={fileRows}
            selection={{ selected: new Set(selected.map((entry) => entry.id)), onToggle: toggle }}
          />
        </div>
      )}
    </>
  );
}

export function SkillsScreen() {
  const state = useJson('/api/skills');
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const name = formString(form, 'name').trim();
    const description = formString(form, 'description').trim();
    const instructions = formString(form, 'instructions').trim();
    const source = updateSkillSource('', name, description, instructions);
    const response = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, files: [{ path: 'SKILL.md', contentBase64: base64(source) }] }),
    });
    await checkedJson(response);
    element.reset();
    await state.reload();
  };
  return (
    <>
      {title('Skills', 'Create and manage private workspace skills.')}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          Loading skills…
        </p>
      ) : null}
      <form
        className={`${CARD} mb-5 grid gap-3`}
        onSubmit={(event) =>
          void create(event).catch((error: unknown) =>
            state.setProblem(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        <input
          className={INPUT}
          name="name"
          pattern="[a-z0-9-]+"
          placeholder="skill-name"
          required
        />
        <input className={INPUT} name="description" placeholder="What this skill does" required />
        <textarea
          className={INPUT}
          name="instructions"
          placeholder="Instructions"
          required
          rows={4}
        />
        <button className={BUTTON} type="submit">
          Create skill
        </button>
      </form>
      <div className={CARD}>
        {rowsWithStrings(state.value, 'skills', 'name').map((skill) => (
          <div
            className="flex items-center gap-3 border-b border-border py-3 last:border-0"
            key={String(skill.name)}
          >
            <Link
              className="flex-1 text-sm font-medium text-accent"
              href={`/skills/${encodeURIComponent(String(skill.name))}`}
            >
              {String(skill.name)}
            </Link>
            <span className="text-xs text-muted">
              {skill['enabled'] === false ? 'Disabled' : 'Enabled'}
            </span>
          </div>
        ))}
        {state.value !== null && rows(state.value, 'skills').length === 0 ? (
          <p className="text-sm text-muted">No skills yet.</p>
        ) : null}
      </div>
    </>
  );
}

export function SkillDetailScreen({ name }: { name: string }) {
  const state = useJson(`/api/skills/${encodeURIComponent(name)}`);
  const skill = state.value?.['skill'];
  const detail =
    typeof skill === 'object' && skill !== null ? (skill as Record<string, unknown>) : null;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const enabled = form.get('enabled') === 'on';
    const description = formString(form, 'description').trim();
    const instructions = formString(form, 'instructions').trim();
    const source = updateSkillSource(display(detail?.['source']), name, description, instructions);
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled,
        files: [{ path: 'SKILL.md', contentBase64: base64(source) }],
      }),
    });
    await checkedJson(response);
    await state.reload();
  };
  return (
    <>
      {title(
        name,
        'Skill manifest and installed files.',
        <Link className={BUTTON} href="/skills">
          Back
        </Link>,
      )}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="text-sm text-muted" role="status">
          Loading skill…
        </p>
      ) : null}
      {detail === null ? null : (
        <form
          className={`${CARD} grid gap-3`}
          onSubmit={(event) =>
            void save(event).catch((error: unknown) =>
              state.setProblem(error instanceof Error ? error.message : String(error)),
            )
          }
        >
          <label className="grid gap-1 text-sm">
            Description
            <input
              className={INPUT}
              defaultValue={display(detail['description'])}
              name="description"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Instructions
            <textarea
              className={INPUT}
              defaultValue={display(detail['instructions'])}
              name="instructions"
              rows={10}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input defaultChecked={detail['enabled'] !== false} name="enabled" type="checkbox" />{' '}
            Enabled
          </label>
          <div className="text-xs text-muted">
            Supporting files:{' '}
            {Array.isArray(detail['files'])
              ? detail['files']
                  .map((file) =>
                    typeof file === 'object' && file !== null
                      ? display((file as Record<string, unknown>)['path'])
                      : '',
                  )
                  .filter(Boolean)
                  .join(', ')
              : 'none'}
          </div>
          <button className={BUTTON} type="submit">
            Save changes
          </button>
        </form>
      )}
    </>
  );
}

export function ConnectorsScreen() {
  const state = useJson('/api/connectors');
  const [probe, setProbe] = useState<string | null>(null);
  return (
    <>
      {title(
        'Connectors',
        'MCP servers available to workspace agents.',
        <Link className={BUTTON} href="/connectors/new">
          Add connector
        </Link>,
      )}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          Loading connectors…
        </p>
      ) : null}
      {probe ? (
        <p className="mb-4 text-sm text-muted" role="status">
          {probe}
        </p>
      ) : null}
      <div className={CARD}>
        {rowsWithStrings(state.value, 'connectors', 'id', 'name', 'transport').map((connector) => (
          <div
            className="flex items-center gap-3 border-b border-border py-3 last:border-0"
            key={String(connector.id)}
          >
            <span className="flex-1 text-sm">
              <b>{String(connector.name)}</b>
              <span className="ml-2 text-muted">{String(connector.transport)}</span>
            </span>
            <button
              className={BUTTON}
              onClick={() =>
                void fetch(`/api/connectors/${String(connector.id)}/test-connection`, {
                  method: 'POST',
                })
                  .then(checkedJson)
                  .then((body) =>
                    setProbe(
                      body['ok'] === true
                        ? `${String(connector.name)} connection passed.`
                        : `${String(connector.name)}: ${display(body['message']) || 'Connection failed.'}`,
                    ),
                  )
                  .catch((error: unknown) =>
                    state.setProblem(error instanceof Error ? error.message : String(error)),
                  )
              }
              type="button"
            >
              Test
            </button>
            <button
              className={BUTTON}
              onClick={() => {
                if (window.confirm(`Delete connector ${String(connector.name)}?`))
                  deleteThenReload(
                    state,
                    `/api/connectors/${encodeURIComponent(String(connector.id))}`,
                  );
              }}
              type="button"
            >
              Delete
            </button>
          </div>
        ))}
        {state.value !== null && rows(state.value, 'connectors').length === 0 ? (
          <p className="text-sm text-muted">No connectors yet.</p>
        ) : null}
      </div>
    </>
  );
}

export function ConnectorNewScreen() {
  const [message, setMessage] = useState<string | null>(null);
  const [authType, setAuthType] = useState('none');
  const submit = async (element: HTMLFormElement, dryRun: boolean) => {
    const form = new FormData(element);
    const transport = formString(form, 'transport');
    const endpoint = formString(form, 'endpoint').trim();
    const credential = formString(form, 'credential');
    const common = {
      name: formString(form, 'name').trim(),
      transport,
      authType,
      dryRun,
      ...(authType === 'none' ? {} : { credential }),
    };
    const body =
      transport === 'stdio'
        ? {
            ...common,
            command: endpoint,
            args: formString(form, 'args').split(/\s+/u).filter(Boolean),
          }
        : { ...common, url: endpoint };
    const response = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await checkedJson(response);
    if (dryRun)
      setMessage(
        result['ok'] === true
          ? 'Connection test passed.'
          : display(result['message']) || 'Connection test failed.',
      );
    else window.location.assign('/connectors');
  };
  return (
    <>
      {title(
        'Add connector',
        'Test the connection before saving it.',
        <Link className={BUTTON} href="/connectors">
          Cancel
        </Link>,
      )}
      <Status problem={message} />
      <form
        className={`${CARD} grid gap-3`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget, false).catch((error: unknown) =>
            setMessage(error instanceof Error ? error.message : String(error)),
          );
        }}
      >
        <input
          aria-label="Connector name"
          className={INPUT}
          name="name"
          placeholder="Connector name"
          required
        />
        <select aria-label="Transport" className={INPUT} name="transport">
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio</option>
        </select>
        <input
          aria-label="Endpoint"
          className={INPUT}
          name="endpoint"
          placeholder="URL or command"
          required
        />
        <input
          aria-label="stdio arguments"
          className={INPUT}
          name="args"
          placeholder="stdio arguments (optional)"
        />
        <select
          aria-label="Authentication"
          className={INPUT}
          name="authType"
          value={authType}
          onChange={(event) => setAuthType(event.target.value)}
        >
          <option value="none">No authentication</option>
          <option value="api-key">API key</option>
          <option value="bearer">Bearer token</option>
          <option value="oauth">OAuth token</option>
        </select>
        {authType === 'none' ? null : (
          <input
            {...CREDENTIAL_INPUT_PROPS}
            className={INPUT}
            aria-label="Credential"
            name="credential"
            placeholder="Credential (stored encrypted)"
            required
            type="password"
          />
        )}
        <div className="flex gap-3">
          <button
            className={BUTTON}
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (form)
                void submit(form, true).catch((error: unknown) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                );
            }}
            type="button"
          >
            Test connection
          </button>
          <button className={BUTTON} type="submit">
            Save
          </button>
        </div>
      </form>
    </>
  );
}

// `UsersScreen` used to live here: a `POST /api/users` form above a list of names and addresses
// read from `GET /api/users`. Issue #185 replaced it with `../team/team-screen.tsx`, which lists
// `GET /api/memberships` — roles, the current-user marker and the join date included — and manages
// members through the landed `PATCH`/`DELETE` on that resource. `POST /api/users` is untouched and
// keeps its route; what it lost is its only browser control, because issue #122 calls that form
// misleading (it implies immediate access is a safe invitation flow) and the invitation UI is the
// next step of this wave.

/**
 * The role dropdown of the API Keys form. A key's role is capped at the caller's role
 * (`conferRole`: an admin may confer admin and viewer, an owner may confer every role), so `owner`
 * is offered only to a signed-in owner; anyone else would be refused with a 403.
 */
export function ApiKeyRoleSelect({ callerRole }: { callerRole: unknown }) {
  return (
    <select className={INPUT} name="role">
      <option value="viewer">Viewer</option>
      <option value="builder">Builder</option>
      <option value="admin">Admin</option>
      {callerRole === 'owner' ? <option value="owner">Owner</option> : null}
    </select>
  );
}

/**
 * One API key. A revoked key says so in place of the Revoke button (BH061-035): a disabled button
 * looked the same as a live one, so every `aw dev` start's revoked key read as still active.
 */
export function ApiKeyRow(props: {
  name: string;
  prefix: unknown;
  revoked: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-3 text-sm last:border-0">
      <span className={`flex-1 ${props.revoked ? 'text-muted' : ''}`}>
        <b>{props.name}</b> <span className="text-muted">{display(props.prefix)}</span>
      </span>
      {props.revoked ? (
        <span className="text-muted">Revoked</span>
      ) : (
        <button className={BUTTON} onClick={props.onRevoke} type="button">
          Revoke
        </button>
      )}
    </div>
  );
}

export function ApiKeysScreen() {
  const state = useJson('/api/api-keys');
  const me = useJson('/api/me');
  const [presented, setPresented] = useState<string | null>(null);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const response = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: form.get('name'), role: form.get('role'), expiresAt: null }),
    });
    const body = (await response.json()) as { key?: unknown };
    if (!response.ok || typeof body.key !== 'string')
      throw new Error(`Create key returned ${String(response.status)}.`);
    setPresented(body.key);
    element.reset();
    await state.reload();
  };
  return (
    <>
      {title('API Keys', 'Create scoped credentials; plaintext is shown exactly once.')}
      <Status problem={state.problem} />
      {presented ? (
        <div className={`${CARD} mb-5 border-warning`} role="status">
          <b>Copy this key now</b>
          <code className="mt-2 block break-all">{presented}</code>
        </div>
      ) : null}
      <form
        className={`${CARD} mb-5 flex gap-3`}
        onSubmit={(event) =>
          void create(event).catch((error: unknown) =>
            state.setProblem(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        <input className={INPUT} name="name" placeholder="Key name" required />
        <ApiKeyRoleSelect callerRole={me.value?.['role']} />
        <button className={BUTTON}>Create key</button>
      </form>
      <div className={CARD}>
        {rowsWithStrings(state.value, 'apiKeys', 'id', 'name').map((key) => (
          <ApiKeyRow
            key={key.id}
            name={key.name}
            prefix={key['prefix']}
            revoked={key['revokedAt'] != null}
            onRevoke={() => deleteThenReload(state, `/api/api-keys/${encodeURIComponent(key.id)}`)}
          />
        ))}
      </div>
    </>
  );
}

export function SettingsScreen() {
  const endpoints = ['/api/files', '/api/skills', '/api/connectors', '/api/users', '/api/api-keys'];
  const [statuses, setStatuses] = useState<Record<string, number>>({});
  useEffect(() => {
    void Promise.all(
      endpoints.map(
        async (endpoint) =>
          [endpoint, (await fetch(endpoint, { cache: 'no-store' })).status] as const,
      ),
    ).then((entries) => setStatuses(Object.fromEntries(entries)));
  }, []);
  return (
    <>
      {title(
        'Settings',
        'Deployment subsystem status. Secrets and agent configuration stay out of this page.',
      )}
      <div className={CARD}>
        {endpoints.map((endpoint) => (
          <div className="flex border-b border-border py-3 text-sm last:border-0" key={endpoint}>
            <code className="flex-1">{endpoint}</code>
            <span className={statuses[endpoint] === 200 ? 'text-ok' : 'text-danger'}>
              {statuses[endpoint] ?? '…'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
