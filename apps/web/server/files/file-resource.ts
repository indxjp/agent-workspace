import type { CatalogFile } from '../storage/store';
import { encodeFileId } from './file-id';

/** One file or folder, as the API represents it. `id` is what `/api/files/:id` takes. */
export interface FileResource {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly lastModified: string | null;
}

export function toResource(
  entry:
    | {
        readonly kind: 'file';
        readonly key: string;
        readonly sizeBytes: number;
        readonly contentType: string | null;
        readonly lastModified: Date;
      }
    | { readonly kind: 'folder'; readonly key: string },
): FileResource {
  return entry.kind === 'file'
    ? {
        id: encodeFileId(entry.key),
        path: entry.key,
        kind: 'file',
        sizeBytes: entry.sizeBytes,
        contentType: entry.contentType,
        lastModified: entry.lastModified.toISOString(),
      }
    : {
        id: encodeFileId(entry.key),
        path: entry.key,
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      };
}

/**
 * Every media type this route will name in a download response. A stored content type is looked up
 * in this table and the **table's own string** is returned; a type that is not in it becomes
 * `application/octet-stream`. That is the ADR-0015 shape — a positive assertion over a closed set,
 * with an explicit rejecting `else` — and it is deliberately not "reject the dangerous ones": a
 * blocklist of active types has to be complete to be safe, and `text/html`, `image/svg+xml`,
 * `application/xhtml+xml`, `text/xml` and `application/xml` are only the ones anyone remembers.
 *
 * Nothing here executes in a browsing context when it is served with `nosniff` and
 * `Content-Disposition: attachment`, which `http.ts` adds to every binary response. The three
 * defences are independent on purpose: any one of them alone closes the hole verification round 1
 * found, and none of them depends on this table being exhaustive.
 */
const DOWNLOADABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/octet-stream',
  'application/pdf',
  // The two office formats spec §16's own tree illustration names (`pricing.xlsx`,
  // `report-template.docx`).
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
]);

/** What this route serves as `Content-Type` for a stored object. See the table above. */
export function downloadContentType(stored: string | null): string {
  if (stored === null) return 'application/octet-stream';
  // Parse before comparing (ADR-0015): a stored value is a full header line, so strip any
  // parameters (`; charset=…`) and case-fold before the lookup rather than matching the raw text.
  const essence = stored.split(';')[0]?.trim().toLowerCase() ?? '';
  if (DOWNLOADABLE_CONTENT_TYPES.has(essence)) return essence;
  return 'application/octet-stream';
}
export function catalogResource(row: CatalogFile): FileResource {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    sizeBytes: row.kind === 'file' ? row.sizeBytes : null,
    contentType: row.kind === 'file' ? row.contentType : null,
    lastModified: row.kind === 'file' ? lastModifiedOf(row) : null,
  };
}

/** A file's `lastModified`: when its catalog row was last written. A folder answers none. */
export function lastModifiedOf(row: Pick<CatalogFile, 'updatedAt'>): string | null {
  return row.updatedAt?.toISOString() ?? null;
}

/**
 * `Content-Disposition` for a download, in the two-form shape RFC 6266 §4.3 specifies: a quoted
 * ASCII `filename` every client understands, and a `filename*` carrying the real name in
 * `UTF-8''`-percent-encoded form for the ones that do.
 *
 * The ASCII form is built from a positive character set — letters, digits and a short list of
 * punctuation — with everything else replaced, rather than by deleting the characters that would
 * break the quoting. A key is a caller-supplied string, so a name containing `"`, `\`, a newline or
 * a `;` must not be able to close the quoted string and add a header parameter of its own, and a
 * substitution that starts from what is *allowed* cannot miss a case the way one that starts from
 * what is forbidden can (ADR-0015).
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  // `filename` comes from a key that passed `key-safety.ts`, so it is never empty and has no `/`;
  // the fallback is here because this function must produce a well-formed header regardless.
  const quoted = ascii === '' ? 'download' : ascii;
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
