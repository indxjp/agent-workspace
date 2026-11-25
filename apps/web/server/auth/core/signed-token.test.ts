import { describe, expect, it, vi } from 'vitest';

import {
  decodeBase64Url,
  encodeBase64Url,
  importHmacKey,
  openSignedToken,
  sealSignedToken,
  signedTokenRefusal,
  type SignedTokenFailure,
} from './signed-token.ts';

const VERSION = 'test1';
const encoder = new TextEncoder();
const keyBytes = (fill: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(32)).fill(fill);

const key = await importHmacKey(crypto.subtle, keyBytes(7));
const otherKey = await importHmacKey(crypto.subtle, keyBytes(8));

/** A token whose payload segment is `payloadPart` verbatim, signed correctly under `key`. */
async function signedWithPayloadPart(payloadPart: string): Promise<string> {
  const signed = `${VERSION}.${payloadPart}`;
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signed));
  return `${signed}.${Buffer.from(mac).toString('base64url')}`;
}

const b64url = (text: string): string => Buffer.from(text).toString('base64url');

async function failureOf(token: string): Promise<SignedTokenFailure> {
  const opened = await openSignedToken(crypto.subtle, key, VERSION, token);
  if (opened.ok) throw new Error('expected a refusal');
  return opened.failure;
}

describe('base64url', () => {
  it('matches Node for every length class, unpadded, and round-trips', () => {
    for (let length = 0; length < 70; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 251) % 256);
      const encoded = encodeBase64Url(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      if (length > 0) expect(Array.from(decodeBase64Url(encoded) ?? [])).toEqual(Array.from(bytes));
    }
  });

  it('refuses text outside the alphabet, padding and the empty string', () => {
    for (const text of ['', 'ab+c', 'ab/c', 'abc=', 'ab c', 'a.b']) {
      expect(decodeBase64Url(text)).toBeNull();
    }
  });

  it('refuses a length no encoding produces', () => {
    expect(decodeBase64Url('a')).toBeNull();
  });
});

describe('sealSignedToken / openSignedToken', () => {
  it('round-trips a payload, and seals version.payload.signature over JSON', async () => {
    const payload = { sub: 'a@b.test', n: 3, nested: { ok: true } };
    const token = await sealSignedToken(crypto.subtle, key, VERSION, payload);
    const [version, payloadPart, signaturePart] = token.split('.');
    expect(version).toBe(VERSION);
    expect(Buffer.from(payloadPart ?? '', 'base64url').toString()).toBe(JSON.stringify(payload));
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${VERSION}.${payloadPart ?? ''}`),
    );
    expect(signaturePart).toBe(Buffer.from(mac).toString('base64url'));
    expect(await openSignedToken(crypto.subtle, key, VERSION, token)).toEqual({
      ok: true,
      payload,
    });
  });

  it('counts the parts of a token that does not have three', async () => {
    expect(await failureOf('a.b')).toEqual({ kind: 'parts-count', count: 2 });
    expect(await failureOf('a.b.c.d')).toEqual({ kind: 'parts-count', count: 4 });
    expect(await failureOf('nodots')).toEqual({ kind: 'parts-count', count: 1 });
  });

  it('refuses another version tag, even with a valid signature under the same key', async () => {
    const token = await sealSignedToken(crypto.subtle, key, 'other1', { a: 1 });
    expect(await failureOf(token)).toEqual({ kind: 'version' });
  });

  it('refuses a signature segment that is not base64url', async () => {
    expect(await failureOf(`${VERSION}.${b64url('{}')}.not+base64`)).toEqual({
      kind: 'signature-encoding',
    });
  });

  it('refuses a signature made under another key', async () => {
    const token = await sealSignedToken(crypto.subtle, otherKey, VERSION, { a: 1 });
    expect(await failureOf(token)).toEqual({ kind: 'signature' });
  });

  it('refuses a correct signature cut short or extended', async () => {
    const token = await sealSignedToken(crypto.subtle, key, VERSION, { a: 1 });
    const [version, payloadPart, signaturePart] = token.split('.');
    const mac = Buffer.from(signaturePart ?? '', 'base64url');
    const short = mac.subarray(0, mac.length - 1).toString('base64url');
    const long = Buffer.concat([mac, Buffer.from([0])]).toString('base64url');
    for (const signature of [short, long]) {
      expect(await failureOf(`${version ?? ''}.${payloadPart ?? ''}.${signature}`)).toEqual({
        kind: 'signature',
      });
    }
  });

  it('refuses a tampered payload', async () => {
    const token = await sealSignedToken(crypto.subtle, key, VERSION, { admin: false });
    const [version, , signaturePart] = token.split('.');
    const forged = `${version ?? ''}.${b64url('{"admin":true}')}.${signaturePart ?? ''}`;
    expect(await failureOf(forged)).toEqual({ kind: 'signature' });
  });

  it('checks the signature before the payload is decoded or parsed', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const unsigned = `${VERSION}.${b64url('not json')}.${b64url('x'.repeat(32))}`;
      expect(await failureOf(unsigned)).toEqual({ kind: 'signature' });
      const badEncoding = `${VERSION}.***.${b64url('x'.repeat(32))}`;
      expect(await failureOf(badEncoding)).toEqual({ kind: 'signature' });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('compares the signature with the port verify, not by itself', async () => {
    const token = await sealSignedToken(crypto.subtle, key, VERSION, { a: 1 });
    const verify = vi.fn(crypto.subtle.verify.bind(crypto.subtle));
    expect((await openSignedToken({ verify }, key, VERSION, token)).ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toBe('HMAC');
    const refusing = vi.fn(() => Promise.resolve(false));
    expect(await openSignedToken({ verify: refusing }, key, VERSION, token)).toEqual({
      ok: false,
      failure: { kind: 'signature' },
    });
  });

  it('refuses a signed payload that is not base64url, not JSON, or not an object', async () => {
    expect(await failureOf(await signedWithPayloadPart('a'))).toEqual({
      kind: 'payload-encoding',
    });
    expect(await failureOf(await signedWithPayloadPart(b64url('not json')))).toEqual({
      kind: 'payload-json',
    });
    for (const json of ['null', '[1,2]', '"text"', '42', 'true']) {
      expect(await failureOf(await signedWithPayloadPart(b64url(json)))).toEqual({
        kind: 'payload-not-object',
      });
    }
  });
});

describe('signedTokenRefusal', () => {
  it('words every failure kind', () => {
    expect(signedTokenRefusal({ kind: 'parts-count', count: 2 })).toBe(
      'token has 2 parts, expected 3',
    );
    expect(signedTokenRefusal({ kind: 'version' })).toBe(
      'token version tag is not the one this build issues',
    );
    expect(signedTokenRefusal({ kind: 'signature-encoding' })).toBe(
      'signature segment is not base64url',
    );
    expect(signedTokenRefusal({ kind: 'signature' })).toBe('signature does not verify');
    expect(signedTokenRefusal({ kind: 'payload-encoding' })).toBe(
      'payload segment is not base64url',
    );
    expect(signedTokenRefusal({ kind: 'payload-json' })).toBe('payload is not JSON');
    expect(signedTokenRefusal({ kind: 'payload-not-object' })).toBe('payload is not a JSON object');
  });
});
