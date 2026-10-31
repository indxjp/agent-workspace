import { describe, expect, it } from 'vitest';

import {
  verifyWebhookSignature,
  WebhookVerificationError,
  webhookSignatureMatches,
  type VerifyWebhookSignatureInput,
  type WebhookVerificationErrorCode,
} from './verify.js';

const EVENT_ID = '0b9f3d4e-8c1a-4f6b-9e2d-7a5c3b1d0e9f';
const TIMESTAMP = 1_793_404_805;
const NOW = new Date(TIMESTAMP * 1000);

/** 32 bytes, 0x00 to 0x1f, as `create` would mint them. */
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;

const event = {
  id: EVENT_ID,
  type: 'run.completed',
  createdAt: '2026-10-31T00:00:05.000Z',
  workspaceId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
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
const BODY = JSON.stringify(event);

/** The signer, written independently of the helper: HMAC-SHA256 over `id.timestamp.body`. */
async function sign(keyBytes: Uint8Array<ArrayBuffer>, content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

async function delivery(
  overrides: Partial<VerifyWebhookSignatureInput> = {},
): Promise<VerifyWebhookSignatureInput> {
  const signature = await sign(KEY_BYTES, `${EVENT_ID}.${String(TIMESTAMP)}.${BODY}`);
  return {
    secret: SECRET,
    body: BODY,
    now: NOW,
    headers: {
      'webhook-id': EVENT_ID,
      'webhook-timestamp': String(TIMESTAMP),
      'webhook-signature': signature,
    },
    ...overrides,
  };
}

async function refusal(input: VerifyWebhookSignatureInput): Promise<WebhookVerificationErrorCode> {
  const failure = await verifyWebhookSignature(input).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(WebhookVerificationError);
  return (failure as WebhookVerificationError).code;
}

describe('verifyWebhookSignature', () => {
  it('verifies a signed delivery and returns the contract-checked event', async () => {
    expect(await verifyWebhookSignature(await delivery())).toEqual(event);
  });

  it('reads a Fetch Headers object and record keys in any case', async () => {
    const input = await delivery();
    const record = input.headers as Record<string, string>;
    const headers = new Headers(record);
    expect((await verifyWebhookSignature({ ...input, headers })).id).toBe(EVENT_ID);
    const upper = Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toUpperCase(), v]));
    expect((await verifyWebhookSignature({ ...input, headers: upper })).id).toBe(EVENT_ID);
  });

  it('fails with a wrong secret', async () => {
    const other = `whsec_${btoa(String.fromCharCode(...KEY_BYTES.map((byte) => byte ^ 1)))}`;
    expect(await refusal(await delivery({ secret: other }))).toBe('signature_mismatch');
  });

  it('fails on a tampered body, even one that is still a valid event', async () => {
    const tampered = JSON.stringify({
      ...event,
      workspaceId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
    });
    expect(await refusal(await delivery({ body: tampered }))).toBe('signature_mismatch');
    expect(await refusal(await delivery({ body: `${BODY} ` }))).toBe('signature_mismatch');
  });

  it('fails on a timestamp outside the tolerance in either direction, and accepts its edge', async () => {
    const late = new Date((TIMESTAMP + 301) * 1000);
    const early = new Date((TIMESTAMP - 301) * 1000);
    expect(await refusal(await delivery({ now: late }))).toBe('timestamp_out_of_tolerance');
    expect(await refusal(await delivery({ now: early }))).toBe('timestamp_out_of_tolerance');
    const edge = new Date((TIMESTAMP + 300) * 1000);
    expect((await verifyWebhookSignature(await delivery({ now: edge }))).id).toBe(EVENT_ID);
    const tight = await delivery({ now: new Date((TIMESTAMP + 10) * 1000), toleranceSeconds: 5 });
    expect(await refusal(tight)).toBe('timestamp_out_of_tolerance');
  });

  it('accepts any v1 entry of a space-separated list and skips other versions', async () => {
    const input = await delivery();
    const record = input.headers as Record<string, string>;
    const good = record['webhook-signature'] ?? '';
    const listed = `v1a,AAAA v1,${btoa('not this one')} ${good}`;
    const headers = { ...record, 'webhook-signature': listed };
    expect((await verifyWebhookSignature({ ...input, headers })).id).toBe(EVENT_ID);
    const onlyOthers = { ...record, 'webhook-signature': `v1a,${good.slice(3)} v1,!!` };
    expect(await refusal({ ...input, headers: onlyOthers })).toBe('signature_mismatch');
  });

  it('refuses a missing, repeated or malformed header', async () => {
    const input = await delivery();
    const record = input.headers as Record<string, string>;
    const without = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== name));
    expect(await refusal({ ...input, headers: without('webhook-id') })).toBe('missing_header');
    expect(await refusal({ ...input, headers: without('webhook-timestamp') })).toBe(
      'missing_header',
    );
    expect(await refusal({ ...input, headers: without('webhook-signature') })).toBe(
      'missing_header',
    );
    const repeated = { ...record, 'webhook-id': [EVENT_ID, EVENT_ID] };
    expect(await refusal({ ...input, headers: repeated })).toBe('missing_header');
    const fractional = { ...record, 'webhook-timestamp': `${String(TIMESTAMP)}.5` };
    expect(await refusal({ ...input, headers: fractional })).toBe('missing_header');
  });

  it('refuses a secret that is not the whsec_ value create returned', async () => {
    expect(await refusal(await delivery({ secret: SECRET.slice('whsec_'.length) }))).toBe(
      'invalid_secret',
    );
  });

  it('refuses a signed body that is not a WebhookEvent, or whose id is not webhook-id', async () => {
    const signed = async (body: string, id = EVENT_ID): Promise<VerifyWebhookSignatureInput> => ({
      secret: SECRET,
      body,
      now: NOW,
      headers: {
        'webhook-id': id,
        'webhook-timestamp': String(TIMESTAMP),
        'webhook-signature': await sign(KEY_BYTES, `${id}.${String(TIMESTAMP)}.${body}`),
      },
    });
    expect(await refusal(await signed('not json'))).toBe('invalid_payload');
    expect(await refusal(await signed(JSON.stringify({ ...event, prompt: 'x' })))).toBe(
      'invalid_payload',
    );
    const otherId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(await refusal(await signed(BODY, otherId))).toBe('invalid_payload');
  });
});

describe('webhookSignatureMatches', () => {
  // The Standard Webhooks v1 reference vector (standard-webhooks/standard-webhooks, the spec's
  // example), which every conforming signer, the platform's included, must reproduce.
  const VECTOR = {
    key: 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    body: '{"test": 2432232314}',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };

  async function vectorKey(): Promise<CryptoKey> {
    const bytes = Uint8Array.from(atob(VECTOR.key), (character) => character.charCodeAt(0));
    return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'verify',
    ]);
  }

  it('matches the Standard Webhooks reference vector and nothing else', async () => {
    const key = await vectorKey();
    const content = `${VECTOR.id}.${VECTOR.timestamp}.${VECTOR.body}`;
    expect(await webhookSignatureMatches(key, VECTOR.signature, content)).toBe(true);
    expect(await webhookSignatureMatches(key, VECTOR.signature, `${content} `)).toBe(false);
    expect(await webhookSignatureMatches(key, VECTOR.signature.slice(3), content)).toBe(false);
  });
});
