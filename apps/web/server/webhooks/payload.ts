/**
 * The signed body of one delivery (N-3, issue #250, ADR-SDK-18-N3-250 D3). Pure: a run as the run
 * read renders it and the delivery's own ids in, a contract-checked {@link WebhookEvent} out.
 *
 * The event carries the run's ids, status, error, usage, cost and `accountingState`, and never its
 * prompt, output or transcript: only the fields of `WebhookEventRunSchema` are copied, and the
 * schema is strict.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import {
  WebhookEventSchema,
  type WebhookEvent,
  type WebhookEventType,
} from '@indx-workspace/contracts/webhooks';

/** What of a delivery the envelope names. */
export interface WebhookEventDelivery {
  /** The delivery id: the event `id` and `webhook-id`, stable across retries. */
  readonly id: string;
  readonly workspaceId: string;
  readonly eventType: WebhookEventType;
  /** When the run stopped and the delivery was written. */
  readonly createdAt: Date;
}

export type WebhookEventOutcome =
  | { readonly ok: true; readonly event: WebhookEvent }
  | { readonly ok: false; readonly reason: 'run_mismatch' };

/**
 * The event `delivery` sends for `run`. `run_mismatch` when the run is not the one the delivery
 * names: another workspace, or a status other than the one the event type names.
 */
export function toWebhookEvent(
  run: RunResource,
  delivery: WebhookEventDelivery,
): WebhookEventOutcome {
  if (run.workspaceId !== delivery.workspaceId) return { ok: false, reason: 'run_mismatch' };
  const parsed = WebhookEventSchema.safeParse({
    id: delivery.id,
    type: delivery.eventType,
    createdAt: delivery.createdAt.toISOString(),
    workspaceId: delivery.workspaceId,
    data: {
      run: {
        id: run.id,
        agentId: run.agentId,
        sessionId: run.sessionId,
        status: run.status,
        endedAt: run.endedAt,
        error: run.error,
        usage: run.usage,
        cost: run.cost,
        accountingState: run.accountingState,
      },
    },
  });
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, reason: 'run_mismatch' };
}
