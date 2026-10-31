/**
 * The seam between the webhook domain (N-3, issue #250, ADR-SDK-18-N3-250) and the database layer:
 * the webhook repository of a workspace, the signing secrets kept in `SecretsService`, the egress
 * check a new URL must pass, and the delivery outbox the worker claims from. The same shape as
 * `triggers/runtime.ts`, for the same reason: only `store.ts` names `@agent-workspace/core/db`.
 *
 * The composition root installs the routes' half as `ApplicationContext.webhooks`. It is
 * `unavailable` on a deployment with no secrets service, because a secret the platform must sign
 * with cannot be stored there, and the routes then answer `503 webhook_api_not_configured`.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import type { WebhookEventType } from '@indx-workspace/contracts/webhooks';

/** A webhook as this domain reads it. The core repository satisfies it structurally. */
export interface WebhookRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly events: readonly WebhookEventType[];
  readonly createdAt: Date;
}

/** The webhooks of one workspace. Semantics are documented on the core repository. */
interface WebhookRepository {
  list(): Promise<readonly WebhookRecord[]>;
  get(id: string): Promise<WebhookRecord | null>;
  create(input: {
    readonly url: string;
    readonly events: readonly WebhookEventType[];
  }): Promise<
    | { readonly kind: 'created'; readonly webhook: WebhookRecord }
    | { readonly kind: 'limit-reached'; readonly limit: number }
  >;
  remove(id: string): Promise<boolean>;
}

/**
 * A webhook's signing secret, which the platform must use and so cannot hash: it lives in the
 * secrets service under a name derived from the webhook id (ADR D1), never in a row or a response
 * other than the create answer.
 */
export interface WebhookSigningSecrets {
  store(workspaceId: string, webhookId: string, secret: string): Promise<void>;
  remove(workspaceId: string, webhookId: string): Promise<void>;
  read(workspaceId: string, webhookId: string): Promise<string | null>;
}

/** The egress policy's answer for a URL: the host and the rule only, never the URL (ADR D5). */
type WebhookUrlCheck =
  { readonly ok: true } | { readonly ok: false; readonly host: string; readonly reason: string };

export interface WebhooksRuntime {
  /** The webhooks of `workspaceId`; another workspace's row is as absent as one never created. */
  repository(workspaceId: string): Promise<WebhookRepository>;
  readonly secrets: WebhookSigningSecrets;
  /** The deployment's egress policy (W9-PROV-127) applied to a URL about to be stored. */
  checkUrl(url: string): Promise<WebhookUrlCheck>;
}

/** The webhook routes as the application context holds them. */
export type Webhooks =
  | { readonly kind: 'serving'; readonly runtime: WebhooksRuntime }
  | { readonly kind: 'unavailable' };

/** One claimed delivery, as the core outbox returns it. */
export interface ClaimedWebhookDelivery {
  readonly id: string;
  readonly workspaceId: string;
  readonly webhookId: string;
  readonly runId: string;
  readonly eventType: WebhookEventType;
  readonly url: string;
  /** The attempt this claim is, counting from 1; every settle is guarded on it. */
  readonly attempt: number;
  readonly createdAt: Date;
}

/** A failed attempt as stored: the status code if there was one, and a short safe code. */
interface WebhookAttemptFailure {
  readonly statusCode: number | null;
  readonly error: string;
}

/** The delivery outbox. Semantics are documented on the core repository. */
export interface WebhookDeliveryOutbox {
  claimDue(input: {
    readonly limit: number;
    readonly claimMs: number;
    readonly maxAttempts: number;
  }): Promise<readonly ClaimedWebhookDelivery[]>;
  markDelivered(id: string, attempt: number, statusCode: number): Promise<boolean>;
  scheduleRetry(
    id: string,
    attempt: number,
    at: Date,
    failure: WebhookAttemptFailure,
  ): Promise<boolean>;
  markFailed(id: string, attempt: number, failure: WebhookAttemptFailure): Promise<boolean>;
  deferClaim(id: string, attempt: number, at: Date): Promise<boolean>;
  pruneSettled(before: Date): Promise<number>;
}

/** What the delivery worker reads besides the outbox. */
export interface WebhookDeliverySources {
  readonly outbox: WebhookDeliveryOutbox;
  /** The run as the run read renders it, scoped to `workspaceId`; `null` when it is gone. */
  readRun(workspaceId: string, runId: string): Promise<RunResource | null>;
  readonly secrets: Pick<WebhookSigningSecrets, 'read'>;
  readonly lease: {
    tryAcquire(name: string, ttlMs: number): Promise<null | { release(): Promise<void> }>;
  };
}
