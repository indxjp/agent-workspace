import {
  CreateWebhookResponseSchema,
  WebhookListResponseSchema,
  type CreateWebhookRequest,
  type CreateWebhookResponse,
  type WebhookEndpoint,
  type WebhookEventType,
} from '@indx-workspace/contracts/webhooks';
import { z } from 'zod';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/** What a caller supplies to `create`: the request body, with `events` accepted read-only. */
export type CreateWebhookInput = Omit<CreateWebhookRequest, 'events'> & {
  readonly events?: readonly WebhookEventType[];
};

/**
 * `/api/webhooks` — issue #250 (N-3), ADR-SDK-18-N3-250, spec §5.17. A webhook is an endpoint the
 * platform posts a signed `WebhookEvent` to when one of the workspace's runs reaches a terminal
 * status. A workspace holds at most ten, so the list is unpaginated, and there is no update: to
 * change one, remove it and create another. Every route is Owner/Admin and belongs to the `runs`
 * feature. A receiver checks a delivery with `verifyWebhookSignature`, which makes no request.
 *
 * Problem codes: `400 invalid_webhook_url`, `400 webhook_url_refused` (the egress policy refused
 * the host), `400 invalid_webhook_id`, `404 webhook_not_found` (also for another workspace's id),
 * `409 webhook_limit_reached`, `503 webhook_api_not_configured` (no secrets service).
 */
export class WebhooksClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every webhook of the workspace (at most ten). No secret is in the answer. */
  public async list(options: RequestOptions = {}): Promise<readonly WebhookEndpoint[]> {
    const response = await this.#http.json({
      operation: 'webhooks.list',
      method: 'GET',
      path: '/api/webhooks',
      expect: [200],
      schema: WebhookListResponseSchema,
      signal: options.signal,
    });
    return response.webhooks;
  }

  /**
   * Register an endpoint. `events` defaults to all three terminal events. `secret` (`whsec_…`) in
   * the answer is the signing secret, and this is the only time it is returned: store it now.
   * `400 webhook_url_refused` when the platform's egress policy refuses the host, and
   * `409 webhook_limit_reached` at ten webhooks.
   */
  public create(
    input: CreateWebhookInput,
    options: RequestOptions = {},
  ): Promise<CreateWebhookResponse> {
    return this.#http.json({
      operation: 'webhooks.create',
      method: 'POST',
      path: '/api/webhooks',
      body: input,
      expect: [201],
      schema: CreateWebhookResponseSchema,
      signal: options.signal,
    });
  }

  /** Delete the webhook and its signing secret; deliveries not yet sent go with it. */
  public async remove(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'webhooks.remove',
      method: 'DELETE',
      path: `/api/webhooks/${segment(id)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}
