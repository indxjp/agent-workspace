import { z } from 'zod';

import { EngineIdSchema } from './engines.js';
import { IsoDateTimeSchema } from './identifiers.js';

export const SESSION_STATUSES = ['active', 'archived'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * One platform session as `GET /api/sessions/:id` and `PATCH /api/sessions/:id` render it, and as
 * each item of `GET /api/sessions` when the control plane has a session repository.
 *
 * `id` is the platform's own row id — the value `POST /api/agents/:id/runs` takes as `sessionId`.
 * `engineSessionId` is the *engine's* own session id, the key a resume is addressed by; it is
 * `null` until the first run reports it. `resumable` is derived: active, and known to the engine.
 *
 * The field carried the Claude Agent SDK's name before ADR-0065, when that SDK was the only
 * engine that could produce one. It is a rename, not a new field: the value is the same id, from
 * whichever engine ran the session.
 */
export const SessionResourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    /** Legacy human attribution; `null` for a session owned by an API-key principal. */
    userId: z.string().nullable(),
    ownerPrincipalId: z.string().min(1),
    projectId: z.string().nullable(),
    engineSessionId: z.string().nullable(),
    /**
     * Which engine produced {@link SessionResource.engineSessionId} — the harness that ran the
     * session, never the model provider. `null` until a run pins it, which is the same moment
     * `engineSessionId` is first reported: an id is reported *by* an engine, so the two are never
     * observed apart.
     */
    engine: EngineIdSchema.nullable(),
    title: z.string().nullable(),
    status: z.enum(SESSION_STATUSES),
    resumable: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type SessionResource = z.infer<typeof SessionResourceSchema>;

/** The body of `GET /api/sessions/:id` and `PATCH /api/sessions/:id`. */
export const SessionResponseSchema = z
  .object({ session: SessionResourceSchema })
  .strict()
  .readonly();

/** The largest page `GET /api/sessions?limit=` serves. */
export const SESSION_LIST_MAX_LIMIT = 200;

/**
 * The body of `GET /api/sessions`: newest first by creation, and an opaque cursor for the next
 * page (`null` on the last). `projectKey` is the tenant key the workspace's transcripts are stored
 * under; it is reported so a caller can address the transcript routes consistently.
 */
export const SessionListResponseSchema = z
  .object({
    sessions: z.array(SessionResourceSchema).readonly(),
    projectKey: z.string().min(1),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();

/**
 * The query `GET /api/sessions` accepts. `limit` is 1–{@link SESSION_LIST_MAX_LIMIT}; omitted, the
 * route answers every remaining row in one page. `cursor` is exactly the `nextCursor` of a
 * previous page, and is refused as `400 invalid_cursor` by any other list or workspace.
 */
export interface SessionListQuery {
  /** Omit for every session the caller may see, in either state. */
  readonly status?: SessionStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

/** The body of `PATCH /api/sessions/:id`. Both fields are optional; an empty patch is rejected. */
export interface UpdateSessionPatch {
  readonly title?: string | null;
  readonly status?: SessionStatus;
}

/**
 * The tenant key the transcript routes store under. It is the caller's workspace id by
 * construction (`GET /api/sessions` reports it as `projectKey`). Issue #235 (S-21): a transcript
 * request that omits `?projectKey=` is answered under the principal's own workspace key by
 * default; a request that *does* restate it is still parsed and still compared, and the server
 * refuses a key that disagrees with the principal's rather than silently storing under it — that
 * disagreement is how a misconfigured runtime is caught.
 */
export const PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A subagent transcript's key suffix, as the Claude Agent SDK writes it (`subagents/agent-<id>`):
 * one or more `[A-Za-z0-9][A-Za-z0-9_-]*` segments joined by `/`. The main transcript has no
 * subpath, and the empty string is refused rather than read as "none".
 */
export const TRANSCRIPT_SUBPATH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
export const TRANSCRIPT_SUBPATH_MAX_LENGTH = 128;

const TranscriptSubkeySchema = z
  .string()
  .min(1)
  .max(TRANSCRIPT_SUBPATH_MAX_LENGTH)
  .regex(TRANSCRIPT_SUBPATH_PATTERN);

/**
 * One transcript entry: a Claude Agent SDK JSONL line, stored and returned verbatim. The line
 * format is the provider's (`docs/sdk/04-api-specification.md` §6.1), so the contract says only
 * that each entry is one JSON value and gives it no shape of its own.
 */
export const TranscriptEntrySchema = z.unknown();

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

/**
 * The body of `GET /api/sessions/:engineSessionId/transcript`. `entries` is empty for a
 * session that exists and has no turns yet; a session that was never written is a `404`
 * `transcript_not_found`, and the two are deliberately different answers.
 */
export const TranscriptResponseSchema = z
  .object({ entries: z.array(TranscriptEntrySchema).readonly() })
  .strict()
  .readonly();

export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;

/**
 * The body of `GET /api/sessions/:providerSessionId/subkeys`: the `subpath`s stored under the
 * session, each addressable through `?subpath=` on the transcript route. Empty when only the
 * main transcript exists.
 */
export const TranscriptSubkeysResponseSchema = z
  .object({ subkeys: z.array(TranscriptSubkeySchema).readonly() })
  .strict()
  .readonly();

export type TranscriptSubkeysResponse = z.infer<typeof TranscriptSubkeysResponseSchema>;

/**
 * The query `GET …/transcript` and `GET …/subkeys` accept. Both fields are optional (issue #235,
 * S-21): an omitted `projectKey` defaults to the principal's own workspace key, and `subpath`
 * addresses a subagent transcript (`transcript` only; `subkeys` never takes one).
 */
export interface TranscriptQuery {
  readonly projectKey?: string;
  readonly subpath?: string;
}

/** Render a {@link TranscriptQuery} as the query string the route parses, omitting absent fields. */
export function transcriptSearchParams(query: TranscriptQuery): URLSearchParams {
  const params = new URLSearchParams();
  const entries: readonly (readonly [string, string | undefined])[] = [
    ['projectKey', query.projectKey],
    ['subpath', query.subpath],
  ];
  for (const [name, value] of entries) {
    if (value !== undefined) params.set(name, value);
  }
  return params;
}
