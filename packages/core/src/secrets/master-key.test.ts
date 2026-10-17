/**
 * `loadMasterKey` — the ADR-0015 half of "the master key's absence is a startup failure, not a
 * fallback to plaintext." Every case below is a positive assertion that the function THROWS; there
 * is no case in which it is expected to return a value from a bad environment.
 */
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MASTER_KEY_ENV_VAR, loadMasterKey, masterKeyFromBytes } from './master-key.js';

const VALID_KEY_HEX = crypto.randomBytes(32).toString('hex');

describe('loadMasterKey', () => {
  it('throws when the environment has no MASTER_ENCRYPTION_KEY at all', () => {
    // This is the acceptance criterion, stated directly: constructing the subsystem with no key
    // set must throw. `{}` is an environment that genuinely lacks the variable, not one where it
    // is present-but-empty — see the next case for that.
    expect(() => loadMasterKey({})).toThrow(new RegExp(MASTER_KEY_ENV_VAR));
  });

  it('throws when MASTER_ENCRYPTION_KEY is set to an empty string', () => {
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: '' })).toThrow();
  });

  it('throws when MASTER_ENCRYPTION_KEY is whitespace only', () => {
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: '   ' })).toThrow();
  });

  it('throws when MASTER_ENCRYPTION_KEY is not hex', () => {
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: 'not-hex-at-all-zzzz' })).toThrow(/hex/);
  });

  it('throws when MASTER_ENCRYPTION_KEY decodes to the wrong length (too short)', () => {
    const tooShort = crypto.randomBytes(16).toString('hex'); // 16 bytes, not 32
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: tooShort })).toThrow(/32/);
  });

  it('throws when MASTER_ENCRYPTION_KEY decodes to the wrong length (too long)', () => {
    const tooLong = crypto.randomBytes(64).toString('hex'); // 64 bytes, not 32
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: tooLong })).toThrow(/32/);
  });

  it('never echoes the malformed value in its error message', () => {
    const secretLooking = 'zzzzz-do-not-print-me-zzzzz';
    try {
      loadMasterKey({ [MASTER_KEY_ENV_VAR]: secretLooking });
      expect.fail('expected loadMasterKey to throw');
    } catch (error) {
      expect(String(error)).not.toContain(secretLooking);
    }
  });

  it('accepts a well-formed 64-character hex key, produced the documented way (openssl rand -hex 32)', () => {
    const result = loadMasterKey({ [MASTER_KEY_ENV_VAR]: VALID_KEY_HEX });
    expect(result.key).toHaveLength(32);
    expect(result.key.toString('hex')).toBe(VALID_KEY_HEX);
  });

  it('accepts uppercase hex too', () => {
    const result = loadMasterKey({ [MASTER_KEY_ENV_VAR]: VALID_KEY_HEX.toUpperCase() });
    expect(result.key.toString('hex')).toBe(VALID_KEY_HEX.toLowerCase());
  });

  it('derives the same fingerprint id from the same key every time', () => {
    const first = loadMasterKey({ [MASTER_KEY_ENV_VAR]: VALID_KEY_HEX });
    const second = loadMasterKey({ [MASTER_KEY_ENV_VAR]: VALID_KEY_HEX });
    expect(first.id).toBe(second.id);
    expect(first.id).not.toBe('');
  });

  it('derives different fingerprint ids for different keys', () => {
    const other = crypto.randomBytes(32).toString('hex');
    const a = loadMasterKey({ [MASTER_KEY_ENV_VAR]: VALID_KEY_HEX });
    const b = loadMasterKey({ [MASTER_KEY_ENV_VAR]: other });
    expect(a.id).not.toBe(b.id);
  });

  it('defaults to process.env when no environment object is supplied', () => {
    const previous = process.env[MASTER_KEY_ENV_VAR];
    try {
      delete process.env[MASTER_KEY_ENV_VAR];
      expect(() => loadMasterKey()).toThrow(new RegExp(MASTER_KEY_ENV_VAR));
    } finally {
      if (previous === undefined) delete process.env[MASTER_KEY_ENV_VAR];
      else process.env[MASTER_KEY_ENV_VAR] = previous;
    }
  });

  it('constructs a provider-returned key from exactly 32 bytes and copies the input', () => {
    const source = crypto.randomBytes(32);
    const result = masterKeyFromBytes(source);
    source.fill(0);
    expect(result.key).not.toEqual(source);
    expect(() => masterKeyFromBytes(crypto.randomBytes(31))).toThrow(/32/u);
  });
});
