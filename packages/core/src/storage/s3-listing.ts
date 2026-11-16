import { addressableObjectName } from './key-safety.js';
import type { ObjectListEntry } from './object-store.js';

/** The parts of a ListObjectsV2 answer a page is built from. */
export interface S3ListedPage {
  readonly CommonPrefixes?: readonly { readonly Prefix?: string | undefined }[] | undefined;
  readonly Contents?:
    | readonly {
        readonly Key?: string | undefined;
        readonly Size?: number | undefined;
        readonly LastModified?: Date | undefined;
      }[]
    | undefined;
  readonly IsTruncated?: boolean | undefined;
  readonly NextContinuationToken?: string | undefined;
}

/** A listed file before its content type is known. */
export interface FileRow {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

export function folderEntries(response: S3ListedPage, prefix: string): ObjectListEntry[] {
  const entries: ObjectListEntry[] = [];
  for (const folder of response.CommonPrefixes ?? []) {
    if (folder.Prefix === undefined) continue;
    const key = folder.Prefix.slice(prefix.length).replace(/\/$/u, '');
    if (addressableObjectName(key) === null) continue;
    entries.push({ kind: 'folder', key });
  }
  return entries;
}

export function fileRows(
  response: S3ListedPage,
  prefix: string,
  requestedPrefix: string,
): FileRow[] {
  const files: FileRow[] = [];
  for (const object of response.Contents ?? []) {
    if (object.Key === undefined || object.Key === requestedPrefix) continue;
    // Another tool's name (a console folder's `name/`): skip it before HEAD refuses it.
    if (addressableObjectName(object.Key.slice(prefix.length)) === null) continue;
    files.push({
      key: object.Key.slice(prefix.length),
      size: object.Size ?? 0,
      lastModified: object.LastModified ?? new Date(0),
    });
  }
  return files;
}

export function pageCursor(response: S3ListedPage): string | null {
  if (response.IsTruncated !== true) return null;
  const cursor = response.NextContinuationToken ?? null;
  if (cursor === null) {
    throw new Error('S3 returned a truncated listing without a continuation token.');
  }
  return cursor;
}
