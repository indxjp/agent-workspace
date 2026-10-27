import { isUuid } from '@indx-workspace/contracts';
import {
  StorageConnectionBrowseResponseSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
  type CreateStorageConnectionInput,
  type StorageConnectionBrowseResponse,
  type StorageConnectionCredential,
  type StorageConnectionResource,
  type StorageConnectionTestOutcome,
  type UpdateStorageConnectionPatch,
} from '@indx-workspace/contracts/storage-connections';

import { ApiProblemError } from '../errors.js';
import { segment, type HttpClient, type RequestOptions } from '../http.js';
import { walkPages } from '../pagination.js';

/** One file or folder of a browsed connection; `size` is set for a file. */
export type StorageConnectionBrowseEntry = StorageConnectionBrowseResponse['entries'][number];

export interface BrowseStorageOptions extends RequestOptions {
  /** The folder to list, inside the connection's allowed prefixes; omit it for the allowed prefixes. */
  readonly prefix?: string;
  /** Resume after a `next` this client was given earlier; `browse` follows `next` by itself. */
  readonly cursor?: string;
}

/**
 * `/api/storage-connections/**` — the storage design, §05. The credential goes in
 * (`create`, `rotateCredential`, `update`) and never comes out: every answer is a
 * {@link StorageConnectionResource}, which only says `hasCredential`.
 *
 * A refusal is an `ApiProblemError` whose `code` is one of `STORAGE_CONNECTION_PROBLEM_CODES`
 * (`storage_connection_not_found`, `…_name_taken`, `…_in_use`, `…_prefix_not_allowed`, …).
 */
export class StorageConnectionsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(options: RequestOptions = {}): Promise<readonly StorageConnectionResource[]> {
    const response = await this.#http.json({
      operation: 'storage.connections.list',
      method: 'GET',
      path: '/api/storage-connections',
      expect: [200],
      schema: StorageConnectionListResponseSchema,
      signal: options.signal,
    });
    return response.connections;
  }

  /**
   * By id (a UUID, one request) or by name (one `list` call). The server's `get` takes an id only
   * and a name is never UUID-shaped, so the two cannot be confused. An unknown name is the same
   * `404 storage_connection_not_found` the server answers for an unknown id.
   */
  public async get(
    idOrName: string,
    options: RequestOptions = {},
  ): Promise<StorageConnectionResource> {
    if (!isUuid(idOrName)) {
      const found = (await this.list(options)).find((connection) => connection.name === idOrName);
      if (found !== undefined) return found;
      throw new ApiProblemError({
        status: 404,
        problem: {
          code: 'storage_connection_not_found',
          message: 'The request was refused: storage_connection_not_found.',
        },
      });
    }
    return this.#http.json({
      operation: 'storage.connections.get',
      method: 'GET',
      path: `/api/storage-connections/${segment(idOrName)}`,
      expect: [200],
      schema: StorageConnectionResourceSchema,
      signal: options.signal,
    });
  }

  public create(
    input: CreateStorageConnectionInput,
    options: RequestOptions = {},
  ): Promise<StorageConnectionResource> {
    return this.#http.json({
      operation: 'storage.connections.create',
      method: 'POST',
      path: '/api/storage-connections',
      body: input,
      expect: [201],
      schema: StorageConnectionResourceSchema,
      signal: options.signal,
    });
  }

  /** Rename or reconfigure; a `url` that moves the connection needs a new `credential` with it. */
  public async update(
    id: string,
    patch: UpdateStorageConnectionPatch,
    options: RequestOptions = {},
  ): Promise<StorageConnectionResource> {
    return this.#http.json({
      operation: 'storage.connections.update',
      method: 'PATCH',
      path: `/api/storage-connections/${segment(id)}`,
      body: patch,
      expect: [200],
      schema: StorageConnectionResourceSchema,
      signal: options.signal,
    });
  }

  /** Delete the connection and its credential; `409 storage_connection_in_use` while an agent holds a grant. */
  public async remove(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.send({
      operation: 'storage.connections.delete',
      method: 'DELETE',
      path: `/api/storage-connections/${segment(id)}`,
      expect: [204],
      signal: options.signal,
    });
  }

  /** Replace the stored credential: the one write path to it after creation. */
  public async rotateCredential(
    id: string,
    credential: StorageConnectionCredential,
    options: RequestOptions = {},
  ): Promise<StorageConnectionResource> {
    return this.#http.json({
      operation: 'storage.connections.rotate',
      method: 'PUT',
      path: `/api/storage-connections/${segment(id)}/credential`,
      body: credential,
      expect: [200],
      schema: StorageConnectionResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Open the connection and list one entry of an allowed folder. A failed probe is still a `200`
   * carrying `{ ok: false, code }`, so it resolves rather than throws; only a missing connection
   * or a refused request is an `ApiProblemError`.
   */
  public async test(
    id: string,
    options: RequestOptions = {},
  ): Promise<StorageConnectionTestOutcome> {
    return this.#http.json({
      operation: 'storage.connections.test',
      method: 'POST',
      path: `/api/storage-connections/${segment(id)}/test`,
      expect: [200],
      schema: StorageConnectionTestOutcomeSchema,
      signal: options.signal,
    });
  }

  /**
   * Every entry of one folder, page after page until the server sends no `next`. Without a
   * `prefix` it yields the connection's allowed prefixes.
   */
  public async *browse(
    id: string,
    options: BrowseStorageOptions = {},
  ): AsyncGenerator<StorageConnectionBrowseEntry, void, undefined> {
    const { prefix, cursor, signal } = options;
    const base = `/api/storage-connections/${segment(id)}/browse`;
    yield* walkPages('storage.connections.browse', cursor, async (pageCursor) => {
      const query = [
        ...(prefix === undefined ? [] : [`prefix=${encodeURIComponent(prefix)}`]),
        ...(pageCursor === undefined ? [] : [`cursor=${encodeURIComponent(pageCursor)}`]),
      ].join('&');
      const page = await this.#http.json({
        operation: 'storage.connections.browse',
        method: 'GET',
        path: query === '' ? base : `${base}?${query}`,
        expect: [200],
        schema: StorageConnectionBrowseResponseSchema,
        signal,
      });
      return { items: page.entries, nextCursor: page.next ?? null };
    });
  }
}

/** `aw.storage` — the storage design, §05: connected buckets and folders. */
export class StorageClient {
  public readonly connections: StorageConnectionsClient;

  public constructor(http: HttpClient) {
    this.connections = new StorageConnectionsClient(http);
  }
}
