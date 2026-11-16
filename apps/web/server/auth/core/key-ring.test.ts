import { hkdfSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  KEY_PURPOSES,
  PURPOSE_KEY_BYTES,
  derivePurposeKey,
  keyDerivation,
  verificationKeys,
} from './key-ring.ts';

const SECRET = 'key-ring-test-secret-0123456789abcdef';

/** RFC 5869 through Node's own implementation, written out here rather than read from the module. */
function expectedKey(secret: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, 'agent-workspace/key-ring', `agent-workspace/${purpose}/v1`, 32),
  );
}

describe('one key per purpose', () => {
  it('derives each purpose key with HKDF-SHA-256, the salt and the purpose label', async () => {
    for (const purpose of KEY_PURPOSES) {
      const key = await derivePurposeKey(crypto.subtle, SECRET, purpose);
      expect(key.byteLength).toBe(PURPOSE_KEY_BYTES);
      expect(Buffer.from(key).equals(expectedKey(SECRET, purpose))).toBe(true);
    }
  });

  it('pins one derived key, so a change to the derivation is a visible diff', async () => {
    const key = await derivePurposeKey(crypto.subtle, SECRET, 'session');
    expect(Buffer.from(key).toString('hex')).toBe(expectedKey(SECRET, 'session').toString('hex'));
    expect(Buffer.from(key).toString('base64url')).toMatchInlineSnapshot(
      `"VlFMbE1FQ811GQ_dxvWgMZ-KTH_tzwnLrErbm3EHNVQ"`,
    );
  });

  it('gives every purpose a different key, and none is the raw secret', async () => {
    const keys = await Promise.all(
      KEY_PURPOSES.map(async (purpose) =>
        Buffer.from(await derivePurposeKey(crypto.subtle, SECRET, purpose)).toString('hex'),
      ),
    );
    expect(new Set(keys).size).toBe(KEY_PURPOSES.length);
    expect(keys).not.toContain(Buffer.from(SECRET).toString('hex'));
  });

  it('gives a different secret different keys', async () => {
    const one = await derivePurposeKey(crypto.subtle, SECRET, 'session');
    const other = await derivePurposeKey(crypto.subtle, `${SECRET}x`, 'session');
    expect(Buffer.from(one).equals(Buffer.from(other))).toBe(false);
  });

  it('hands the synchronous Node readers the same parameters', () => {
    const derivation = keyDerivation('cli-device-code');
    const key = Buffer.from(
      hkdfSync('sha256', SECRET, derivation.salt, derivation.info, derivation.lengthBytes),
    );
    expect(key.equals(expectedKey(SECRET, 'cli-device-code'))).toBe(true);
  });

  it('tries the purpose key first, then the old one, during the roll-over', () => {
    expect(verificationKeys('purpose', 'legacy')).toEqual(['purpose', 'legacy']);
  });
});
