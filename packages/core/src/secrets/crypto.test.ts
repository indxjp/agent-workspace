import { describe, expect, it } from 'vitest';

import { KEY_BYTES, NONCE_BYTES, TAG_BYTES, generateDataKey, open, seal } from './crypto.js';

describe('seal / open', () => {
  it('round-trips arbitrary plaintext', () => {
    const key = generateDataKey();
    const plaintext = Buffer.from('sk-ant-super-secret-value', 'utf8');
    const sealed = seal(key, plaintext);
    expect(sealed.nonce).toHaveLength(NONCE_BYTES);
    expect(sealed.tag).toHaveLength(TAG_BYTES);
    // The ciphertext is not the plaintext bytes, trivially — but assert it, not just assume it.
    expect(sealed.ciphertext.equals(plaintext)).toBe(false);
    expect(open(key, sealed).equals(plaintext)).toBe(true);
  });

  it('round-trips an empty buffer', () => {
    const key = generateDataKey();
    const sealed = seal(key, Buffer.alloc(0));
    expect(open(key, sealed)).toHaveLength(0);
  });

  it('produces a different nonce and ciphertext on every call, even for the same plaintext', () => {
    const key = generateDataKey();
    const plaintext = Buffer.from('same-value', 'utf8');
    const first = seal(key, plaintext);
    const second = seal(key, plaintext);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('generates a fresh KEY_BYTES-length data key every call', () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(a).toHaveLength(KEY_BYTES);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a key of the wrong length, on seal and on open', () => {
    const shortKey = Buffer.alloc(16);
    expect(() => seal(shortKey, Buffer.from('x'))).toThrow(/32 bytes/);
    const sealed = seal(generateDataKey(), Buffer.from('x'));
    expect(() => open(shortKey, sealed)).toThrow(/32 bytes/);
  });

  it('refuses to decrypt when the ciphertext has been tampered with', () => {
    const key = generateDataKey();
    const sealed = seal(key, Buffer.from('do-not-touch'));
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => open(key, tampered)).toThrow();
  });

  it('refuses to decrypt when the authentication tag has been tampered with', () => {
    const key = generateDataKey();
    const sealed = seal(key, Buffer.from('do-not-touch'));
    const tampered = { ...sealed, tag: Buffer.from(sealed.tag) };
    tampered.tag[0] = (tampered.tag[0] ?? 0) ^ 0xff;
    expect(() => open(key, tampered)).toThrow();
  });

  it('refuses to decrypt under the wrong key entirely', () => {
    const sealed = seal(generateDataKey(), Buffer.from('do-not-touch'));
    expect(() => open(generateDataKey(), sealed)).toThrow();
  });
});
