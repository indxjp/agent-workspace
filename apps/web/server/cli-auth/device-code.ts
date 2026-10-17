/**
 * Issue #242 (SDK-10, S-22): the device code and the user code of `aw login`'s device
 * authorization grant (RFC 8628). ADR-0083.
 *
 * The device code is not stored. It is `v1.<user code>.<expiry>.<HMAC>` under the deployment's
 * session secret, with a purpose label inside the MAC so no other token this application signs
 * with that secret can be replayed as one. Only the CLI that asked holds it; the person holds only
 * the user code. Approving a user code writes a `cli_sessions` row, and only a caller presenting a
 * device code this server signed for that same user code can spend it.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** RFC 8628 §6.1: consonants only, so a code spells no word and survives being read aloud. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_PURPOSE = 'aw-cli-device-code';
const DEVICE_CODE_VERSION = 'v1';

/** A fresh user code, stored form: eight upper-case consonants. */
export function newUserCode(): string {
  let code = '';
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)] ?? '';
  }
  return code;
}

/** `ABCD-EFGH`, the form shown to the person. */
export function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The stored form of what a person typed, or `null`. Case, spaces and dashes are forgiven; any
 * other character, or a letter outside the alphabet, is not a code this server issued.
 */
export function normaliseUserCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const code = input.replace(/[\s-]/gu, '').toUpperCase();
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const letter of code) if (!USER_CODE_ALPHABET.includes(letter)) return null;
  return code;
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${DEVICE_CODE_PURPOSE}.${body}`).digest();
}

/** Sign a device code for `userCode`, valid until `expiresAtSeconds` (Unix seconds). */
export function mintDeviceCode(userCode: string, expiresAtSeconds: number, secret: string): string {
  const body = `${DEVICE_CODE_VERSION}.${userCode}.${String(expiresAtSeconds)}`;
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

export type DeviceCodeVerification =
  | { readonly ok: true; readonly userCode: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

/** Verify the MAC before reading anything else, then the expiry. */
export function verifyDeviceCode(
  deviceCode: string,
  secret: string,
  nowSeconds: number,
): DeviceCodeVerification {
  const parts = deviceCode.split('.');
  const [version, userCode, expiry, signature] = parts;
  if (
    parts.length !== 4 ||
    version !== DEVICE_CODE_VERSION ||
    userCode === undefined ||
    expiry === undefined ||
    signature === undefined
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const expected = mac(secret, `${version}.${userCode}.${expiry}`);
  const presented = Buffer.from(signature, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  if (normaliseUserCode(userCode) !== userCode || !/^\d{1,12}$/u.test(expiry)) {
    return { ok: false, reason: 'invalid' };
  }
  if (Number(expiry) <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, userCode };
}
