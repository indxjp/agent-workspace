/**
 * Standard Webhooks v1 signing (N-3, issue #250, ADR-SDK-18-N3-250 D2). The signed bytes are the
 * contract's {@link webhookSignedContent}; the key is the base64-decoded part of the secret after
 * `whsec_`; the signature is `v1,<base64 HMAC-SHA256>`. Receivers verify with the SDK's
 * `verifyWebhookSignature`.
 */
import { createHmac, randomBytes } from 'node:crypto';

import {
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  webhookSignedContent,
} from '@indx-workspace/contracts/webhooks';

/** A new signing secret: `whsec_` and the base64 of 32 random bytes (ADR D1). */
export function mintWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
}

function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) throw new Error('the webhook signing secret is empty');
  return key;
}

/** One `webhook-signature` entry for `body` as sent, never re-serialised. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', signingKey(secret))
    .update(webhookSignedContent(id, timestamp, body), 'utf8')
    .digest('base64');
  return `${WEBHOOK_SIGNATURE_VERSION},${mac}`;
}

/** The three Standard Webhooks headers of one attempt. `timestamp` is in Unix seconds. */
export function webhookHeaders(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Readonly<Record<string, string>> {
  return {
    [WEBHOOK_SIGNATURE_HEADERS.id]: id,
    [WEBHOOK_SIGNATURE_HEADERS.timestamp]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADERS.signature]: signWebhook(secret, id, timestamp, body),
  };
}
