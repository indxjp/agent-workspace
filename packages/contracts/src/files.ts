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
 * The most bytes one signed upload link may carry: the largest single S3 `PUT` (the storage
 * design, §04 "Size limits"). A deployment may set a lower limit; a mint above it is a `413`
 * `request_body_too_large`.
 */
export const SIGNED_UPLOAD_HARD_MAX_BYTES = 5 * 1024 ** 3;

/**
 * The largest folder subtree one `PATCH`/`DELETE /api/files/:id` acts on; a bigger one is a
 * `413` `subtree_too_large`, never a partial walk.
 */
export const MAX_SUBTREE_OBJECTS = 500;

/**
 * The most unfinished (pending) uploads one workspace may hold; a new signed upload link past it is
 * a `429` `too_many_pending_uploads` (the storage design, §05).
 */
export const MAX_PENDING_UPLOADS_PER_WORKSPACE = 100;

/**
 * Upload and download link requests one workspace may make per minute, per server; the next is a
 * `429` `link_rate_limited` with `Retry-After` (the storage design, §05).
 */
export const LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE = 60;

/**
 * Problem codes the files routes own, with the status each one travels under. The common
 * vocabulary (`malformed_body`, `request_body_too_large`, `unsupported_media_type`, …) is
 * `COMMON_PROBLEM_CODES` at the package root.
 */
export const FILES_PROBLEM_CODES = {
  /** A `path` query, `x-file-path`, `x-folder-path` or `newPath` that `key-safety` refuses. */
  invalid_path: 400,
  /** `.claude/**` (runner state), `skill-revisions/**` (immutable) or the internal empty-folder marker name. */
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
  /** A pending upload holds the path, or a path under the folder being moved, until it is confirmed. */
  upload_in_progress: 409,
  /** `POST /api/files/:id/upload-complete` found no object, a smaller one, or one over the limit (deleted). */
  upload_not_verified: 409,
  subtree_too_large: 413,
  /** The workspace holds {@link MAX_PENDING_UPLOADS_PER_WORKSPACE} unfinished uploads; no link is minted. */
  too_many_pending_uploads: 429,
  /** More than {@link LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE} link requests this minute; see `Retry-After`. */
  link_rate_limited: 429,
  store_inconsistent: 500,
  rename_inconsistent: 500,
  files_runtime_not_configured: 503,
  /** A `q` with no searchable term, an out-of-range `limit`, or an unknown search parameter. */
  invalid_search_query: 400,
  /** The search could not read the text cache or the object store; the cause is logged, not sent. */
  search_unavailable: 500,
  /** The configured object store cannot sign URLs (local filesystem, in-memory); use the relay routes. */
  direct_transfer_unsupported: 501,
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

/** The body of `PATCH /api/files/:id`. An unknown field is refused, not ignored. */
export const MoveFileRequestSchema = z
  .object({ newPath: z.string().min(1) })
  .strict()
  .readonly();

/** The body of `PATCH /api/files/:id`, as {@link MoveFileRequestSchema} parses it. */
export type MoveFileInput = z.infer<typeof MoveFileRequestSchema>;

/**
 * The `200` of `PATCH /api/files/:id` when the path names a folder. A `partial` outcome is a
 * declared state, not an error, and `phase` names the step that stopped: `copy` stopped after
 * `moved` of `total` objects; `catalog` copied every object but could not rewrite the catalog, so
 * every original is still in place (`remaining`); `delete` finished the move but could not remove
 * the originals in `remaining`. Retrying the same move after `copy` or `catalog` converges — an
 * already-copied object is not a collision. After `delete` the rows already sit at the
 * destination, so a retry answers `409` `name_conflict`: delete the keys in `remaining` instead.
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
        phase: z.enum(['copy', 'catalog', 'delete']).optional(),
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

/** The shortest, longest and default lifetime of a presigned URL, in seconds. */
export const PRESIGNED_URL_MIN_TTL_SECONDS = 60;
export const PRESIGNED_URL_MAX_TTL_SECONDS = 900;
export const PRESIGNED_URL_DEFAULT_TTL_SECONDS = 300;

const PresignedTtlSchema = z
  .number()
  .int()
  .min(PRESIGNED_URL_MIN_TTL_SECONDS)
  .max(PRESIGNED_URL_MAX_TTL_SECONDS);

/**
 * The body of `POST /api/files/:id/upload-urls`: what the holder is about to PUT. S3 and GCS sign
 * the declared type and length, so an upload that differs is refused by the store, not the control
 * plane; an Azure SAS binds no length, so Azure refuses to mint one for a `session` token. `sizeBytes` is bounded by {@link SIGNED_UPLOAD_HARD_MAX_BYTES}; the deployment's own limit may be lower.
 */
export const CreateUploadUrlRequestSchema = z
  .object({
    contentType: z.string().min(1).max(255).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(SIGNED_UPLOAD_HARD_MAX_BYTES),
    ttlSeconds: PresignedTtlSchema.optional(),
  })
  .strict()
  .readonly();

export type CreateUploadUrlRequest = z.infer<typeof CreateUploadUrlRequestSchema>;

/** The body of `POST /api/files/:id/download-urls`. */
export const CreateDownloadUrlRequestSchema = z
  .object({ ttlSeconds: PresignedTtlSchema.optional() })
  .strict()
  .readonly();

export type CreateDownloadUrlRequest = z.infer<typeof CreateDownloadUrlRequestSchema>;

/**
 * The `201` of both presign routes: a short-lived URL on the object store itself. The holder sends
 * `method` to `url` with exactly `headers` (every one is part of the signature) and the bytes as
 * the body; the control plane never sees them. `expiresAt` is when the store stops accepting it.
 */
export const PresignedUrlSchema = z
  .object({
    url: z.url({ protocol: /^https?$/u }),
    method: z.enum(['PUT', 'GET']),
    headers: z.record(z.string(), z.string()).readonly(),
    expiresAt: IsoDateTimeSchema,
    path: z.string().min(1),
  })
  .strict()
  .readonly();

export type PresignedUrl = z.infer<typeof PresignedUrlSchema>;

/** The longest `q` of `GET /api/files/search`, in characters after trimming. */
export const MAX_SEARCH_QUERY_CHARS = 256;

/** The most hits one `GET /api/files/search` returns; the default is {@link DEFAULT_SEARCH_LIMIT}. */
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * The query string of `GET /api/files/search`. Lexical search over the text of the files the
 * caller may read (ADR-0147): `q` is words, not an operator language.
 */
export const FileSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_CHARS),
    limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  })
  .strict()
  .readonly();

export type FileSearchQuery = z.input<typeof FileSearchQuerySchema>;

/**
 * One passage that matched. `page` is the PDF page or the 1-based sheet number of a workbook, and
 * `null` for a format with no pages. `snippet` is the text around the match, ready to quote;
 * `score` orders hits (larger is better) and means nothing across searches.
 */
export const FileSearchHitSchema = z
  .object({
    path: z.string().min(1),
    page: z.number().int().min(1).nullable(),
    snippet: z.string(),
    score: z.number().nonnegative(),
  })
  .strict()
  .readonly();

export type FileSearchHit = z.infer<typeof FileSearchHitSchema>;

/**
 * The `200` of `GET /api/files/search`. Text is extracted on demand, a bounded number of files per
 * request, so `pending` counts the in-scope files not yet searchable: when it is above zero the
 * answer is partial and the same request, repeated, continues the work.
 */
export const FileSearchResponseSchema = z
  .object({
    hits: z.array(FileSearchHitSchema).readonly(),
    pending: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export type FileSearchResponse = z.infer<typeof FileSearchResponseSchema>;
