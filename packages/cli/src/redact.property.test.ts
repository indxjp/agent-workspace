/**
 * Property tests for the CLI's two redactors (F-21 property 9): `aw doctor`'s
 * {@link collectSecrets}/{@link redact} and `aw deploy`'s {@link createRedactor}. A secret taken
 * from the environment does not survive anywhere in the text, redacting twice is redacting once,
 * and text holding no secret and no URL userinfo is unchanged. Secrets are drawn without `*`, the
 * mask's own character, which is the only way a second pass could find something new. On a
 * failure fast-check prints the seed and path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createRedactor } from './deploy/redact.js';
import { collectSecrets, redact } from './doctor/redact.js';

const secret = fc.string({
  unit: fc.constantFrom(...'ABCXYZabcxyz0189!#$%&+=_-.'),
  minLength: 4,
  maxLength: 30,
});

/** Text around a secret, including URLs with and without userinfo. */
const text = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom('postgres://u:pw@db:5432/x ', 'https://host/path ', ' ', '@', '://'),
);

/** Text with no `:`, so no URL userinfo for either redactor to mask. */
const plain = fc.string({ unit: fc.constantFrom(...'abcxyz019 -_.,/@!'), maxLength: 60 });

const RUNS = { numRuns: 500 };

describe('aw doctor redact (property)', () => {
  it('removes every embedded secret and is idempotent', () => {
    fc.assert(
      fc.property(text, secret, text, (before, value, after) => {
        const secrets = collectSecrets({ DATABASE_PASSWORD: value }, null);
        const once = redact(`${before}${value}${after}`, secrets);
        expect(once).not.toContain(value);
        expect(redact(once, secrets)).toBe(once);
      }),
      RUNS,
    );
  });

  it('leaves text with no secret and no URL userinfo unchanged', () => {
    fc.assert(
      fc.property(plain, secret, (message, value) => {
        fc.pre(!message.includes(value));
        expect(redact(message, collectSecrets({ API_TOKEN: value }, null))).toBe(message);
      }),
      RUNS,
    );
  });
});

describe('aw deploy createRedactor (property)', () => {
  it('removes every embedded secret and is idempotent', () => {
    fc.assert(
      fc.property(text, secret, text, (before, value, after) => {
        const mask = createRedactor({ MASTER_KEY: value });
        const once = mask(`${before}${value}${after}`);
        expect(once).not.toContain(value);
        expect(mask(once)).toBe(once);
      }),
      RUNS,
    );
  });

  it('leaves text with no secret and no URL userinfo unchanged', () => {
    fc.assert(
      fc.property(plain, secret, (message, value) => {
        fc.pre(!message.includes(value));
        expect(createRedactor({ MASTER_KEY: value })(message)).toBe(message);
      }),
      RUNS,
    );
  });
});
