import { WebhookSecretSchema } from '@indx-workspace/contracts/webhooks';
import { describe, expect, it } from 'vitest';

import { mintWebhookSecret, signWebhook, webhookHeaders } from './signature';

/** The published Standard Webhooks test vector. */
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1_614_265_330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('signWebhook (ADR-SDK-18-N3-250 D2)', () => {
  it('reproduces the Standard Webhooks test vector', () => {
    expect(signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(
      VECTOR.signature,
    );
  });

  it('changes when the body changes by one byte', () => {
    const changed = signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, '{"test": 2432232315}');
    expect(changed).not.toBe(VECTOR.signature);
  });

  it('changes with the id, the timestamp and the secret', () => {
    const base = signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body);
    expect(signWebhook(VECTOR.secret, 'msg_other', VECTOR.timestamp, VECTOR.body)).not.toBe(base);
    expect(signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp + 1, VECTOR.body)).not.toBe(base);
    expect(signWebhook(mintWebhookSecret(), VECTOR.id, VECTOR.timestamp, VECTOR.body)).not.toBe(
      base,
    );
  });

  it('names the three headers, with the timestamp in seconds', () => {
    expect(webhookHeaders(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toEqual({
      'webhook-id': VECTOR.id,
      'webhook-timestamp': '1614265330',
      'webhook-signature': VECTOR.signature,
    });
  });
});

describe('mintWebhookSecret', () => {
  it('mints a contract-shaped secret of 32 random bytes, different every time', () => {
    const first = mintWebhookSecret();
    expect(WebhookSecretSchema.safeParse(first).success).toBe(true);
    expect(Buffer.from(first.slice('whsec_'.length), 'base64')).toHaveLength(32);
    expect(mintWebhookSecret()).not.toBe(first);
  });
});
