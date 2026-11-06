/**
 * The single guard that decides whether a caller-supplied string is safe to use as an
 * `ObjectStore` key or list prefix — spec §16, R-15 §1e, W2-plan.md's second acceptance
 * criterion for W2-CP-03: *"a path traversing out of its workspace prefix is refused BY
 * CONSTRUCTION, proven with all three of: a `..` segment, an absolute path, and a
 * percent-encoded form."*
 *
 * ## Why this lives in one function, and why every caller runs it
 *
 * `docs/adr/W2-CP-03-object-key-safety.md` is the decision record; this comment is the summary a
 * reader needs without opening it. The wave's own dispatch is explicit about the failure mode to
 * avoid: sub-wave 2a shipped a declared gap where a traversal predicate had "NO CALL SITE outside
 * its own unit test", and a verifier used the unguarded paths it was supposed to describe to read
 * another workspace's rows. The fix here is structural rather than a promise: `evaluateRelativePath`
 * is the *only* place a string is turned into a safe key or prefix, `local-fs-store.ts` and
 * `object-store.ts`'s `createScopedObjectStore` both call it (named in their own headers), and
 * neither can construct a filesystem path or hand a key to a backend without going through it
 * first — there is no second, unguarded route to the same effect.
 *
 * ## This guard is a filter, never a rewriter — and that is what makes it idempotent
 *
 * **The property, stated so it can be tested:** for every string `x`, `toObjectKey(x)` either
 * throws {@link UnsafeObjectKeyError} or returns `x` itself — the *identical* string, never a
 * transformed one. `key-safety.test.ts`'s "the guard is a filter, not a rewriter" block asserts
 * exactly that over every legal and every illegal input in this repository's corpus, and
 * `toObjectKey(toObjectKey(x)) === toObjectKey(x)` follows from it rather than being hoped for.
 *
 * That property is not decoration. `object-store.ts`'s `createScopedObjectStore` runs this guard
 * on the caller's relative key, then the backend runs it again on the full prefixed key, and
 * `apps/web/server/files/handlers.ts` runs it once more on the way in from HTTP — three
 * applications per operation, by design (two named call sites plus the HTTP edge). An earlier
 * revision of this module *decoded* percent-encoding and returned the decoded string as the
 * canonical key, which made those three applications three different decodes: `a%252fb` was
 * accepted by the first pass as `a%2fb`, by the second as `a/b`, and the bytes landed at a key two
 * decodes away from the one `POST /api/files` had already answered `201` for — overwriting an
 * unrelated object, and minting an id that then addressed the victim. A guard that only ever
 * returns its own input cannot do that, however many times it is applied.
 *
 * ## One decode pass — to *judge* with, never to rewrite with (ADR-0015)
 *
 * A key arrives as an opaque string. It is decoded exactly once with `decodeURIComponent`, and
 * the decoded form is what every check below is run against: that order is what makes the third
 * required proof possible, because splitting *before* decoding would see `..%2f..%2fetc` as one
 * exotic-but-legal segment (it contains no literal `/`), exactly the shape that let a traversal
 * through in the past. The decoded string is then thrown away. The last check in the function is
 * the positive assertion that the input was already its own decoding — `decoded === raw`, rule
 * `non-canonical` — so the only strings this module accepts are the fixed points of
 * `decodeURIComponent` that also pass every other check, and the returned key is the input.
 *
 * **What that costs, precisely, with no softening.** The accepted set contains no `%` at all, and
 * a reader can check each of these three claims by calling the exported guard:
 *
 *   - `toObjectKey('50%.txt')` throws `malformed-encoding` — a bare `%` is not valid
 *     percent-encoding, so the check that would judge this string cannot run, and ADR-0015 says a
 *     check that cannot run must fail rather than wave the string through un-decoded.
 *   - `toObjectKey('Q1 report 100%25.pdf')` throws `non-canonical` — it decodes to
 *     `Q1 report 100%.pdf`, which is a different string.
 *   - `toObjectKey('100%2Fdone.txt')` throws `non-canonical` — it decodes to `100/done.txt`,
 *     a different string naming a different place.
 *
 * So a file whose name contains a literal `%` **cannot be stored through this API**, and that is a
 * real limitation, not a vanishing one — `docs/adr/W2-CP-03-object-key-safety.md` records it as a
 * declared gap with the remediation (an explicit transport encoding chosen at the HTTP edge, so
 * the store never has to guess whether a `%` was typed or generated). What the previous revision
 * did instead was worse and is what this one refuses to do: it *silently stored the file
 * somewhere else*. Refusing is visible; relocating is not.
 *
 * R-15 §1e notes the opposite tension for the *local-filesystem* guard specifically ("percent
 * encoding is not path syntax, so it is an ordinary filename … but only if the HTTP layer has not
 * already decoded it once"); this module resolves it uniformly for every backend, because the
 * guard must give identical answers to `put`/`get`/`delete` regardless of which backend is behind
 * them — W2-plan's first acceptance criterion ("one suite passes against both backends") would not
 * hold if the two disagreed about which keys are legal.
 *
 * ## The reserved metadata marker
 *
 * {@link OBJECT_METADATA_MARKER} — the word `__objectstore_meta__` — is refused here by the
 * `reserved-name` rule, on *every* segment of a key rather than only the last, **anywhere** in a
 * segment rather than only at its end, and **without regard to case**. It is a name *reservation*,
 * shared by every backend: a backend that keeps per-object metadata may build its file names out
 * of this word knowing no caller's key spells it, and "which keys are legal" stays one answer for
 * every backend rather than a local-fs quirk a future S3 backend would not share.
 *
 * **This rule does not make anything unreachable, and nothing may be built as if it did.** That is
 * the lesson of three verification rounds on `local-fs-store.ts`, each of which broke a *different*
 * equivalence in the filesystem's namespace while this rule kept getting wider:
 *
 *   1. Round 1 — the suffix was documented as illegal and was not checked at all.
 *   2. Round 2 — it was checked with `endsWith` at exact case; NTFS and APFS fold case, so
 *      `note.txt.__objectstore_meta__.JSON` reached the same file. (`writeFile('A.TXT')` then
 *      `readFile('a.txt')` returns the bytes, measured on this repository's stated dev platform.)
 *      Also `writeFile('w.json::$DATA')` replaces the contents of `w.json`, so a key ending in
 *      NTFS stream syntax reaches a file whose name it does not end with.
 *   3. Round 3 — the rule was widened to case-blind containment and the backend's sidecar name was
 *      given a `%` (no accepted key contains one). NTFS then supplied the alias itself:
 *      `NOTETX~1.JSO` is the 8.3 short name of `note.txt.%__objectstore_meta__%.json`, contains no
 *      `%` and no marker, and is blind-guessable from the victim's name.
 *
 * The pattern is one thing: **a rule about spelling cannot protect a name derived from a
 * caller-controlled key**, because the namespace mints its own aliases for that name and the guard
 * is not the one doing the minting. Reasoning about what the *caller's* string can be transformed
 * into — which is all a string function can do — never covers what the *filesystem* creates in the
 * other direction. `local-fs-store.ts` accordingly stopped deriving reachability from spelling: its
 * sidecars live in a sibling tree no key resolves into, and this rule is defence in depth behind
 * that, not the thing holding the door.
 *
 * ## The judgement itself
 *
 * The judgement mirrors the two CHECK constraints already on the `files` table
 * (`packages/core/src/db/schema/files.ts`: `files_path_shape` and `files_path_no_dot_segments`),
 * deliberately — this module does not read that file and could drift from it, but the same
 * two-part shape (a positive grammar for what a segment *is*, then an explicit rejection of `.`
 * and `..`) is the one this repository has already settled on for "a path inside one tree; no
 * escape". What is different here is that `files.path` is validated once, at the moment a
 * database row is written; an `ObjectStore` key is validated on *every* `put`/`get`/`delete`/
 * `list`, because bytes are the thing a traversal actually reaches.
 *
 * Every branch below either returns the input unchanged or throws a named
 * {@link UnsafeObjectKeyError} — there is no branch that returns something "probably fine". The
 * final `return` is reached only because every prior check passed, never because none of them
 * matched a known-bad shape (ADR-0015's "positive assertion, not a blocklist").
 *
 * ## What this cannot decide (ADR-0031)
 *
 * This guard judges a *string*. It does not know what already exists in a store, so it cannot and
 * does not decide whether a legal key would overwrite something, collide with a folder, or exceed
 * a backend's own key-length or character limits. Those are the store's to answer, and
 * `object-store.ts` documents `put` as replacing whatever was there.
 *
 * It equally cannot decide **which distinct strings a particular backend's namespace treats as the
 * same name, nor what second names that namespace mints for a file after this guard has run.**
 * Case folding, Unicode normalisation (macOS decomposes; Linux does not; nothing here applies
 * NFKC, so `％` U+FF05 and `﹪` U+FE6A are ordinary characters to this module), NTFS alternate
 * data streams, and NTFS 8.3 short names are all outside what a string function can see. That
 * statement stands unqualified: there is no clause after it saying some other property makes it
 * moot, because three rounds of verification found one each time.
 *
 * What follows from it is a rule for *backends*, not for this file: **a backend must not place
 * anything a caller must not reach at a name derived from a caller's key.** `local-fs-store.ts`
 * obeys it by putting sidecars in a tree no key resolves into. A backend that instead derived an
 * internal name by appending to the key would be relying on exactly the reasoning this guard
 * cannot supply.
 *
 * Two consequences for the local-filesystem backend are declared on this task's PR and not
 * repaired here, because no string guard can repair them: two *ordinary* keys this guard accepts
 * as different can be one file (`Note.txt` and `note.txt`; also `MYDOCU~1.TXT` and
 * `mydocument.txt`), and `note.txt::$DATA` is accepted as a key while `writeFile` of it replaces
 * `note.txt`'s own bytes.
 */

/** Every distinct reason `evaluateRelativePath` can refuse a string, named for logs and tests. */
export type ObjectKeyRejectionRule =
  | 'malformed-encoding'
  | 'control-character'
  | 'backslash'
  | 'absolute'
  | 'empty-key'
  | 'empty-segment'
  | 'dot-segment'
  | 'reserved-name'
  /** Refused only by a store over an NTFS folder: Win32 reads it as another name or a device. */
  | 'windows-name'
  | 'non-canonical';

/**
 * The reserved word a backend builds its own internal file names out of. Refused by
 * {@link evaluateRelativePath} — case-insensitively, and *anywhere* in a segment rather than only
 * at its end — so no caller-supplied key or prefix component can contain it. See this module's
 * header, "The reserved metadata marker", for why containment rather than a suffix match, and for
 * what the guard cannot decide about a particular backend's namespace.
 */
export const OBJECT_METADATA_MARKER = '__objectstore_meta__';

/**
 * The suffix `local-fs-store.ts` gives a content-type sidecar *inside its metadata tree*. It is
 * refused as a key by the `reserved-name` rule, which makes it a recognisable name rather than a
 * protected one: what keeps a sidecar out of a caller's reach is the tree it lives in — see
 * `local-fs-store.ts`, "Two trees under one root", and this module's header for why no spelling
 * of a name can do that job.
 */
export const OBJECT_METADATA_SUFFIX = `.${OBJECT_METADATA_MARKER}.json`;

/**
 * `true` when `segment` contains {@link OBJECT_METADATA_MARKER} under *any* of the case mappings
 * this guard can compute: as given, folded down, and folded up. Both directions are tested rather
 * than one, because neither is a superset of the other for every code point — `'ſ'` (LATIN
 * SMALL LETTER LONG S) upper-cases to `'S'` but lower-cases to itself, so a segment spelling the
 * marker with a long s is caught only by the upward fold, and Windows' own uppercase table folds
 * that same character to `'S'` too.
 */
function containsReservedMarker(segment: string): boolean {
  return (
    segment.includes(OBJECT_METADATA_MARKER) ||
    segment.toLowerCase().includes(OBJECT_METADATA_MARKER) ||
    segment.toUpperCase().includes(OBJECT_METADATA_MARKER.toUpperCase())
  );
}

/**
 * Thrown by every function in this module that refuses a string. Never thrown for "this key
 * might be fine" — only for a positively identified reason, named on the error so a caller (and
 * a test) can assert *which* rule fired rather than merely that something did.
 */
export class UnsafeObjectKeyError extends Error {
  /** Which of the named rules refused the input. */
  public readonly rule: ObjectKeyRejectionRule;
  /** The original, undecoded string this module was given. */
  public readonly raw: string;

  public constructor(rule: ObjectKeyRejectionRule, raw: string, detail: string) {
    super(`object key/prefix ${JSON.stringify(raw)} refused (${rule}): ${detail}`);
    this.name = 'UnsafeObjectKeyError';
    this.rule = rule;
    this.raw = raw;
  }
}

/**
 * A control character (code points 0-31, plus DEL at 127), in either the raw string or the
 * once-decoded one. Built from character codes rather than a regex escape written directly in
 * source, so nothing that normalises source text can turn the escape into the byte itself.
 */
const CONTROL_CHARACTER = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
);

/** A Windows drive letter at the start of a path — `C:`, `d:` — which names an absolute path. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Decode a string exactly once. `decodeURIComponent` throws `URIError` on a malformed percent
 * sequence (`%zz`, a lone `%`, a truncated multibyte sequence); that is treated as a positive
 * reason to refuse the whole string rather than as licence to use it un-decoded, per ADR-0015 —
 * "a check that cannot run must fail".
 */
function decodeOnce(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new UnsafeObjectKeyError(
      'malformed-encoding',
      raw,
      'contains a percent sequence that is not valid percent-encoding',
    );
  }
}

/** The result `evaluateRelativePath` returns when it does not throw. */
export interface SafeRelativePath {
  /** The path, split on `/`. Empty only when the root itself was requested. */
  readonly segments: readonly string[];
  /**
   * The key every backend stores against. Always the *identical* string this function was given —
   * see the module header's "filter, never a rewriter". `''` only for the root.
   */
  readonly canonical: string;
}

/**
 * The one function every `ObjectStore` key and list prefix passes through before it touches a
 * backend. See the module header for why there is exactly one of these, and for the property that
 * `canonical` is always the input string unchanged.
 *
 * `allowRoot` distinguishes `list`'s prefix (the empty string legitimately means "the workspace
 * root") from `put`/`get`/`delete`'s key (which must name something).
 */
export function evaluateRelativePath(raw: string, allowRoot: boolean): SafeRelativePath {
  const decoded = decodeOnce(raw);

  if (CONTROL_CHARACTER.test(raw) || CONTROL_CHARACTER.test(decoded)) {
    throw new UnsafeObjectKeyError(
      'control-character',
      raw,
      'contains a control character, raw or percent-decoded; a NUL byte reaches node:fs and ' +
        'throws ERR_INVALID_ARG_VALUE there, so this is refused at the boundary instead (R-15 §1e)',
    );
  }
  if (decoded.includes('\\')) {
    throw new UnsafeObjectKeyError(
      'backslash',
      raw,
      'contains a backslash; keys are separated by "/" only, on every platform this runs on',
    );
  }
  if (decoded.startsWith('/')) {
    throw new UnsafeObjectKeyError(
      'absolute',
      raw,
      'begins with "/" (raw or revealed by percent-decoding), which is an absolute path',
    );
  }
  if (DRIVE_LETTER.test(decoded)) {
    throw new UnsafeObjectKeyError(
      'absolute',
      raw,
      'begins with a drive letter, which is an absolute path on Windows',
    );
  }
  if (decoded === '') {
    // `decodeURIComponent('') === ''`, so `raw` is the empty string too and returning it is
    // returning the input, as this function's contract requires.
    if (allowRoot) return { segments: [], canonical: raw };
    throw new UnsafeObjectKeyError('empty-key', raw, 'is empty; put/get/delete need a named key');
  }

  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new UnsafeObjectKeyError(
        'empty-segment',
        raw,
        'contains an empty segment ("//", or a leading/trailing "/")',
      );
    }
    if (segment === '.' || segment === '..') {
      throw new UnsafeObjectKeyError(
        'dot-segment',
        raw,
        `contains the segment "${segment}", which would escape its workspace prefix`,
      );
    }
    if (containsReservedMarker(segment)) {
      throw new UnsafeObjectKeyError(
        'reserved-name',
        raw,
        `contains the segment "${segment}", which contains the reserved metadata marker ` +
          `"${OBJECT_METADATA_MARKER}" (compared without regard to case); that word belongs to a ` +
          "backend's own content-type sidecar and is not available to a caller (see " +
          'key-safety.ts, "The reserved metadata marker")',
      );
    }
  }

  // The positive assertion this whole module rests on, and the last thing checked so that every
  // rejection above reports the specific rule rather than this general one: the input must already
  // BE its own decoding. Everything above judged `decoded`; this is what makes judging `decoded`
  // a judgement about `raw`, and it is what makes the returned key identical to the input.
  if (decoded !== raw) {
    throw new UnsafeObjectKeyError(
      'non-canonical',
      raw,
      `is not its own percent-decoding (it decodes to ${JSON.stringify(decoded)}); an object key ` +
        'is stored literally, so a string that means something else once decoded is ambiguous ' +
        'and is refused rather than silently stored under the decoded name',
    );
  }
  return { segments, canonical: raw };
}

/**
 * Validate a `put`/`get`/`delete` key. Throws {@link UnsafeObjectKeyError}; otherwise returns the
 * key **unchanged** — this function is a filter, not a normaliser, so it is idempotent and every
 * one of its call sites sees the same string (module header; `key-safety.test.ts` asserts it).
 */
export function toObjectKey(raw: string): string {
  return evaluateRelativePath(raw, false).canonical;
}

/**
 * Validate a `list` prefix. Unlike {@link toObjectKey}, the empty string is legal here — it names
 * the workspace root — and everything else the same guard rejects for a key is rejected here too.
 * Returns the prefix unchanged, with the same filter-not-normaliser property.
 */
export function toObjectPrefix(raw: string): string {
  return evaluateRelativePath(raw, true).canonical;
}

/**
 * `name` when it is a legal key, `null` when the guard refuses it. For listings only: a bucket can
 * hold names other tools wrote (a console folder's zero-byte `name/`, a bare `%`), and one of those
 * must drop out of a listing rather than fail it.
 */
export function addressableObjectName(name: string): string | null {
  try {
    return toObjectKey(name);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return null;
    throw error;
  }
}

/** Normalise an adapter's configured key prefix to `''` or `'<validated>/'`. */
export function storeKeyPrefix(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '';
  return `${toObjectPrefix(value.replace(/\/+$/u, ''))}/`;
}

/** Validate `key` and join it under an adapter prefix from {@link storeKeyPrefix}. */
export function prefixedObjectKey(prefix: string, key: string): string {
  return `${prefix}${toObjectKey(key)}`;
}

/** Validate a `list` prefix and join it under an adapter prefix from {@link storeKeyPrefix}. */
export function prefixedListPrefix(prefix: string, key: string): string {
  const safe = toObjectPrefix(key);
  return safe === '' ? prefix : `${prefix}${safe}/`;
}
