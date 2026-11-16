/**
 * Issue #242 (SDK-10, S-22): the device code and the user code of `aw login`'s device
 * authorization grant (RFC 8628). ADR-0083.
 *
 * The device code is not stored. It is `v1.<user code>.<expiry>.<HMAC>` under the device-code key
 * derived from the deployment's session secret (part 06 step 5, `auth/core/key-ring.ts`), with a
 * purpose label inside the MAC as well, so no other token this application signs can be replayed
 * as one. Only the CLI that asked holds it; the person holds only the user code. Approving a user
 * code writes a `cli_sessions` row, and only a caller presenting a device code this server signed
 * for that same user code can spend it.
 */
import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';

import { keyDerivation, verificationKeys } from '../auth/core/key-ring.ts';

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

const derivedKeys = new Map<string, Buffer>();

/** The device-code key: the same HKDF the signing modules run, synchronously, memoised by secret. */
function deviceCodeKey(secret: string): Buffer {
  const cached = derivedKeys.get(secret);
  if (cached !== undefined) return cached;
  const { salt, info, lengthBytes } = keyDerivation('cli-device-code');
  const key = Buffer.from(hkdfSync('sha256', secret, salt, info, lengthBytes));
  derivedKeys.set(secret, key);
  return key;
}

function mac(key: Buffer | string, body: string): Buffer {
  return createHmac('sha256', key).update(`${DEVICE_CODE_PURPOSE}.${body}`).digest();
}

/** Constant-time against each key: the device-code key, then the raw secret (roll-over). */
function signedByAnyKey(secret: string, body: string, presented: Buffer): boolean {
  return verificationKeys<() => Buffer | string>(
    () => deviceCodeKey(secret),
    () => secret,
  ).some((key) => {
    const expected = mac(key(), body);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  });
}

/** Sign a device code for `userCode`, valid until `expiresAtSeconds` (Unix seconds). */
export function mintDeviceCode(userCode: string, expiresAtSeconds: number, secret: string): string {
  const body = `${DEVICE_CODE_VERSION}.${userCode}.${String(expiresAtSeconds)}`;
  return `${body}.${mac(deviceCodeKey(secret), body).toString('base64url')}`;
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
  const presented = Buffer.from(signature, 'base64url');
  if (!signedByAnyKey(secret, `${version}.${userCode}.${expiry}`, presented)) {
    return { ok: false, reason: 'invalid' };
  }
  if (normaliseUserCode(userCode) !== userCode || !/^\d{1,12}$/u.test(expiry)) {
    return { ok: false, reason: 'invalid' };
  }
  if (Number(expiry) <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, userCode };
}
