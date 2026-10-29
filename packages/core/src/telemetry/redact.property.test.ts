/**
 * Property tests for {@link redacted} (F-21 property 9): a secret embedded anywhere in a message
 * does not survive, redacting twice is redacting once, and a message with nothing to redact is
 * unchanged. Secrets are drawn without `[`/`]` and are never a piece of the `[redacted]`/`[url]`
 * markers, which is the only way a second pass could find something new. On a failure fast-check
 * prints the seed and path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { redacted } from './redact.js';

const secret = fc
  .string({
    unit: fc.constantFrom(...'ABCXYZabcdexyz0189!#$%&*+=_-'),
    minLength: 4,
    maxLength: 40,
  })
  .filter((value) => !'[redacted][url]'.includes(value));

/** Arbitrary text around it, URLs and long tokens included. */
const text = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.constantFrom('https://user:pw@host/x ', 'a'.repeat(40), ' ', ':', '//'),
);

/** Words too short to be a token and no `:`, so there is no URL or token to redact. */
const plain = fc
  .array(fc.string({ unit: fc.constantFrom(...'abcxyz019-_.,!'), maxLength: 12 }), {
    maxLength: 12,
  })
  .map((words) => words.join(' '));

const RUNS = { numRuns: 1_000 };

describe('redacted (cloud signed URLs)', () => {
  it.each([
    ['S3', 'X-Amz-Credential=AKIA%2F20260101%2Fus-east-1&X-Amz-Signature=0123abcd4567ef89'],
    ['GCS', 'X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=89fe7654dcba3210'],
    ['Azure', 'sv=2024-11-04&sp=r&sig=Zx%2BQ%2Fk%3D'],
  ])('masks a %s signed URL inside a message', (_cloud, query) => {
    const url = `https://store.invalid/ws/docs/a.txt?${query}`;
    const out = redacted(`upload failed for ${url} after 3 tries`, []);
    expect(out).toBe('upload failed for [url] after 3 tries');
  });

  // A signature pair copied out of its URL (a query string in an error, a header dump) is too short
  // or too escaped to be caught as a long token, so its value is masked by name.
  it.each([
    ['S3', 'X-Amz-Signature', '0123abcd'],
    ['GCS', 'x-goog-signature', '89fe7654'],
    ['Azure', 'sig', 'Zx%2BQ%2Fk%3D'],
  ])('masks a bare %s signature pair outside a URL', (_cloud, name, value) => {
    const out = redacted(`refused: ${name}=${value}&sv=2024-11-04 (403)`, []);
    expect(out).toBe(`refused: ${name}=[redacted]&sv=2024-11-04 (403)`);
    expect(redacted(out, [])).toBe(out);
  });

  it('leaves a word that only ends in sig alone', () => {
    expect(redacted('config=a; rsig=b', [])).toBe('config=a; rsig=b');
  });
});

describe('redacted (property)', () => {
  it('removes every embedded secret and is idempotent', () => {
    fc.assert(
      fc.property(text, secret, text, (before, value, after) => {
        const once = redacted(`${before}${value}${after}`, [value]);
        expect(once).not.toContain(value);
        expect(redacted(once, [value])).toBe(once);
      }),
      RUNS,
    );
  });

  it('leaves a message with no secret, URL or long token unchanged', () => {
    fc.assert(
      fc.property(plain, secret, (message, value) => {
        fc.pre(!message.includes(value));
        expect(redacted(message, [value])).toBe(message);
      }),
      RUNS,
    );
  });
});
