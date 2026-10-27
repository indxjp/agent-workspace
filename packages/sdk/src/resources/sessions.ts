import {
  SessionListResponseSchema,
  SessionResponseSchema,
  transcriptSearchParams,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
  type SessionListQuery,
  type SessionListResponse,
  type SessionResource,
  type TranscriptEntry,
  type UpdateSessionPatch,
} from '@indx-workspace/contracts/sessions';

import {
  SurfaceAttachmentResponseSchema,
  type SurfaceAttachmentResponse,
} from '@indx-workspace/contracts/surfaces';

import { segment, type HttpClient, type RequestOptions } from '../http.js';
import { walkPages } from '../pagination.js';

/** `status`, `limit` (1–200; omitted for every remaining row) and a previous page's `nextCursor`. */
export type ListSessionsQuery = SessionListQuery;

/**
 * Where a transcript is stored. `projectKey` is the tenant key the transcript routes store
 * under — the caller's workspace id, also reported by {@link SessionsClient.list} as
 * `projectKey`. Issue #235 (S-21): omit it to default to the caller's own workspace key; the
 * server still refuses a *stated* key that is not the caller's (`403 project_key_mismatch`)
 * rather than silently storing under it.
 */
export interface TranscriptAddress {
  readonly projectKey?: string;
}

export interface ReadTranscriptOptions extends TranscriptAddress {
  /** A subagent transcript's key (`subagents/agent-<id>`); omit for the main transcript. */
  readonly subpath?: string;
}

/**
 * `GET /api/sessions/:engineSessionId/transcript` and `…/subkeys` — spec §20, §14.9.
 *
 * Both routes are keyed by the **engine's** session id (`SessionResource.engineSessionId`), not
 * the platform's `SessionResource.id`, because that is the key the runtime resumes by. Append and
 * delete are the runtime's own mirror and are deliberately not here.
 */
export class SessionTranscriptClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * The stored transcript, one provider-native entry per JSONL line, in append order. Empty for
   * a session that exists and has no turns yet; `404 transcript_not_found` for one never
   * written, and `409 session_archived` while the session is archived.
   */
  public async read(
    engineSessionId: string,
    address: ReadTranscriptOptions = {},
    options: RequestOptions = {},
  ): Promise<readonly TranscriptEntry[]> {
    const response = await this.#http.json({
      operation: 'sessions.transcript.read',
      method: 'GET',
      path: `/api/sessions/${segment(engineSessionId)}/transcript`,
      query: transcriptSearchParams(address),
      expect: [200],
      schema: TranscriptResponseSchema,
      signal: options.signal,
    });
    return response.entries;
  }

  /** The subagent transcripts stored under the session, each readable through `subpath`. */
  public async subkeys(
    engineSessionId: string,
    address: TranscriptAddress = {},
    options: RequestOptions = {},
  ): Promise<readonly string[]> {
    const response = await this.#http.json({
      operation: 'sessions.transcript.subkeys',
      method: 'GET',
      path: `/api/sessions/${segment(engineSessionId)}/subkeys`,
      query: transcriptSearchParams(address),
      expect: [200],
      schema: TranscriptSubkeysResponseSchema,
      signal: options.signal,
    });
    return response.subkeys;
  }
}

/** `/api/sessions/**` — spec §20. */
export class SessionsClient {
  readonly #http: HttpClient;
  public readonly transcript: SessionTranscriptClient;

  public constructor(http: HttpClient) {
    this.#http = http;
    this.transcript = new SessionTranscriptClient(http);
  }

  /**
   * One page of the sessions the caller may see, newest first by creation. Pass `nextCursor` back
   * as `cursor` for the next page; a cursor is bound to this list and this workspace.
   */
  public list(
    query: ListSessionsQuery = {},
    options: RequestOptions = {},
  ): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    return this.#http.json({
      operation: 'sessions.list',
      method: 'GET',
      path: '/api/sessions',
      query: params,
      expect: [200],
      schema: SessionListResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Every session the caller may see, one page request at a time: `for await (const session of
   * aw.sessions.listAll({ limit: 50 }))`. Stops after the page whose `nextCursor` is `null`.
   */
  public listAll(
    query: ListSessionsQuery = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SessionResource, void, undefined> {
    return walkPages('sessions.list', query.cursor, async (cursor) => {
      const page = await this.list(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        options,
      );
      return { items: page.sessions, nextCursor: page.nextCursor };
    });
  }

  public async get(sessionId: string, options: RequestOptions = {}): Promise<SessionResource> {
    const response = await this.#http.json({
      operation: 'sessions.get',
      method: 'GET',
      path: `/api/sessions/${segment(sessionId)}`,
      expect: [200],
      schema: SessionResponseSchema,
      signal: options.signal,
    });
    return response.session;
  }

  /** Rename, archive (`status: 'archived'`) or restore (`status: 'active'`) a session. */
  public async update(
    sessionId: string,
    patch: UpdateSessionPatch,
    options: RequestOptions = {},
  ): Promise<SessionResource> {
    const response = await this.#http.json({
      operation: 'sessions.update',
      method: 'PATCH',
      path: `/api/sessions/${segment(sessionId)}`,
      body: patch,
      expect: [200],
      schema: SessionResponseSchema,
      signal: options.signal,
    });
    return response.session;
  }

  /**
   * Hand one file to a session you may write to (`POST /api/sessions/:id/attachments`); the answer
   * names the catalogue row to send as `attachments: [{ fileId }]` on `runs.start`. The same
   * concealed `404 file_not_found` answers a session you may not write to and an archived project.
   */
  public attach(
    sessionId: string,
    file: File,
    options: RequestOptions = {},
  ): Promise<SurfaceAttachmentResponse> {
    return this.#http.json({
      operation: 'sessions.attach',
      method: 'POST',
      path: `/api/sessions/${segment(sessionId)}/attachments`,
      query: new URLSearchParams({ name: file.name }),
      rawBody: file,
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      expect: [201],
      schema: SurfaceAttachmentResponseSchema,
      signal: options.signal,
    });
  }
}
