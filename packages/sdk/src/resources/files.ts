import {
  FileListResponseSchema,
  FileResponseSchema,
  MoveFileResponseSchema,
  RemoveFileResponseSchema,
  fileRouteId,
  resourcePathHeaders,
  type FileResource,
  type MoveFileInput,
  type MoveFileResponse,
  type RemoveFileResponse,
} from '@indx-workspace/contracts/files';

import { ContractViolationError } from '../errors.js';
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

/**
 * Every upload is sent as one `Blob`: a stream is buffered first, because a streaming request
 * body is not something every browser can send (and needs HTTP/2 where it can), while the server
 * buffers the whole body up to `MAX_UPLOAD_BYTES` before it acts anyway.
 */
async function uploadBlob(body: UploadBody): Promise<Blob> {
  if (body instanceof Blob) return body;
  if (body instanceof Uint8Array) return new Blob([new Uint8Array(body)]);
  return new Response(body).blob();
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

  /** Write (or overwrite) one file. The bytes are sent as-is; the path travels as a header. */
  public async upload(
    path: string,
    body: UploadBody,
    options: UploadFileOptions = {},
  ): Promise<FileResource> {
    const response = await this.#http.json({
      operation: 'files.upload',
      method: 'POST',
      path: '/api/files',
      rawBody: await uploadBlob(body),
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
   * Rename or move. A file answers `{ file }`; a folder answers a subtree outcome, and a
   * `partial` one is a declared state to retry, not a failure.
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
   * folder (even one created empty) answers what was deleted and, if `partial`, what remains.
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

  #path(path: string): string {
    return `/api/files/${segment(fileRouteId(path))}`;
  }
}
