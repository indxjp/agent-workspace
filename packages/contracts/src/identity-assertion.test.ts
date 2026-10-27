import { describe, expect, it } from 'vitest';

import {
  IDENTITY_ASSERTION_SKEW_SECONDS,
  type IdentityAssertionPayload,
  signIdentity,
  verifyIdentity,
} from './identity-assertion.js';

const KEY = 'connector-secret-0001';
const EXPECTED = { audience: 'connector-1', workspace: 'workspace-1' };
const NOW = new Date('2026-10-18T00:00:00Z');
const EXP = Math.floor(NOW.getTime() / 1000) + 300;
const PAYLOAD: IdentityAssertionPayload = {
  sub: 'person-42',
  principalKind: 'api-key',
  workspace: 'workspace-1',
  runId: 'run-1',
  aud: 'connector-1',
  exp: EXP,
};

const at = (seconds: number): Date => new Date(seconds * 1000);

/** Signs any payload text, to build the headers the schema-checked `signIdentity` refuses to make. */
async function signRaw(text: string, key: string): Promise<string> {
  const base64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
  const encoder = new TextEncoder();
  const encoded = base64url(encoder.encode(text));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(encoded));
  return `${encoded}.${base64url(new Uint8Array(mac))}`;
}

/** Flips one character of a base64url part to another valid one. */
function tamper(part: string): string {
  return `${part.slice(0, 4)}${part[4] === 'A' ? 'B' : 'A'}${part.slice(5)}`;
}

const INVALID = { ok: false, code: 'identity_assertion_invalid' };

describe('signIdentity / verifyIdentity', () => {
  it('round-trips a signed payload', async () => {
    const header = await signIdentity(PAYLOAD, KEY);
    expect(header).toMatch(/^[\w-]+\.[\w-]+$/u);
    expect(await verifyIdentity(header, KEY, NOW, EXPECTED)).toStrictEqual({
      ok: true,
      payload: PAYLOAD,
    });
  });

  it('refuses a tampered payload and a tampered signature', async () => {
    const [payload = '', signature = ''] = (await signIdentity(PAYLOAD, KEY)).split('.');
    expect(
      await verifyIdentity(`${tamper(payload)}.${signature}`, KEY, NOW, EXPECTED),
    ).toStrictEqual(INVALID);
    expect(
      await verifyIdentity(`${payload}.${tamper(signature)}`, KEY, NOW, EXPECTED),
    ).toStrictEqual(INVALID);
  });

  it('refuses the wrong key, and accepts any key of a rotation list', async () => {
    const header = await signIdentity(PAYLOAD, KEY);
    expect(await verifyIdentity(header, 'another-key', NOW, EXPECTED)).toStrictEqual(INVALID);
    expect(await verifyIdentity(header, [], NOW, EXPECTED)).toStrictEqual(INVALID);
    expect(await verifyIdentity(header, [''], NOW, EXPECTED)).toStrictEqual(INVALID);
    expect((await verifyIdentity(header, ['retired-key', KEY], NOW, EXPECTED)).ok).toBe(true);
  });

  it('allows 30 seconds of skew past exp and no more', async () => {
    const header = await signIdentity(PAYLOAD, KEY);
    expect(
      (await verifyIdentity(header, KEY, at(EXP + IDENTITY_ASSERTION_SKEW_SECONDS), EXPECTED)).ok,
    ).toBe(true);
    expect(
      await verifyIdentity(header, KEY, at(EXP + IDENTITY_ASSERTION_SKEW_SECONDS + 1), EXPECTED),
    ).toStrictEqual({ ok: false, code: 'identity_assertion_expired' });
  });

  it('refuses a payload with an unknown key or a missing key, even when correctly signed', async () => {
    expect(
      await verifyIdentity(
        await signRaw(JSON.stringify({ ...PAYLOAD, email: 'a@b.test' }), KEY),
        KEY,
        NOW,
        EXPECTED,
      ),
    ).toStrictEqual(INVALID);
    const withoutRunId = { ...PAYLOAD, runId: undefined };
    expect(
      await verifyIdentity(await signRaw(JSON.stringify(withoutRunId), KEY), KEY, NOW, EXPECTED),
    ).toStrictEqual(INVALID);
    expect(
      await verifyIdentity(
        await signRaw(JSON.stringify({ ...PAYLOAD, principalKind: 'admin' }), KEY),
        KEY,
        NOW,
        EXPECTED,
      ),
    ).toStrictEqual(INVALID);
  });

  it('refuses another connector and another workspace by name', async () => {
    const header = await signIdentity(PAYLOAD, KEY);
    expect(
      await verifyIdentity(header, KEY, NOW, { ...EXPECTED, audience: 'connector-2' }),
    ).toStrictEqual({ ok: false, code: 'identity_audience_mismatch' });
    expect(
      await verifyIdentity(header, KEY, NOW, { ...EXPECTED, workspace: 'workspace-2' }),
    ).toStrictEqual({ ok: false, code: 'identity_workspace_mismatch' });
  });

  it('refuses a malformed header without throwing', async () => {
    const header = await signIdentity(PAYLOAD, KEY);
    const [payload = '', signature = ''] = header.split('.');
    for (const bad of [
      '',
      'a',
      '.',
      'a.b.c',
      `${header}.${signature}`,
      `${payload}=.${signature}`,
      `${payload}.${signature}=`,
      'not base64!.also not',
      `${payload}.`,
      `.${signature}`,
      await signRaw('"not an object"', KEY),
      await signRaw('{nope', KEY),
    ]) {
      expect(await verifyIdentity(bad, KEY, NOW, EXPECTED), bad).toStrictEqual(INVALID);
    }
  });

  it('never puts the header, the signature or the key in a refusal', async () => {
    const header = await signIdentity(PAYLOAD, KEY);
    const [payload = '', signature = ''] = header.split('.');
    const refusals = [
      await verifyIdentity(header, 'another-key', NOW, EXPECTED),
      await verifyIdentity(header, KEY, at(EXP + 1_000), EXPECTED),
      await verifyIdentity(header, KEY, NOW, { ...EXPECTED, audience: 'x' }),
      await verifyIdentity(header, KEY, NOW, { ...EXPECTED, workspace: 'x' }),
      await verifyIdentity(`${payload}.${tamper(signature)}`, KEY, NOW, EXPECTED),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      const text = JSON.stringify(refusal);
      for (const secret of [header, payload, signature, KEY]) expect(text).not.toContain(secret);
    }
  });

  it('refuses to sign an invalid payload or with an empty key', async () => {
    await expect(signIdentity({ ...PAYLOAD, sub: '' }, KEY)).rejects.toThrow();
    await expect(signIdentity({ ...PAYLOAD, sub: 'x'.repeat(257) }, KEY)).rejects.toThrow();
    await expect(signIdentity(PAYLOAD, '')).rejects.toThrow();
  });
});
