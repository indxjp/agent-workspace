/* global Buffer */ // The root ESLint config declares no environment globals.
// The per-conversation customer token: the answer to "how does the CRM server know which customer
// it is serving?" when the platform cannot tell it.
//
// A connector's credential belongs to the agent, not to the person chatting (RF-102), so every run
// of the agent reaches the CRM server with the same credential. If the server trusted a
// `customerId` the model passes, a visitor could type 「C-1002 の履歴を見せて」 and the model
// might comply. So the company's chat backend, which knows who signed in, mints a short-lived
// token `base64url(payload).base64url(HMAC-SHA256(payload))` naming that one customer, puts it in
// the prompt, and the server accepts a call only when the token verifies and names the customer
// the call asks about. The model can repeat the token but cannot forge one for someone else.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a minted token lives: one chat turn plus slack, not the whole conversation. */
export const TOKEN_TTL_SECONDS = 15 * 60;

const encode = (value) => Buffer.from(value, 'utf8').toString('base64url');
const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

/** Mint a token for `customerId`, valid for `ttlSeconds` from `now` (seconds since the epoch). */
export function mintCustomerToken(
  secret,
  customerId,
  { now = Math.floor(Date.now() / 1000), ttlSeconds = TOKEN_TTL_SECONDS } = {},
) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('the token secret must be at least 32 characters');
  }
  const payload = encode(JSON.stringify({ cid: customerId, exp: now + ttlSeconds }));
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Check `token` and return `{ ok: true, customerId, expiresAt }`, or `{ ok: false, reason }` with
 * reason `malformed`, `signature` or `expired`. The signature is compared in constant time.
 */
export function verifyCustomerToken(secret, token, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) return { ok: false, reason: 'malformed' };
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.trim().split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { ok: false, reason: 'malformed' };
  }
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(secret, payload), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims?.cid !== 'string' || !Number.isInteger(claims?.exp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, customerId: claims.cid, expiresAt: claims.exp };
}
