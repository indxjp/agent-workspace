/**
 * `restrictedBaseEnv` — B1 (round 2): the only environment a `stdio` Test Connection probe's
 * route call site is allowed to hand `testConnection`. Asserts the allowlist by construction
 * (never by trying to enumerate everything it must exclude — ADR-0027/0029's own lesson about
 * enumerating a negative) and that platform selection is real, not a guess.
 */
import { describe, expect, it } from 'vitest';

import { restrictedBaseEnv } from './base-env';

describe('restrictedBaseEnv', () => {
  it('never includes a key outside its own allowlist, however large the source is', () => {
    const hostile = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      MASTER_ENCRYPTION_KEY: 'super-secret',
      SESSION_SECRET: 'also-secret',
      BOOTSTRAP_ADMIN_PASSWORD: 'also-secret',
      DATABASE_URL: 'postgres://also/secret',
      RANDOM_OTHER_VAR: 'irrelevant-but-still-not-allowed',
    };
    const result = restrictedBaseEnv(hostile);
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP']);
    for (const key of Object.keys(result)) {
      expect(allowed.has(key), `${key} is not on the allowlist`).toBe(true);
    }
    expect(result['MASTER_ENCRYPTION_KEY']).toBeUndefined();
    expect(result['SESSION_SECRET']).toBeUndefined();
    expect(result['BOOTSTRAP_ADMIN_PASSWORD']).toBeUndefined();
    expect(result['DATABASE_URL']).toBeUndefined();
    expect(result['RANDOM_OTHER_VAR']).toBeUndefined();
  });

  it('carries PATH through when present, on every platform', () => {
    const result = restrictedBaseEnv({ PATH: '/usr/bin:/bin' });
    expect(result['PATH']).toBe('/usr/bin:/bin');
  });

  it('omits a key the source does not have, rather than inventing an empty string', () => {
    const result = restrictedBaseEnv({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("defaults to reading this process's own environment when no source is given", () => {
    const result = restrictedBaseEnv();
    // Whatever this process's PATH is (there always is one in CI and locally), it must round-trip
    // — proving the function actually reads `process.env` rather than returning `{}` unconditionally.
    if (process.env['PATH'] !== undefined) {
      expect(result['PATH']).toBe(process.env['PATH']);
    }
  });
});
