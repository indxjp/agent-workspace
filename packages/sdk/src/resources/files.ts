import {
  MAX_UPLOAD_BYTES,
  FileListResponseSchema,
  FileSearchResponseSchema,
  FileResponseSchema,
  MoveFileResponseSchema,
  PresignedUrlSchema,
  RemoveFileResponseSchema,
  fileRouteId,
  resourcePathHeaders,
  type CreateDownloadUrlRequest,
  type CreateUploadUrlRequest,
  type FileResource,
  type FileSearchResponse,
  type MoveFileInput,
  type MoveFileResponse,
  type PresignedUrl,
  type RemoveFileResponse,
} from '@indx-workspace/contracts/files';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { segment, type HttpClient, type RequestOptions } from '../http.js';

export interface ListFilesQuery {
  /** A workspace-relative folder; omit for the root. One level only. */
  readonly path?: string;
}

/** What {@link FilesClient.upload} accepts as the file's content. */
export type UploadBody = Uint8Array | Blob | ReadableStream<Uint8Array>;

export interface UploadFileOptions extends RequestOptions {
  /**
   * Stored with the file and reported back as `contentType`. Omit to store `null` (a `Blob` with
   * a `type` of its own still declares it). Downloads never echo it as active content: the server
   * serves only a closed table of inert types, everything else as `application/octet-stream`.
   */
  readonly contentType?: string;
  /**
   * Always go through a signed link on the object store (mint, `PUT`, complete) instead of the
   * control plane, even for a small body, and fail with `501 direct_transfer_unsupported` where the
   * store cannot sign. Without it a body larger than `MAX_UPLOAD_BYTES` uses a signed link too, and
   * falls back to the relay when the store cannot sign.
   */
  readonly direct?: boolean;
  /**
   * The body's exact byte length, declared up front. With it a `ReadableStream` larger than
   * `MAX_UPLOAD_BYTES` (or any stream with `direct`) is streamed to the signed link instead of
   * being buffered first; the store refuses the `PUT` when the stream's length differs, and a store
   * that cannot sign links fails it with `501 direct_transfer_unsupported`. A streaming
   * request body needs a runtime that can send one (Node.js, or a browser over HTTP/2). For a `Blob`
   * or `Uint8Array` it must equal the body's own length.
   */
  readonly sizeBytes?: number;
}

export interface UploadUrlInput {
  /**
   * The exact byte length of the upload. S3 and GCS sign it, so they refuse a body of any other
   * length; an Azure Blob SAS cannot carry a length, so there it is not enforced.
   */
  readonly sizeBytes: number;
  /** Recorded with the object and required again as the `content-type` header of the `PUT`. */
  readonly contentType?: string;
  /** 60 to 900; the server's default (300) applies when omitted. */
  readonly ttlSeconds?: number;
}

export interface DownloadUrlInput {
  readonly ttlSeconds?: number;
}

export interface SearchFilesOptions extends RequestOptions {
  /** 1 to 50; the server's default (10) applies when omitted. */
  readonly limit?: number;
}

export interface RemoveFileOptions extends RequestOptions {
  /** Required to delete a folder that has contents (`409 folder_not_empty` otherwise). */
  readonly recursive?: boolean;
}

/**
 * What `GET /api/files/:id` answers. A path that names bytes is served as an attachment; a path
 * that names a folder is answered with the folder's metadata instead, and a caller that wants
 * bytes must branch on `kind`.
 */
export type FileDownload =
  | {
      readonly kind: 'file';
      readonly bytes: Uint8Array;
      /** The inert media type the server chose, never the uploader's text verbatim. */
      readonly contentType: string;
      /** The file's own name, from `Content-Disposition` (`filename*` first, then `filename`). */
      readonly filename: string;
    }
  | { readonly kind: 'folder'; readonly file: FileResource };

const OCTET_STREAM = 'application/octet-stream';

/** RFC 6266: prefer the UTF-8 `filename*` form, fall back to the quoted ASCII `filename`. */
export function filenameFromContentDisposition(header: string): string | null {
  const extended = /filename\*=UTF-8''([^;]+)/iu.exec(header);
  const encoded = extended?.[1]?.trim();
  if (encoded !== undefined && encoded !== '') {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed extended form is ignored in favour of the plain one, as browsers do.
    }
  }
  const quoted = /filename="([^"]*)"/iu.exec(header);
  const plain = quoted?.[1];
  return plain === undefined || plain === '' ? null : plain;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** The bytes themselves when they sit on an `ArrayBuffer`, a copy only off a shared buffer. */
function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return isArrayBufferBacked(bytes) ? bytes : new Uint8Array(bytes);
}

function isArrayBufferBacked(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

/** Refuse a declared size that is not a byte count, or that a sized body contradicts. */
function declaredSize(body: UploadBody, sizeBytes: number | undefined): number | undefined {
  if (sizeBytes === undefined) return undefined;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw new TypeError('upload sizeBytes must be a non-negative integer');
  const own =
    body instanceof Blob ? body.size : body instanceof Uint8Array ? body.byteLength : sizeBytes;
  if (own !== sizeBytes) throw new TypeError('upload sizeBytes differs from the body length');
  return sizeBytes;
}

/**
 * A relayed upload is sent as one `Blob`: a stream is buffered first, because a streaming request
 * body is not something every browser can send (and needs HTTP/2 where it can), while the server
 * buffers the whole body up to `MAX_UPLOAD_BYTES` before it acts anyway. A signed-link upload
 * (the storage design, §04) hands a `Blob` or `Uint8Array` to the store as it is, and a stream
 * of declared size as a stream.
 */
async function uploadBlob(body: UploadBody, signal?: AbortSignal): Promise<Blob> {
  if (body instanceof Blob) return body;
  if (body instanceof Uint8Array) return new Blob([arrayBufferBytes(body)]);
  // Buffering happens before any request, so `signal` must reach it: an abort cancels the source,
  // and `pipeTo` releases its lock on every outcome.
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  try {
    await body.pipeTo(
      new WritableStream({
        write(chunk: unknown) {
          // A plain JavaScript caller is not held to the type: a string chunk would become empty.
          if (!(chunk instanceof Uint8Array))
            throw new TypeError('upload body chunks must be Uint8Array');
          chunks.push(new Uint8Array(chunk));
        },
      }),
      signal === undefined ? {} : { signal },
    );
  } catch (cause) {
    throw new TransportError({
      operation: 'files.upload',
      aborted: signal?.aborted === true,
      cause,
    });
  }
  return new Blob(chunks);
}

function isDirectUnsupported(error: unknown): boolean {
  return (
    error instanceof ApiProblemError &&
    error.status === 501 &&
    error.code === 'direct_transfer_unsupported'
  );
}

/** Read the folder-metadata arm of a download, refusing anything else as drift. */
async function parseFolderBody(response: Response, operation: string): Promise<FileResource> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = FileResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ContractViolationError({
      operation,
      status: response.status,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`,
      ),
    });
  }
  return parsed.data.file;
}

/**
 * `/api/files/**` — spec §16. A file is addressed by its workspace-relative path everywhere in
 * this client; the route's `:id` is derived from it (`fileRouteId`), and a resource's `id` field
 * is opaque.
 */
export class FilesClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(
    query: ListFilesQuery = {},
    options: RequestOptions = {},
  ): Promise<readonly FileResource[]> {
    const params = new URLSearchParams();
    if (query.path !== undefined) params.set('path', query.path);
    const response = await this.#http.json({
      operation: 'files.list',
      method: 'GET',
      path: '/api/files',
      query: params,
      expect: [200],
      schema: FileListResponseSchema,
      signal: options.signal,
    });
    return response.files;
  }

  /**
   * Lexical search over the text of the workspace's files, best passage first. Text is extracted
   * on demand: while `pending` is above zero the answer is partial and repeating the call
   * continues the work.
   */
  public async search(
    query: string,
    options: SearchFilesOptions = {},
  ): Promise<FileSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return this.#http.json({
      operation: 'files.search',
      method: 'GET',
      path: '/api/files/search',
      query: params,
      expect: [200],
      schema: FileSearchResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Write (or overwrite) one file. Up to `MAX_UPLOAD_BYTES` the bytes are sent as-is through the
   * control plane, the path travelling as a header. A larger body, or `options.direct`, goes to the
   * object store on a signed link and is then completed (the storage design, §03 and §04); the
   * file is listed only once that finishes. A stream is buffered first unless `options.sizeBytes`
   * declares its length.
   */
  public async upload(
    path: string,
    body: UploadBody,
    options: UploadFileOptions = {},
  ): Promise<FileResource> {
    // @story US-STO-02
    const declared = declaredSize(body, options.sizeBytes);
    if (
      body instanceof ReadableStream &&
      declared !== undefined &&
      (options.direct === true || declared > MAX_UPLOAD_BYTES)
    ) {
      // No relay fallback: it would buffer the stream only to send the relay more than it accepts.
      return this.#uploadSigned(path, body, declared, options);
    }
    const content =
      body instanceof Blob || body instanceof Uint8Array
        ? body
        : await uploadBlob(body, options.signal);
    const size = content instanceof Blob ? content.size : content.byteLength;
    if (options.direct === true || size > MAX_UPLOAD_BYTES) {
      try {
        return await this.#uploadSigned(path, content, size, options);
      } catch (error) {
        if (!isDirectUnsupported(error) || options.direct === true) throw error;
      }
    }
    const response = await this.#http.json({
      operation: 'files.upload',
      method: 'POST',
      path: '/api/files',
      rawBody: await uploadBlob(content),
      headers: {
        ...resourcePathHeaders('x-file-path', path),
        ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
      },
      expect: [201],
      schema: FileResponseSchema,
      signal: options.signal,
    });
    return response.file;
  }

  /**
   * Finish a signed-link upload: the server checks the object the `PUT` wrote and marks the file
   * ready. `409 upload_not_verified` means no object, or a smaller one, is there yet.
   */
  public async completeUpload(path: string, options: RequestOptions = {}): Promise<FileResource> {
    const response = await this.#http.json({
      operation: 'files.completeUpload',
      method: 'POST',
      path: `${this.#path(path)}/upload-complete`,
      expect: [200],
      schema: FileResponseSchema,
      signal: options.signal,
    });
    return response.file;
  }

  /** Create an explicitly empty folder. A path that already exists is a `409 name_conflict`. */
  public async createFolder(path: string, options: RequestOptions = {}): Promise<FileResource> {
    const response = await this.#http.json({
      operation: 'files.createFolder',
      method: 'POST',
      path: '/api/files',
      headers: resourcePathHeaders('x-folder-path', path),
      expect: [201],
      schema: FileResponseSchema,
      signal: options.signal,
    });
    return response.file;
  }

  public async download(path: string, options: RequestOptions = {}): Promise<FileDownload> {
    const operation = 'files.download';
    const response = await this.#http.send({
      operation,
      method: 'GET',
      path: this.#path(path),
      expect: [200],
      signal: options.signal,
    });
    const disposition = response.headers.get('content-disposition');
    if (disposition === null) {
      // Only the bytes arm carries an attachment header; a folder answers its metadata as JSON.
      return { kind: 'folder', file: await parseFolderBody(response, operation) };
    }
    return {
      kind: 'file',
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? OCTET_STREAM,
      filename: filenameFromContentDisposition(disposition) ?? basename(path),
    };
  }

  /**
   * Rename or move. A file answers `{ file }`; a folder answers a subtree outcome. A `partial`
   * outcome is not thrown: the move stopped part-way (`phase` says where, `remaining` lists the
   * originals still in place), so check `status` and repeat the same call until it answers `ok`.
   * After `phase: 'delete'` the move itself is done and a retry answers `409`: delete the leftover
   * originals in `remaining` instead. `aw files move` exits 1 on it and prints `remaining` to stderr.
   */
  public async move(
    path: string,
    newPath: string,
    options: RequestOptions = {},
  ): Promise<MoveFileResponse> {
    const body: MoveFileInput = { newPath };
    return this.#http.json({
      operation: 'files.move',
      method: 'PATCH',
      path: this.#path(path),
      body,
      expect: [200],
      schema: MoveFileResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Delete a file or folder. `null` is the `204` — a file, or nothing there to begin with; a
   * folder (even one created empty) answers what was deleted and, if `partial`, what remains. A
   * `partial` outcome is not thrown: check `status` and repeat the same call to delete
   * `remaining`. `aw files remove` exits 1 on it and prints `remaining` to stderr.
   */
  public async remove(path: string, options: RemoveFileOptions = {}): Promise<RemoveFileResponse> {
    const params = new URLSearchParams();
    if (options.recursive === true) params.set('recursive', 'true');
    return this.#http.json({
      operation: 'files.remove',
      method: 'DELETE',
      path: this.#path(path),
      query: params,
      expect: [200, 204],
      schema: RemoveFileResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * A short-lived `PUT` URL on the object store, so the bytes never pass through the control plane.
   * `sizeBytes` is signed into the URL; send the returned `headers` with the `PUT`. A store that
   * cannot sign answers `501 direct_transfer_unsupported`: use {@link FilesClient.upload}.
   */
  public async createUploadUrl(
    path: string,
    input: UploadUrlInput,
    options: RequestOptions = {},
  ): Promise<PresignedUrl> {
    const body: CreateUploadUrlRequest = {
      sizeBytes: input.sizeBytes,
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    };
    return this.#http.json({
      operation: 'files.createUploadUrl',
      method: 'POST',
      path: `${this.#path(path)}/upload-urls`,
      body,
      expect: [201],
      schema: PresignedUrlSchema,
      signal: options.signal,
    });
  }

  /** A short-lived `GET` URL that serves the file as the inert attachment `download` returns. */
  public async createDownloadUrl(
    path: string,
    input: DownloadUrlInput = {},
    options: RequestOptions = {},
  ): Promise<PresignedUrl> {
    const body: CreateDownloadUrlRequest =
      input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds };
    return this.#http.json({
      operation: 'files.createDownloadUrl',
      method: 'POST',
      path: `${this.#path(path)}/download-urls`,
      body,
      expect: [201],
      schema: PresignedUrlSchema,
      signal: options.signal,
    });
  }

  async #uploadSigned(
    path: string,
    content: UploadBody,
    sizeBytes: number,
    options: UploadFileOptions,
  ): Promise<FileResource> {
    const declared = options.contentType ?? (content instanceof Blob ? content.type : '');
    const target = await this.createUploadUrl(
      path,
      { sizeBytes, ...(declared === '' ? {} : { contentType: declared }) },
      options,
    );
    await this.#http.putSigned({
      operation: 'files.upload',
      target,
      body: content instanceof Uint8Array ? arrayBufferBytes(content) : content,
      signal: options.signal,
    });
    return this.completeUpload(path, options);
  }

  #path(path: string): string {
    return `/api/files/${segment(fileRouteId(path))}`;
  }
}
