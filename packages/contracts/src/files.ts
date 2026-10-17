import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

export const RESOURCE_PATH_ENCODING_HEADER = 'x-resource-path-encoding';
export const RESOURCE_PATH_ENCODING_PERCENT_UTF8 = 'percent-utf8';

export type ResourcePathHeaderName = 'x-file-path' | 'x-folder-path';

export type DecodedResourcePathHeader =
  | { ok: true; value: string | null }
  | { ok: false; code: 'unsupported_path_encoding' | 'invalid_path_encoding' };

/**
 * Browser `Headers` values are limited to byte strings. Percent-encoding keeps every UTF-8 file
 * name ASCII-only without changing the raw upload body or making legacy ASCII clients invalid.
 */
export function resourcePathHeaders(
  name: ResourcePathHeaderName,
  path: string,
): Record<string, string> {
  return {
    [name]: encodeURIComponent(path),
    [RESOURCE_PATH_ENCODING_HEADER]: RESOURCE_PATH_ENCODING_PERCENT_UTF8,
  };
}

/** Decode only requests that explicitly opt in; unmarked callers retain the legacy raw value. */
export function decodeResourcePathHeader(
  value: string | null,
  encoding: string | null,
): DecodedResourcePathHeader {
  if (encoding === null) return { ok: true, value };
  if (encoding !== RESOURCE_PATH_ENCODING_PERCENT_UTF8) {
    return { ok: false, code: 'unsupported_path_encoding' };
  }
  if (value === null) return { ok: true, value: null };
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false, code: 'invalid_path_encoding' };
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The `:id` segment `/api/files/:id` accepts for a workspace-relative path: its UTF-8 bytes,
 * base64url-encoded without padding. The server mints ids this way (not by percent-encoding) so
 * that a path's `/` can never be mistaken for a URL segment boundary by any router in front of
 * it. The `id` field of a {@link FileResource} is *not* this value once a catalog is configured —
 * it is the catalog row's id — so a client addresses `/api/files/:id` by path, through this
 * function, and treats `id` as opaque.
 */
export function fileRouteId(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64URL_ALPHABET.charAt((triple >> 18) & 63);
    encoded += BASE64URL_ALPHABET.charAt((triple >> 12) & 63);
    if (second !== undefined) encoded += BASE64URL_ALPHABET.charAt((triple >> 6) & 63);
    if (third !== undefined) encoded += BASE64URL_ALPHABET.charAt(triple & 63);
  }
  return encoded;
}

export const FILE_KINDS = ['file', 'folder'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * The most bytes one `POST /api/files` upload may carry; a larger body is a `413`
 * `request_body_too_large`, refused while it streams.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * The largest folder subtree one `PATCH`/`DELETE /api/files/:id` acts on; a bigger one is a
 * `413` `subtree_too_large`, never a partial walk.
 */
export const MAX_SUBTREE_OBJECTS = 500;

/**
 * Problem codes the files routes own, with the status each one travels under. The common
 * vocabulary (`malformed_body`, `request_body_too_large`, `unsupported_media_type`, …) is
 * `COMMON_PROBLEM_CODES` at the package root.
 */
export const FILES_PROBLEM_CODES = {
  /** A `path` query, `x-file-path`, `x-folder-path` or `newPath` that `key-safety` refuses. */
  invalid_path: 400,
  /** `.claude/**` (runner state) or the internal empty-folder marker name. */
  reserved_path: 400,
  missing_file_path: 400,
  unsupported_path_encoding: 400,
  invalid_path_encoding: 400,
  /** Also the answer for an id the route never minted (never a `400`). */
  file_not_found: 404,
  name_conflict: 409,
  /** A folder moved into itself or one of its descendants. */
  self_descendant: 409,
  /** `DELETE` on a non-empty folder without `?recursive=true`. */
  folder_not_empty: 409,
  subtree_too_large: 413,
  store_inconsistent: 500,
  rename_inconsistent: 500,
  files_runtime_not_configured: 503,
} as const;

export type FilesProblemCode = keyof typeof FILES_PROBLEM_CODES;

/**
 * One file or folder as every files route renders it. `path` is workspace-relative with forward
 * slashes and is the value a client addresses the resource by (see {@link fileRouteId}); `id` is
 * opaque. A folder has `null` size, content type and modification time.
 */
export const FileResourceSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(FILE_KINDS),
    sizeBytes: z.number().int().nonnegative().nullable(),
    /** The uploader's declared type, or `null` when the upload carried none. */
    contentType: z.string().nullable(),
    lastModified: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .readonly();

export type FileResource = z.infer<typeof FileResourceSchema>;

/**
 * The `201` of `POST /api/files`, the `200` of `PATCH /api/files/:id` for a single file, and the
 * `200` of `GET /api/files/:id` when the path names a folder rather than bytes.
 */
export const FileResponseSchema = z.object({ file: FileResourceSchema }).strict().readonly();

export type FileResponse = z.infer<typeof FileResponseSchema>;

/** The body of `GET /api/files?path=`: every entry one level under `path`, unpaginated. */
export const FileListResponseSchema = z
  .object({ files: z.array(FileResourceSchema).readonly() })
  .strict()
  .readonly();

export type FileListResponse = z.infer<typeof FileListResponseSchema>;

/** The body of `PATCH /api/files/:id`. */
export interface MoveFileInput {
  readonly newPath: string;
}

/**
 * The `200` of `PATCH /api/files/:id` when the path names a folder. A `partial` outcome is a
 * declared state, not an error: every object was copied but `moved` of `total` originals could
 * be removed (`remaining` lists the leftovers), or the copy itself stopped at `moved`. Retrying
 * the same move converges — an already-copied object is not a collision.
 */
export const SubtreeMoveOutcomeSchema = z
  .discriminatedUnion('status', [
    z
      .object({ status: z.literal('ok'), moved: z.number().int().nonnegative() })
      .strict()
      .readonly(),
    z
      .object({
        status: z.literal('partial'),
        moved: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        remaining: z.array(z.string().min(1)).readonly().optional(),
      })
      .strict()
      .readonly(),
  ])
  .readonly();

export type SubtreeMoveOutcome = z.infer<typeof SubtreeMoveOutcomeSchema>;

/** The `200` of `PATCH /api/files/:id`: `{ file }` for a file, a subtree outcome for a folder. */
export const MoveFileResponseSchema = z.union([FileResponseSchema, SubtreeMoveOutcomeSchema]);

export type MoveFileResponse = z.infer<typeof MoveFileResponseSchema>;

/**
 * The `200` of `DELETE /api/files/:id` when the path names a folder — with contents, or one
 * created empty (its `deleted` list then names the store's folder marker). A `partial` outcome
 * lists what is still there. A plain file and a path with nothing at or under it answer `204`
 * with no body instead.
 */
export const SubtreeDeleteOutcomeSchema = z
  .discriminatedUnion('status', [
    z
      .object({ status: z.literal('ok'), deleted: z.array(z.string().min(1)).readonly() })
      .strict()
      .readonly(),
    z
      .object({
        status: z.literal('partial'),
        deleted: z.array(z.string().min(1)).readonly(),
        remaining: z.array(z.string().min(1)).readonly(),
      })
      .strict()
      .readonly(),
  ])
  .readonly();

export type SubtreeDeleteOutcome = z.infer<typeof SubtreeDeleteOutcomeSchema>;

/** The body of `DELETE /api/files/:id`: `null` for the `204`, an outcome for the `200`. */
export const RemoveFileResponseSchema = SubtreeDeleteOutcomeSchema.nullable();

export type RemoveFileResponse = z.infer<typeof RemoveFileResponseSchema>;
