/**
 * One property set for both path guards (the storage design, §05 "Path tricks such as ../" and
 * §06 Phase 1, one path checker): the server guard `toObjectKey` and the sandbox guard
 * `normalizeArchivePath` face the same tricks, so they run the same properties. The server guard
 * is a filter (it returns its input or refuses); the sandbox guard is a normaliser, so only the
 * server guard is idempotent. `apps/web` is the one place that may import both packages.
 * On a failure fast-check prints the seed and the shrunk input that reproduce it.
 */
import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage';
import { ArchiveValidationError, normalizeArchivePath } from '@agent-workspace/runtime/transfer';
import fc from 'fast-check';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

import { relativeRuntimePath } from '../runtimes/contract';
import { isAdmissibleRelativePath } from '../skills/keys';

type PathGuard = (raw: string) => string;

const RUNS = { numRuns: 500 };
const NUL = String.fromCharCode(0);
const ROOT = '/root';

/** Every character as `%XX`, `times` times over: `encodeAll('.', 2)` is `%252E`. */
function encodeAll(text: string, times: number): string {
  let encoded = text;
  for (let round = 0; round < times; round += 1) {
    encoded = Array.from(
      encoded,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    ).join('');
  }
  return encoded;
}

const nestedEncoding = fc
  .tuple(fc.constantFrom('..', '.', '/', '\\', 'C:', NUL), fc.integer({ min: 1, max: 6 }))
  .map(([text, times]) => encodeAll(text, times));

const segment = fc.oneof(
  nestedEncoding,
  fc.constantFrom(
    '..',
    '.',
    '%2e',
    '%2E',
    '%252e',
    '%2525252e',
    '%2f',
    '%5c',
    '\\',
    'C:',
    'c:',
    NUL,
    '\u2024',
    '\uff0e',
    'x',
    'a b',
  ),
  fc.string({ unit: fc.constantFrom('a', 'b', '0', '-', '_', '.', '%', '2', 'e'), maxLength: 4 }),
);

const separator = fc.constantFrom('/', '\\', '//', '%2f');

const structuredPath = fc
  .tuple(
    fc.constantFrom('', '/', './', '\\'),
    fc.array(fc.tuple(segment, separator), { minLength: 1, maxLength: 5 }),
    fc.constantFrom('', '/'),
  )
  .map(
    ([lead, parts, trail]) =>
      `${lead}${parts.map(([s, sep], i) => (i === parts.length - 1 ? s : `${s}${sep}`)).join('')}${trail}`,
  );

const anyPath = fc.oneof(
  { arbitrary: structuredPath, weight: 4 },
  {
    arbitrary: fc.string({
      unit: fc.constantFrom('.', '%', '2', 'e', 'f', '5', 'c', '/', '\\', 'a', ':', 'C', NUL),
      maxLength: 12,
    }),
    weight: 1,
  },
  { arbitrary: fc.string(), weight: 1 },
);

/** Inputs both guards must refuse. `a//b`, `./x` and `a/` are cleaned, not refused, by the sandbox. */
const HOSTILE_CORPUS = [
  '../x',
  '..',
  '.',
  '',
  'x/..',
  'a/../../x',
  '%2e%2e/x',
  '%2E%2E/x',
  '%252e%252e/x',
  '%2525252e%2525252e/x',
  '..%2fx',
  '..\\x',
  'a\\..\\..\\x',
  '%5c..%5cx',
  'C:/x',
  'c:\\x',
  './C:/x',
  '/etc/passwd',
  '%2fetc%2fpasswd',
  '\\\\srv\\share',
  `a${NUL}b`,
  '%00',
  'a/%2500b',
];

const isPersistPathRefusal = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof UnsafeObjectKeyError;

/** The result, then each percent-decoding of it (at most three, stopping at a malformed one). */
function decodings(value: string): string[] {
  const all = [value];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      all.push(decodeURIComponent(all.at(-1) ?? ''));
    } catch {
      break;
    }
  }
  return all;
}

/** `undefined` when the guard refuses with its own error; any other throw is a failure. */
function verdict(
  guard: PathGuard,
  isRefusal: (error: unknown) => boolean,
  raw: string,
): string | undefined {
  try {
    return guard(raw);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return undefined;
  }
}

function describePathGuardProperties(
  name: string,
  label: string,
  guard: PathGuard,
  isRefusal: (error: unknown) => boolean,
  options: { idempotent: boolean },
): void {
  describe(name, () => {
    // @story US-STO-06
    it(`[US-STO-06][unit][run] throw only their own refusal (${label})`, () => {
      fc.assert(
        fc.property(anyPath, (raw) => {
          verdict(guard, isRefusal, raw);
        }),
        RUNS,
      );
    });

    // @story US-STO-06
    it(`[US-STO-06][unit][run] accepted paths have a safe shape (${label})`, () => {
      fc.assert(
        fc.property(anyPath, (raw) => {
          const accepted = verdict(guard, isRefusal, raw);
          if (accepted === undefined) return;
          expect(accepted.split('/').filter((s) => s === '' || s === '.' || s === '..')).toEqual(
            [],
          );
          expect(accepted).not.toMatch(/^\//u);
          expect(accepted).not.toMatch(/^[A-Za-z]:/u);
          expect(accepted).not.toContain('\\');
          expect(accepted).not.toContain(NUL);
        }),
        RUNS,
      );
    });

    // @story US-STO-06
    it(`[US-STO-06][unit][run] accepted paths never leave the root (${label})`, () => {
      fc.assert(
        fc.property(anyPath, (raw) => {
          const accepted = verdict(guard, isRefusal, raw);
          if (accepted === undefined) return;
          for (const spelling of decodings(accepted)) {
            expect(posix.resolve(ROOT, spelling).startsWith(`${ROOT}/`), spelling).toBe(true);
          }
        }),
        RUNS,
      );
    });

    // @story US-STO-06
    it(`[US-STO-06][unit][run] refuse the shared hostile corpus (${label})`, () => {
      for (const hostile of HOSTILE_CORPUS) {
        expect(verdict(guard, isRefusal, hostile), JSON.stringify(hostile)).toBeUndefined();
      }
    });

    if (options.idempotent) {
      // @story US-STO-06
      it(`[US-STO-06][unit][run] are idempotent (${label})`, () => {
        fc.assert(
          fc.property(anyPath, (raw) => {
            const accepted = verdict(guard, isRefusal, raw);
            if (accepted === undefined) return;
            expect(guard(accepted)).toBe(accepted);
          }),
          RUNS,
        );
      });
    }
  });
}

describePathGuardProperties(
  'server: key-safety',
  'server',
  toObjectKey,
  (error) => error instanceof UnsafeObjectKeyError,
  { idempotent: true },
);

describePathGuardProperties(
  'sandbox: runtime/transfer',
  'sandbox',
  normalizeArchivePath,
  (error) => error instanceof ArchiveValidationError,
  { idempotent: false },
);

describe('call sites refuse what key-safety refuses', () => {
  it('the launcher never accepts a persist path key-safety refuses', () => {
    fc.assert(
      fc.property(anyPath, (raw) => {
        const accepted = verdict(relativeRuntimePath, isPersistPathRefusal, raw);
        if (accepted === undefined) return;
        expect(toObjectKey(accepted)).toBe(accepted);
      }),
      RUNS,
    );
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] the skill grammar never admits a path key-safety refuses', () => {
    fc.assert(
      fc.property(anyPath, (raw) => {
        if (!isAdmissibleRelativePath(raw)) return;
        expect(toObjectKey(raw)).toBe(raw);
      }),
      RUNS,
    );
  });
});

describe('server and sandbox agree', () => {
  // @story US-STO-06
  it('[US-STO-06][unit][run] sandbox accepts every path the server accepts', () => {
    fc.assert(
      fc.property(anyPath, (raw) => {
        const server = verdict(toObjectKey, (error) => error instanceof UnsafeObjectKeyError, raw);
        if (server === undefined) return;
        expect(normalizeArchivePath(raw)).toBe(server);
      }),
      RUNS,
    );
  });

  // @story US-STO-06
  it('[US-STO-06][unit][run] sandbox cleans the paths the server refuses as non-canonical', () => {
    const cleaned = { 'a//b': 'a/b', './x': 'x', 'a/': 'a' };
    for (const [untidy, tidy] of Object.entries(cleaned)) {
      expect(() => toObjectKey(untidy), untidy).toThrow(UnsafeObjectKeyError);
      expect(normalizeArchivePath(untidy), untidy).toBe(tidy);
    }
  });
});
