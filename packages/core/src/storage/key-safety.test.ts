/**
 * Unit tests for the one guard `object-store.ts` and `local-fs-store.ts` both call before they
 * touch a backend. `contract.ts` proves the same attack shapes are refused end-to-end, through a
 * real `ObjectStore` and against every backend; this file proves the guard's own decision on a
 * wider set of inputs, including the ones that must be *accepted* — a positive-assertion gate that
 * rejected everything would pass the contract suite too.
 *
 * The corpus below (`LEGAL` and `ILLEGAL`) is the whole legal/illegal key set this repository
 * generates for this guard, and it is defined once so that the idempotence block at the bottom can
 * run over all of it rather than over a hand-picked sample.
 */
import { describe, expect, it } from 'vitest';

import {
  OBJECT_METADATA_SUFFIX,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
  type ObjectKeyRejectionRule,
} from './key-safety.js';

/** Every key this guard must accept. Also the domain the idempotence property is asserted over. */
const LEGAL: readonly string[] = [
  'instructions.md',
  'contracts/agreement.pdf',
  'a/b/c/d.txt',
  'report-template.docx',
  'file with spaces.txt',
  'unicode-\u00e9\u00e8.txt',
  '..config/x.txt', // a leading ".." in a FILENAME is not the segment ".." itself
  '...hidden/y',
  'a.b..c/d.txt',
  'a/b',
  'note.txt',
  'objectstore_meta.json', // near the reserved marker, but not containing it
  '__objectstore__.json',
  'pricing.xlsx',
  'a-b_c.d+e~f',
  '1',
];

/** Every string this guard must refuse, with the rule that must fire for it. */
const ILLEGAL: ReadonlyArray<readonly [string, ObjectKeyRejectionRule]> = [
  // The three shapes W2-plan.md's second acceptance criterion names.
  ['../secret.txt', 'dot-segment'],
  ['../../etc/passwd', 'dot-segment'],
  ['contracts/../../secret.txt', 'dot-segment'],
  ['..', 'dot-segment'],
  ['/etc/passwd', 'absolute'],
  ['/contracts/agreement.pdf', 'absolute'],
  ['C:\\Windows\\win.ini', 'backslash'],
  ['..%2f..%2fetc%2fpasswd', 'dot-segment'],
  ['%2fetc%2fpasswd', 'absolute'],
  ['%2e%2e%2fsecret.txt', 'dot-segment'],
  ['contracts%2f..%2f..%2fsecret.txt', 'dot-segment'],
  // Everything else the guard names a rule for.
  ['', 'empty-key'],
  ['a//b.txt', 'empty-segment'],
  ['a/', 'empty-segment'],
  ['/', 'absolute'],
  ['a\\b.txt', 'backslash'],
  ['a/b%00.txt', 'control-character'],
  ['%zz', 'malformed-encoding'],
  ['a/%', 'malformed-encoding'],
  ['50%.txt', 'malformed-encoding'],
  // The reserved content-type sidecar marker (round 1 F3; round 3 F3/U2 for every spelling but
  // the first). The rule is containment of the marker, without regard to case, on every segment —
  // NOT `endsWith` on one exact string, which is what round 2 shipped and what a case-insensitive
  // filesystem (NTFS, APFS) walked straight through. Two rows end in no suffix at all: `::$DATA`,
  // where `writeFile('w.json::$DATA')` was measured to replace the contents of `w.json` on this
  // branch's dev platform, and a trailing dot, which `node:fs` was measured to preserve here but
  // which the Win32 path rules strip in other callers — refused either way, rather than refused
  // only where a measurement happened to say it mattered.
  ['note.txt.__objectstore_meta__.json', 'reserved-name'],
  ['note.txt.__objectstore_meta__.JSON', 'reserved-name'],
  ['note.txt.__ObjectStore_Meta__.json', 'reserved-name'],
  ['NOTE.TXT.__OBJECTSTORE_META__.JSON', 'reserved-name'],
  ['__objectstore_meta__', 'reserved-name'],
  ['dir.__objectstore_meta__.json/inner.txt', 'reserved-name'],
  ['a/b/deep.__objectstore_meta__.json', 'reserved-name'],
  ['note.txt.__objectstore_meta__.json::$DATA', 'reserved-name'],
  ['note.txt.__objectstore_meta__.json.', 'reserved-name'],
  ['x.__objectstore_meta__.jsonx', 'reserved-name'],
  ['__objectstore_meta__.json', 'reserved-name'],
  // A string that means a different string once decoded (verification round 1, F2).
  ['a%252fb', 'non-canonical'],
  ['a%2fb', 'non-canonical'],
  ['a%20b.txt', 'non-canonical'],
  ['100%2Fdone.txt', 'non-canonical'],
  ['Q1 report 100%25.pdf', 'non-canonical'],
  ['%252e%252e%252fx', 'non-canonical'],
  // Encoding the reserved marker does not smuggle it past: segments are judged on the decoded
  // form, before the canonicality assertion, so this reports the rule that actually matters.
  ['note.txt.__objectstore_meta__%2ejson', 'reserved-name'],
];

function expectRule(raw: string, rule: ObjectKeyRejectionRule): void {
  let thrown: unknown;
  try {
    toObjectKey(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected toObjectKey(${JSON.stringify(raw)}) to throw`).toBeInstanceOf(
    UnsafeObjectKeyError,
  );
  expect((thrown as InstanceType<typeof UnsafeObjectKeyError>).rule).toBe(rule);
}

describe('toObjectKey — every refusal, by the rule that must fire', () => {
  for (const [raw, rule] of ILLEGAL) {
    it(`refuses ${JSON.stringify(raw)} (${rule})`, () => {
      expectRule(raw, rule);
    });
  }
});

describe('toObjectKey — legal keys are accepted unchanged', () => {
  for (const key of LEGAL) {
    it(`accepts ${JSON.stringify(key)}`, () => {
      expect(toObjectKey(key)).toBe(key);
    });
  }
});

/**
 * The property W2-CP-03's verification round 1 found missing, and the direct cause of the
 * write-to-the-wrong-path defect: the guard runs three times per operation (the scoping wrapper,
 * the backend, and the HTTP edge), so `toObjectKey` composed with itself must be `toObjectKey`.
 * The stronger fact this asserts, from which idempotence follows, is that the guard is a *filter*:
 * its only non-throwing result is the string it was given.
 */
describe('the guard is a filter, not a rewriter — so it is idempotent', () => {
  it('returns the identical string for every legal key, and toObjectKey∘toObjectKey === toObjectKey', () => {
    for (const key of LEGAL) {
      const once = toObjectKey(key);
      expect(once, `toObjectKey rewrote ${JSON.stringify(key)}`).toBe(key);
      const twice = toObjectKey(once);
      expect(twice, `toObjectKey is not idempotent at ${JSON.stringify(key)}`).toBe(once);
      expect(toObjectKey(twice)).toBe(once);
    }
  });

  it('holds for prefixes too, including the root', () => {
    for (const prefix of ['', ...LEGAL]) {
      const once = toObjectPrefix(prefix);
      expect(once).toBe(prefix);
      expect(toObjectPrefix(once)).toBe(once);
    }
  });

  it('refuses every illegal key on the first application, so no later application can differ', () => {
    // The failure mode this rules out: an input the first pass accepts and a second pass refuses,
    // which reached POST /api/files as an uncaught 500 in verification round 1 (F5). If the first
    // application never returns for these, there is no second application to disagree.
    for (const [raw] of ILLEGAL) {
      expect(() => toObjectKey(raw), `${JSON.stringify(raw)} was accepted`).toThrow(
        UnsafeObjectKeyError,
      );
    }
  });

  it('accepts every output it can produce — the accepted set is closed under the guard', () => {
    // Stated as a closure property rather than a spot check: for every legal key, the *result* is
    // itself legal, at every one of the three call sites, forever.
    const accepted = LEGAL.map((key) => toObjectKey(key));
    for (const key of accepted) {
      expect(() => toObjectKey(key)).not.toThrow();
      expect(() => toObjectPrefix(key)).not.toThrow();
    }
  });
});

describe('toObjectPrefix', () => {
  it('accepts the empty string as the workspace root', () => {
    expect(toObjectPrefix('')).toBe('');
  });

  it('refuses the same three attack shapes as a prefix', () => {
    expect(() => toObjectPrefix('../secret')).toThrow(UnsafeObjectKeyError);
    expect(() => toObjectPrefix('/etc')).toThrow(UnsafeObjectKeyError);
    expect(() => toObjectPrefix('..%2f..%2fetc')).toThrow(UnsafeObjectKeyError);
  });

  it('accepts a legal non-empty prefix', () => {
    expect(toObjectPrefix('contracts')).toBe('contracts');
  });

  it('refuses a prefix segment containing the reserved metadata marker, in any case', () => {
    expect(() => toObjectPrefix(`dir${OBJECT_METADATA_SUFFIX}`)).toThrow(UnsafeObjectKeyError);
    expect(() => toObjectPrefix('dir.__objectstore_meta__.json')).toThrow(UnsafeObjectKeyError);
    expect(() => toObjectPrefix('dir.__OBJECTSTORE_META__.JSON')).toThrow(UnsafeObjectKeyError);
  });
});

/**
 * The marker rule, and what it is *for*, kept apart deliberately (verification rounds 2-4). Round
 * 2's rule was `endsWith` at exact case and a case-folding filesystem walked through it; round 3
 * widened it to case-blind containment, which holds — every spelling below is refused — and then
 * offered that widening, plus a `%` in the sidecar's name, as the reason a sidecar was out of
 * reach. It was not: NTFS minted `NOTETX~1.JSO` as a second name for the sidecar, in an alphabet
 * with neither a `%` nor the marker in it.
 *
 * So this block asserts what the rule *does* — reserve a word across every backend — and asserts
 * nothing about reachability, which is `local-fs-store.test.ts`'s to prove structurally, by where
 * a key can land rather than by how it is spelled.
 */
describe('the reserved marker is refused in every spelling, at every segment position', () => {
  it('refuses every case variant, as a key and as a prefix', () => {
    const variants = [
      'note.txt.__objectstore_meta__.json',
      'note.txt.__objectstore_meta__.JSON',
      'note.txt.__OBJECTSTORE_META__.json',
      'note.txt.__ObjectStore_Meta__.Json',
      'NOTE.TXT.__OBJECTSTORE_META__.JSON',
      `note.txt${OBJECT_METADATA_SUFFIX}`,
      `note.txt${OBJECT_METADATA_SUFFIX.toUpperCase()}`,
    ];
    for (const variant of variants) {
      expectRule(variant, 'reserved-name');
      expectRule(`dir/${variant}`, 'reserved-name');
      expectRule(`${variant}/inner.txt`, 'reserved-name');
      expect(() => toObjectPrefix(variant)).toThrow(UnsafeObjectKeyError);
    }
  });

  it('reserves the word for every backend, so a backend may build a name out of it', () => {
    // What the reservation is worth, stated exactly: appending the suffix to any legal key yields
    // a string this guard refuses. What it is NOT worth is on the tin — it says nothing about
    // names the *filesystem* mints afterwards, which is why no backend may treat it as a lock.
    for (const key of LEGAL) {
      expect(() => toObjectKey(`${key}${OBJECT_METADATA_SUFFIX}`)).toThrow(UnsafeObjectKeyError);
    }
  });
});

/**
 * The declared cost of the "filter, not a rewriter" decision, asserted rather than only written
 * down in `key-safety.ts`'s header — so the header's three worked examples cannot rot (ADR-0016).
 */
describe('the documented cost: a literal "%" cannot be stored through this guard', () => {
  it('refuses a bare "%" as malformed encoding rather than storing it', () => {
    expectRule('50%.txt', 'malformed-encoding');
  });

  it('refuses a well-formed escape as non-canonical rather than storing it under the decoded name', () => {
    expectRule('Q1 report 100%25.pdf', 'non-canonical');
    expectRule('100%2Fdone.txt', 'non-canonical');
    // The point of the rule: neither of those is a traversal, and the previous revision stored
    // both — at `Q1 report 100%.pdf` and `100/done.txt`, not where the caller asked.
    expect(decodeURIComponent('Q1 report 100%25.pdf')).toBe('Q1 report 100%.pdf');
    expect(decodeURIComponent('100%2Fdone.txt')).toBe('100/done.txt');
  });
});
