import { z } from 'zod';

import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { RunResourceSchema, type RunStatus, type TERMINAL_RUN_STATUSES } from './runs.js';

/**
 * Run-outcome webhooks (N-3, issue #250, ADR-SDK-18-N3-250, spec 04 §5.17): a workspace registers
 * an endpoint, and the platform posts it a signed {@link WebhookEvent} when one of the workspace's
 * runs reaches a terminal status. This module is the wire contract only. The outbox, the worker and
 * the egress check live in `packages/core` and `apps/web`.
 */

/** The events a webhook can subscribe to: one per terminal run status (ADR D1, D3). */
export const WEBHOOK_EVENT_TYPES = ['run.completed', 'run.failed', 'run.cancelled'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const EVENT_TYPE_OF_STATUS: Readonly<Partial<Record<RunStatus, WebhookEventType>>> = {
  completed: 'run.completed',
  failed: 'run.failed',
  cancelled: 'run.cancelled',
} satisfies Record<(typeof TERMINAL_RUN_STATUSES)[number], WebhookEventType>;

/**
 * The event a run's move to `status` emits: one per terminal status, and `null` for every other,
 * `awaiting_approval` included, because a paused run is stopped but not final (ADR D3).
 */
export function webhookEventTypeOf(status: RunStatus): WebhookEventType | null {
  return EVENT_TYPE_OF_STATUS[status] ?? null;
}

/** The most webhooks one workspace holds (ADR D1), which is why the list is unpaginated. */
export const WEBHOOK_MAX_PER_WORKSPACE = 10;

/** The longest webhook URL, in characters (ADR D5). */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

/** The prefix of a signing secret; the rest is the base64 of 32 random bytes (ADR D1). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** The Standard Webhooks v1 headers every delivery carries (ADR D2). */
export const WEBHOOK_SIGNATURE_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;

/** The version tag of one entry of `webhook-signature`: `v1,<base64 HMAC-SHA256>` (ADR D2). */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** How far a delivery's `webhook-timestamp` may be from the receiver's clock (ADR D2). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * The exact bytes a delivery's signature covers: `<webhook-id>.<webhook-timestamp>.<body>`, where
 * `body` is the request body as sent, never re-serialised (ADR D2).
 */
export function webhookSignedContent(id: string, timestamp: number | string, body: string): string {
  return `${id}.${String(timestamp)}.${body}`;
}

/** The hosts a plain-`http:` webhook URL may name: loopback only (ADR D5). */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/iu;

/**
 * Why `raw` is not an acceptable webhook URL, or `null`. An absolute `https:` URL of at most
 * {@link WEBHOOK_URL_MAX_LENGTH} characters with no userinfo and no fragment. An `http:` URL is
 * accepted here only for a loopback host, and the server's egress policy (W9-PROV-127) admits even
 * that only outside production (ADR D5). Whether the host is reachable is the egress policy's
 * question, not this one.
 */
export function webhookUrlViolation(raw: string): string | null {
  if (raw.length > WEBHOOK_URL_MAX_LENGTH) {
    return `must be at most ${String(WEBHOOK_URL_MAX_LENGTH)} characters`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOST.test(url.hostname)) return 'must use https';
  } else if (url.protocol !== 'https:') {
    return 'must use https';
  }
  if (url.username !== '' || url.password !== '') return 'must not carry credentials';
  if (raw.includes('#')) return 'must not carry a fragment';
  return null;
}

const WebhookUrlSchema = z
  .string()
  .min(1)
  .refine((raw) => webhookUrlViolation(raw) === null, {
    error: (issue) =>
      typeof issue.input === 'string'
        ? (webhookUrlViolation(issue.input) ?? 'invalid webhook URL')
        : 'invalid webhook URL',
  });

/** A non-empty set of event types, each named once. */
const WebhookEventTypesSchema = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1)
  .refine((types) => new Set(types).size === types.length, { error: 'must not repeat an event' });

/** One webhook as the list and the create answer render it. The secret is never part of it. */
export const WebhookEndpointSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    url: WebhookUrlSchema,
    events: WebhookEventTypesSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

/** `POST /api/webhooks`. `events` defaults to all three when omitted (ADR D1). */
export const CreateWebhookRequestSchema = z
  .object({
    url: WebhookUrlSchema,
    events: WebhookEventTypesSchema.optional(),
  })
  .strict()
  .readonly();

export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

/** A signing secret: `whsec_` and the base64 of exactly 32 bytes. */
export const WebhookSecretSchema = z
  .string()
  .regex(/^whsec_[A-Za-z0-9+/]{43}=$/u, 'must be whsec_ followed by 32 base64-encoded bytes');

/** The `201` of `POST /api/webhooks`: the only answer that ever carries the secret (ADR D1). */
export const CreateWebhookResponseSchema = z
  .object({ webhook: WebhookEndpointSchema, secret: WebhookSecretSchema })
  .strict()
  .readonly();

export type CreateWebhookResponse = z.infer<typeof CreateWebhookResponseSchema>;

/** `GET /api/webhooks`: unpaginated, because a workspace holds at most ten (spec §5.17). */
export const WebhookListResponseSchema = z
  .object({ webhooks: z.array(WebhookEndpointSchema).max(WEBHOOK_MAX_PER_WORKSPACE) })
  .strict()
  .readonly();

export type WebhookListResponse = z.infer<typeof WebhookListResponseSchema>;

/**
 * The run a {@link WebhookEvent} reports: a projection of the run read, so the two cannot drift.
 * The payload carries no prompt, output or transcript (ADR Consequences).
 */
export const WebhookEventRunSchema = RunResourceSchema.unwrap()
  .pick({
    id: true,
    agentId: true,
    sessionId: true,
    status: true,
    endedAt: true,
    error: true,
    usage: true,
    cost: true,
    accountingState: true,
  })
  .strict()
  .readonly();

/**
 * The signed envelope of one delivery (ADR D3). `id` is the delivery id, stable across retries and
 * equal to `webhook-id`; `createdAt` is when the run stopped. `data.run.status` is the terminal
 * status the `type` names.
 */
export const WebhookEventSchema = z
  .object({
    id: UuidSchema,
    type: z.enum(WEBHOOK_EVENT_TYPES),
    createdAt: IsoDateTimeSchema,
    workspaceId: UuidSchema,
    data: z.object({ run: WebhookEventRunSchema }).strict().readonly(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.type !== `run.${event.data.run.status}`) {
      context.addIssue({
        code: 'custom',
        path: ['data', 'run', 'status'],
        message: `must be the status ${event.type} names`,
      });
    }
  })
  .readonly();

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/**
 * Domain problem codes of the webhook routes, with the status each travels under (ADR D9). A
 * malformed body is the common `invalid_body`, and another workspace's id is `webhook_not_found`.
 */
export const WEBHOOK_PROBLEM_CODES = {
  invalid_webhook_url: 400,
  webhook_url_refused: 400,
  invalid_webhook_id: 400,
  webhook_not_found: 404,
  webhook_limit_reached: 409,
  webhook_api_not_configured: 503,
} as const;

export type WebhookProblemCode = keyof typeof WEBHOOK_PROBLEM_CODES;
