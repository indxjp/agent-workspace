'use client';

import type { VersionsLocale } from '../agents/versions-messages';
import { ENGLISH_FILES_STRINGS, type FilesStrings } from './files-messages';

/** Resolve URL folder paths within the workspace, clamping parent traversal at the root.
 * Invalid percent encoding remains literal. The server independently validates storage keys.
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

export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * The folders a rename can move a row into without typing (UX-27 in #2086): Home, every folder on
 * the breadcrumb, the open folder and its subfolders. These are only the folders the screen
 * already knows; a typed path still reaches any other. A folder being moved is not offered as its
 * own destination (the listed folders are its siblings and ancestors, never its descendants).
 */
export function moveFolderChoices(
  path: string,
  rows: readonly FileRow[],
  moving: string,
): string[] {
  const known = [
    '',
    ...breadcrumbSegments(path).map((crumb) => crumb.path),
    ...rows.filter((row) => row.kind === 'folder').map((row) => row.path),
  ];
  return [...new Set(known)].filter((folder) => folder !== moving);
}

/** `path` with its folder part replaced by `folder`, keeping the name; an empty name keeps `name`. */
export function moveInto(folder: string, path: string, name: string): string {
  const typed = fileName(path.trim());
  return joinPath(folder, typed === '' ? name : typed);
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
 * `lastModified` in the reader's language and in their own time zone, with the zone named, so a
 * Tokyo reader sees `2026年9月11日 19:15 JST` rather than a UTC time (UX-15 in #2086). The rows are
 * loaded in the browser after the page mounts, so the server never renders this and the browser's
 * zone cannot cause a hydration mismatch. `timeZone` is the browser's own unless a test pins one.
 */
export function formatModified(
  iso: string | null,
  locale: VersionsLocale = 'en',
  timeZone?: string,
): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
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

/**
 * What an empty listing of `path` means, read from its parent's rows. `GET /api/files` answers an
 * empty list for a folder that does not exist exactly as for an empty one, so a deep link to a
 * moved folder, or to a file, said "This folder is empty." (UX-20 in #2086).
 */
export function emptyFolderText(
  path: string,
  parentRows: readonly { readonly path: string; readonly kind: 'file' | 'folder' }[],
  words: FilesStrings = ENGLISH_FILES_STRINGS,
): string {
  const row = parentRows.find((candidate) => candidate.path === path);
  if (row?.kind === 'folder') return words.emptyFolder;
  if (row?.kind === 'file') return words.isAFile(path);
  return words.noSuchFolder(path);
}
