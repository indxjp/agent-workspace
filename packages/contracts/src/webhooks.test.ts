import { describe, expect, it } from 'vitest';

import { RUN_STATUSES, TERMINAL_RUN_STATUSES } from './runs.js';
import {
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_PROBLEM_CODES,
  WEBHOOK_SIGNATURE_HEADERS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WEBHOOK_URL_MAX_LENGTH,
  WebhookEndpointSchema,
  WebhookEventSchema,
  WebhookListResponseSchema,
  webhookEventTypeOf,
  webhookSignedContent,
} from './webhooks.js';

const ID = '0b9f3d4e-8c1a-4f6b-9e2d-7a5c3b1d0e9f';
const WORKSPACE = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const endpoint = {
  id: ID,
  workspaceId: WORKSPACE,
  url: 'https://hooks.example.com/agent-workspace',
  events: ['run.completed'],
  createdAt: '2026-10-31T00:00:00.000Z',
};

const event = {
  id: ID,
  type: 'run.completed',
  createdAt: '2026-10-31T00:00:05.000Z',
  workspaceId: WORKSPACE,
  data: {
    run: {
      id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a',
      agentId: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
      sessionId: '4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c',
      status: 'completed',
      endedAt: '2026-10-31T00:00:04.000Z',
      error: null,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 30,
        toolCalls: 1,
      },
      cost: { amount: '0.001200', currency: 'USD', priceTableVersion: '2026-10' },
      accountingState: 'complete',
    },
  },
};

describe('webhook event types', () => {
  it('are the three terminal outcomes, in a pinned order', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual(['run.completed', 'run.failed', 'run.cancelled']);
  });

  it('are emitted by each terminal status, and by no other', () => {
    for (const status of RUN_STATUSES) {
      const expected = (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
        ? `run.${status}`
        : null;
      expect(webhookEventTypeOf(status), status).toBe(expected);
    }
    expect(webhookEventTypeOf('awaiting_approval')).toBeNull();
  });
});

describe('CreateWebhookRequestSchema', () => {
  it('accepts an https URL with and without events', () => {
    expect(CreateWebhookRequestSchema.safeParse({ url: endpoint.url }).success).toBe(true);
    expect(
      CreateWebhookRequestSchema.safeParse({
        url: endpoint.url,
        events: ['run.failed', 'run.cancelled'],
      }).success,
    ).toBe(true);
  });

  it('refuses unknown keys', () => {
    expect(CreateWebhookRequestSchema.safeParse({ url: endpoint.url, secret: 'x' }).success).toBe(
      false,
    );
  });

  it.each([
    ['http to a public host', 'http://hooks.example.com/'],
    ['another scheme', 'ftp://hooks.example.com/'],
    ['a relative URL', '/hooks'],
    ['userinfo', 'https://user:pass@hooks.example.com/'],
    ['a user name alone', 'https://user@hooks.example.com/'],
    ['a fragment', 'https://hooks.example.com/#part'],
    ['an empty fragment', 'https://hooks.example.com/#'],
    ['too long', `https://hooks.example.com/${'a'.repeat(WEBHOOK_URL_MAX_LENGTH)}`],
    ['empty', ''],
  ])('refuses a URL with %s', (_label, url) => {
    expect(CreateWebhookRequestSchema.safeParse({ url }).success).toBe(false);
  });

  it('accepts a URL at exactly the length limit', () => {
    const prefix = 'https://hooks.example.com/';
    const url = prefix + 'a'.repeat(WEBHOOK_URL_MAX_LENGTH - prefix.length);
    expect(url.length).toBe(WEBHOOK_URL_MAX_LENGTH);
    expect(CreateWebhookRequestSchema.safeParse({ url }).success).toBe(true);
  });

  it('leaves plain http to a loopback host for the egress policy to decide', () => {
    for (const url of ['http://localhost:4000/hook', 'http://127.0.0.1/hook', 'http://[::1]/']) {
      expect(CreateWebhookRequestSchema.safeParse({ url }).success, url).toBe(true);
    }
  });

  it('refuses empty, repeated and unknown events', () => {
    for (const events of [[], ['run.completed', 'run.completed'], ['run.started']]) {
      expect(
        CreateWebhookRequestSchema.safeParse({ url: endpoint.url, events }).success,
        JSON.stringify(events),
      ).toBe(false);
    }
  });
});

describe('WebhookEndpointSchema and the answers that carry it', () => {
  it('round-trips an endpoint and refuses unknown keys', () => {
    expect(WebhookEndpointSchema.parse(endpoint)).toEqual(endpoint);
    expect(WebhookEndpointSchema.safeParse({ ...endpoint, secret: 'whsec_x' }).success).toBe(false);
  });

  it('carries the secret only in the create answer, in the whsec_ shape', () => {
    const secret = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
    expect(CreateWebhookResponseSchema.safeParse({ webhook: endpoint, secret }).success).toBe(true);
    expect(
      CreateWebhookResponseSchema.safeParse({ webhook: endpoint, secret: 'whsec_short' }).success,
    ).toBe(false);
    expect(
      CreateWebhookResponseSchema.safeParse({ webhook: endpoint, secret, extra: 1 }).success,
    ).toBe(false);
  });

  it('lists at most ten webhooks', () => {
    expect(WebhookListResponseSchema.safeParse({ webhooks: [endpoint] }).success).toBe(true);
    const eleven = Array.from({ length: 11 }, () => endpoint);
    expect(WebhookListResponseSchema.safeParse({ webhooks: eleven }).success).toBe(false);
    expect(WebhookListResponseSchema.safeParse({ webhooks: [], nextCursor: null }).success).toBe(
      false,
    );
  });
});

describe('WebhookEventSchema', () => {
  it('round-trips the signed envelope through JSON', () => {
    const parsed = WebhookEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  it('refuses unknown keys at every level and run fields outside the projection', () => {
    expect(WebhookEventSchema.safeParse({ ...event, extra: true }).success).toBe(false);
    expect(WebhookEventSchema.safeParse({ ...event, data: { ...event.data, x: 1 } }).success).toBe(
      false,
    );
    const withPrompt = { ...event, data: { run: { ...event.data.run, output: null } } };
    expect(WebhookEventSchema.safeParse(withPrompt).success).toBe(false);
  });

  it('requires the run status to be the one the type names', () => {
    const mismatched = { ...event, type: 'run.failed' };
    expect(WebhookEventSchema.safeParse(mismatched).success).toBe(false);
    const paused = { ...event, data: { run: { ...event.data.run, status: 'awaiting_approval' } } };
    expect(WebhookEventSchema.safeParse(paused).success).toBe(false);
  });
});

describe('the Standard Webhooks v1 signature', () => {
  it('pins the headers, the tolerance and the signed content', () => {
    expect(WEBHOOK_SIGNATURE_HEADERS).toEqual({
      id: 'webhook-id',
      timestamp: 'webhook-timestamp',
      signature: 'webhook-signature',
    });
    expect(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(300);
    expect(webhookSignedContent(ID, 1_798_675_200, '{"a":1}')).toBe(`${ID}.1798675200.{"a":1}`);
    expect(webhookSignedContent(ID, '1798675200', '')).toBe(`${ID}.1798675200.`);
  });
});

describe('WEBHOOK_PROBLEM_CODES', () => {
  it('names the codes of spec §5.17 with their statuses', () => {
    expect(WEBHOOK_PROBLEM_CODES).toEqual({
      invalid_webhook_url: 400,
      webhook_url_refused: 400,
      invalid_webhook_id: 400,
      webhook_not_found: 404,
      webhook_limit_reached: 409,
      webhook_api_not_configured: 503,
    });
  });
});
