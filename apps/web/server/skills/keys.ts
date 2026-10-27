/**
 * How one skill's files and this platform's own record about it are laid out inside the
 * per-workspace `ObjectStore` — and the reason the layout has exactly two top-level prefixes,
 * never one derived from the other.
 *
 * ## The rule this module is built to obey
 *
 * `docs/adr/W2-CP-03-object-key-safety.md` — read in full before touching this file — spent four
 * verification rounds on one lesson, stated there as a rule for backends: **"a backend must not
 * place anything a caller must not reach at a name derived from a caller's key."** Three attempts
 * to protect a metadata sidecar by *spelling* (an exact suffix, a case-blind marker, a `%`-escaped
 * marker) each fell to a different alias the filesystem itself minted for the derived name — case
 * folding, then an NTFS 8.3 short name. The fix that held was structural: the sidecar moved to a
 * sibling tree that no object key resolves into, so no spelling of a key can ever address it,
 * regardless of what a filesystem does to a name after the guard has run.
 *
 * This module is the same shape, one level up. A skill's own files (`SKILL.md` and whatever
 * supporting files a caller uploads) are addressed by a **caller-controlled name and a
 * caller-controlled relative path** — a caller invents both. This platform's own record about that
 * skill (today: just `enabled`, and the two timestamps) is *not* something a caller supplies, and a
 * caller must not be able to overwrite it by naming one of their own files cleverly. Deriving the
 * metadata record's key by *appending* to the skill's own key — `skills/<name>/SKILL.md.meta.json`,
 * or anything shaped like it — would be exactly the pattern `W2-CP-03-object-key-safety.md` found
 * already failed three times for a sibling problem: a caller who names a supporting file
 * `SKILL.md.meta.json` would be naming this platform's own record, and `key-safety.ts`'s
 * `reserved-name` rule (built for the marker `__objectstore_meta__`, not for any word this module
 * invents) does not know the word "meta" matters here and would not refuse it. This task's own
 * decision record, `docs/adr/W2-CP-04-skill-storage-keys.md`, is the write-up of the paragraphs
 * below.
 *
 * ## The two prefixes, and why they can never collide
 *
 * ```
 * skills/<name>/<relativePath>     the skill's own files — SKILL.md and supporting files
 * skill-meta/<name>.json           this platform's own record — never a byte a caller supplied
 * skill-deletes/<name>.json        a pending delete's marker and the owner it recorded (ADR-0077 D3)
 * skill-builtin/<name>.json        the digest of the built-in skill this platform last installed
 * ```
 *
 * The third and fourth prefixes, `"skill-deletes/"` and `"skill-builtin/"`, are as fixed as the
 * other two and differ from every other prefix before `<name>` begins, so the argument below
 * covers them the same way.
 *
 * `<name>` is caller-controlled (see {@link isValidSkillName} for what a caller may spell it as),
 * but the two literal prefixes — `"skills/"` and `"skill-meta/"` — are not. They are written here,
 * by this module, and nowhere else in this task's code composes a key by any other route. Because
 * `ObjectStore` compares keys as exact strings with no normalisation between them (that is
 * `key-safety.ts`'s whole "filter, never a rewriter" contract), a string that starts with the
 * literal seven characters `"skills/"` is never equal to one that starts with the literal eleven
 * characters `"skill-meta/"` — not for any value of `<name>`, `<relativePath>`, or anything a caller
 * could spell either as. A caller's own relative path is joined onto `skills/<name>/` and nowhere
 * else; it never reaches a position in the string where it could produce a leading `skill-meta/`.
 * That is the structural argument ADR-0032 asks for, not a spelling rule about what `<relativePath>`
 * may contain.
 *
 * ## What this module does not decide
 *
 * Every key built here is still run through `key-safety.ts`'s guard — twice more, at
 * `createScopedObjectStore` and again inside the backend — before it touches a filesystem. This
 * module decides *which* string to hand that guard; it does not re-implement any part of the
 * guard's own judgement, and it does not know or care which backend is behind the `ObjectStore` it
 * is handed.
 */
import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import { SKILL_FILE_PATH_MAX_BYTES, SKILL_NAME_PATTERN } from '@indx-workspace/contracts/skills';

/** The top-level prefix under which a skill's own files live. Never derived from a caller's key. */
export const SKILL_FILES_PREFIX = 'skills';

/** The top-level prefix under which this platform's own record about a skill lives. See header. */
export const SKILL_META_PREFIX = 'skill-meta';

/**
 * The top-level prefix under which a pending delete's marker lived (ADR-0077 D3). Nothing writes it
 * now: `skills.pending_delete` holds the record.
 */
// storage-bridge(#1699): read-only until the marker objects are removed (#1676)
export const SKILL_DELETE_PREFIX = 'skill-deletes';

/**
 * The top-level prefix under which the record of an installed built-in skill lived. Nothing writes
 * it now: `skills.builtin_digest` holds the digest.
 */
// storage-bridge(#1699): read-only until the marker objects are removed (#1676)
export const SKILL_BUILTIN_PREFIX = 'skill-builtin';

/**
 * The top-level prefix under which a published revision's bytes live (SDK-19, N-1). Nothing but
 * `publishSkillRevisionWithId` writes there, and no mutable builder in this module can produce it:
 * `skills/<name>/<n>/…` would have collided with a legal supporting file called `<n>/…`, so a
 * revision gets a fourth literal prefix, disjoint from the others before `<name>` begins.
 */
export const SKILL_REVISIONS_PREFIX = 'skill-revisions';

/**
 * A skill's directory name, exactly as spec §7 shows it — `.claude/skills/<name>/`. Slug-shaped
 * on purpose and on the record: this is the identical grammar
 * `packages/core/src/db/schema/skills.ts`'s `skills_name_shape` CHECK constraint enforces
 * (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`), stated here as a positive assertion rather than
 * imported from that schema, because this task has no reachable import of it
 * (`packages/core/src/db/**` is outside this task's `Owns` globs and is not re-exported from
 * `@agent-workspace/core/db` — see `docs/adr/W2-CP-04-skill-storage-keys.md`, "Why this does not
 * touch Postgres"). Using the same regex rather than inventing a looser one means a name this API
 * accepts today is a name Postgres would also accept once a repository for that table exists, so no
 * later migration has to reject data this API already let in. The pattern is the contracts'
 * `SKILL_NAME_PATTERN`.
 *
 * A single lower-case-and-digit slug is also, incidentally, never able to contain a `/`, a `..`
 * segment, or the `key-safety.ts` reserved marker (`__objectstore_meta__` has underscores, which
 * this grammar excludes) — so a name this function accepts is always exactly one path segment, and
 * `skills/<name>` and `skill-meta/<name>.json` always name what they appear to.
 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/**
 * The grammar `docs/adr/0044-a-caller-supplied-name-is-admitted-by-a-grammar-never-screened-by-a-blocklist.md`
 * states, applied to a skill file's caller-supplied relative path — round 3's repair for B1/B2.
 *
 * ## Why this exists, and why it is not another entry in `key-safety.ts`'s list
 *
 * Round 2 tried to keep `SKILL.md` safe by widening a *blocklist*: first an exact-string compare
 * against `"skill.md"`, then a case-folded one. Both rounds were defeated by a spelling nobody had
 * enumerated — `SKILL.md::$DATA`, NTFS's default-data-stream syntax, which `'…'.toLowerCase() !==
 * 'skill.md'` never matches and which `packages/core/src/storage/key-safety.ts`'s guard (outside
 * this task's `Owns` globs, and itself a set of named, enumerated rules — control characters, a
 * leading `/`, a drive letter, `..`, the reserved marker — none of which mentions `:` or `$`)
 * passes straight through, because nobody had reasoned about alternate data streams when that list
 * was written. ADR-0044 names the fix for exactly this shape: stop enumerating what is dangerous
 * and ask instead whether the string is **admissible** — a positive assertion (ADR-0015) that ends
 * in an explicit rejecting `else`, never a scan for one more forbidden spelling.
 *
 * ## The grammar, exactly as ADR-0044 states it — not widened, not narrowed
 *
 * A relative path is admissible when, split on `/`:
 *
 *   - every segment matches `[A-Za-z0-9][A-Za-z0-9._-]*` (so no empty segment, no segment that
 *     starts with `.`, `-`, `_`, a space, or any character outside that class — `:` and `$`
 *     included, which is what refuses `SKILL.md::$DATA` and would refuse the next NTFS alias too,
 *     without this module ever having heard of it),
 *   - no segment ends in `.` or a space (the two NTFS silently strips on open, which is also what
 *     refuses `SKILL.md.` and `SKILL.md ` — both left `SKILL.md` alone in the round-2 confirmer's
 *     probes precisely because the filesystem treats them as a *different* name from the one being
 *     guarded, and this grammar refuses them outright rather than reasoning about that difference),
 *   - no segment is exactly `.` or `..` (already implied by the first rule, since both start with
 *     `.` and neither has a leading alphanumeric — stated again here because ADR-0044 states it
 *     again, as its own bullet, not as a redundant afterthought this module gets to drop),
 *   - the whole path is at most {@link SKILL_FILE_PATH_MAX_BYTES} UTF-8 bytes.
 *
 * **This grammar refuses legitimate names, and that is a declared cost, not a bug to work around.**
 * `notes (draft).txt` is refused — `(` and `)` are not in the class. So is any filename carrying an
 * accented or CJK character, an `&`, a `#`, or a leading dot (a "hidden file" on Unix). Widening the
 * character class one symbol at a time to let a particular test pass is the exact blocklist failure
 * ADR-0044 was written to end, wearing the opposite polarity — so this module does not do that, and
 * neither should a future caller of it.
 *
 * **Within this alphabet, case folding is decidable**, and stays decidable in both directions
 * without qualification: every character the grammar admits is an ASCII letter, digit, `.`, `_` or
 * `-`, and ASCII case-folding has no surprises comparable to `'ſ'` or Turkish `İ`/`ı` (those live
 * outside the admitted class already, refused by the character-class rule above, not by a case
 * rule). So a case-insensitive compare over two admitted paths — what {@link handlers.ts}'s
 * `patchSkill` and `validateImportBody` both need — is a real check here, not the guess
 * `key-safety.ts`'s own header says it cannot make about an unbounded namespace; it is a check
 * about *this* module's own bounded one.
 */
const PATH_SEGMENT_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `true` when `relativePath` passes key-safety (`toObjectKey`, the storage design, §02: the one path
 * checker, which owns empty, `.`/`..`, absolute and control-character refusals) and every segment
 * (split on `/`) matches the grammar documented above.
 * `false` for anything else — there is no branch that returns `true` because no rule happened to
 * fire; every rule is checked and the path is admitted only once every one of them has passed
 * (ADR-0015: a positive assertion, not the absence of a match).
 *
 * This is the check this task runs before deciding whether to hand a caller's path to
 * `skillFileKey`. Key-safety (`toObjectKey`) runs first, inside this function; `skillFileKey`'s
 * guard runs again later, unconditionally, as defence in depth (see this task's `handlers.ts`). The
 * segment grammar here is what actually closes B1/B2, because it refuses `:` and `$` outright
 * rather than trying to name the alias they spell.
 */
export function isAdmissibleRelativePath(relativePath: string): boolean {
  try {
    toObjectKey(relativePath);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return false;
    throw error;
  }
  if (Buffer.byteLength(relativePath, 'utf8') > SKILL_FILE_PATH_MAX_BYTES) return false;
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment.endsWith('.') || segment.endsWith(' ')) return false;
    if (!PATH_SEGMENT_SHAPE.test(segment)) return false;
  }
  return true;
}

/**
 * The one case-fold collision guard every site that turns a caller-supplied, already-admissible
 * relative path into a `skillFileKey` must run before that path reaches `store.put`/`store.delete`
 * — round 4, ADR-0048's repair for B2-PATCH.
 *
 * ## Why this is a shared function and not, again, an inline `Map` per call site
 *
 * `validateImportBody` (`POST /api/skills`) had this check written inline since round 3. `patchSkill`'s
 * `files` array (`PATCH /api/skills/:name`) had none — not "a weaker version," none — and that gap is
 * exactly what B2-PATCH's confirmer found: `PATCH {"files":[{"path":"SKILL.md",...},
 * {"path":"skill.md",...}]}` answered `200` with one file surviving under the first entry's name and
 * the second entry's bytes, the same shape as B2 on `POST`, reproduced on a route nobody had probed.
 * The two call sites had drifted because each carried its own copy of the same seven lines. This
 * function is the one copy: `validateImportBody` and `patchSkill` both call it now, so a third call
 * site added later either calls this too or is missing an unmistakable step, not a duplicated-and-then-
 * forgotten one.
 *
 * ## What it decides, and what it deliberately does not try to decide
 *
 * Seed it with every path that must not gain a same-request alias — for `POST`, that is empty (a new
 * skill has no prior files); for `PATCH`, that is every relative path the skill's directory already
 * contains, `SKILL.md` included, read via {@link "./tree".walkFiles} *before* this request's own
 * `store.put`/`store.delete` calls run. Then call {@link CaseFoldGuard.check} with each new path in
 * request order, and {@link CaseFoldGuard.add} it immediately after, whether or not it collided —
 * both call sites already do this in a single pass, and this function does not add a second one.
 *
 * `check` returns the prior spelling a path collides with once folded, or `null` — for two reasons a
 * caller must tell apart:
 *
 *   - a path exactly equal to a seeded (existing) path is **not** a collision — it is the ordinary
 *     shape of a `PATCH` that edits a file's content by re-supplying its exact name. `check` never
 *     reports this case, because `seenFolded.get(folded) === path` fails the `!== path` test below.
 *   - a path that differs in spelling from a prior one but folds to the same key **is** a collision,
 *     whether the prior spelling came from this request's own earlier entries (B2's two-entry shape)
 *     or from a file the skill already had before this request began (B2-PATCH's single-entry shape,
 *     `PATCH {"files":[{"path":"skill.md",...}]}` against an existing `SKILL.md` — no second entry in
 *     the request at all, which is why a check scoped to "does this request's own array collide with
 *     itself" is not sufficient on its own for `PATCH`; seeding with the existing tree is what closes it).
 *
 * **Declared, deliberate cost**: this guard does not special-case `removeFiles`. A single request that
 * both removes `notes.txt` and adds `NOTES.TXT` is refused as a collision even though a caller might
 * mean it as a rename, because this task's `patchSkill` writes every `files` entry before running any
 * `removeFiles` delete (`docs/adr/W2-CP-04-file-path-admission-grammar.md`, Decision 2, "after any
 * `files` puts ... have already executed"), and a case-insensitive backend's `store.delete` for one
 * spelling is not this task's to prove will never remove the other. Refusing the combination is the
 * same "409, not a silently merged 201" choice `validateImportBody`'s own collision check already
 * makes, applied to a same-request rename rather than to two same-request writes; a caller who wants a
 * case-only rename does it as two requests. See `handlers.ts#patchSkill`'s own comment at its call
 * site for the enumeration this guard closes.
 */
export interface CaseFoldGuard {
  /** The prior spelling `path` collides with once folded, or `null` if none. Read-only — does not
   * record `path`; call {@link add} for that, in the same order paths are being admitted. */
  check(path: string): string | null;
  /** Record `path` as seen, so a later, differently-spelled `check` against it reports a collision. */
  add(path: string): void;
}

/** A fresh {@link CaseFoldGuard}, pre-seeded with `existingPaths` (pass `[]` for a brand-new skill). */
export function createCaseFoldGuard(existingPaths: readonly string[]): CaseFoldGuard {
  const seenFolded = new Map<string, string>(); // case-folded path -> the spelling first seen
  for (const path of existingPaths) seenFolded.set(path.toLowerCase(), path);
  return {
    check(path: string): string | null {
      const prior = seenFolded.get(path.toLowerCase());
      return prior !== undefined && prior !== path ? prior : null;
    },
    add(path: string): void {
      seenFolded.set(path.toLowerCase(), path);
    },
  };
}

/** The full store key for one of a skill's own files. `relativePath` is not validated here — see
 * `key-safety.ts`'s `toObjectKey`, which every caller of this function must still run the result
 * through before it reaches an `ObjectStore` method (this module's header, "What this module does
 * not decide"). */
export function skillFileKey(name: string, relativePath: string): string {
  return `${SKILL_FILES_PREFIX}/${name}/${relativePath}`;
}

/** The list prefix for every file directly and indirectly under one skill's directory. */
export function skillFilesPrefix(name: string): string {
  return `${SKILL_FILES_PREFIX}/${name}`;
}

/** The full store key for one file of a published revision. */
export function skillRevisionKey(name: string, revision: number, relativePath: string): string {
  return `${SKILL_REVISIONS_PREFIX}/${name}/${String(revision)}/${relativePath}`;
}

/** The list prefix for every file of one published revision. */
export function skillRevisionPrefix(name: string, revision: number): string {
  return `${SKILL_REVISIONS_PREFIX}/${name}/${String(revision)}`;
}

/**
 * The reserved root of the files catalog under which skill files live as `skills`-area rows. The
 * catalog's unique key has no area, so a bare `<name>/…` path would collide with a user's own file
 * of that path; the files API refuses this root, as it does `.attachments/`.
 */
export const SKILL_ROWS_ROOT = '.skills';

/** The catalog folder of one skill's current files: `.skills/<name>`. */
export function skillRowFolder(name: string): string {
  return `${SKILL_ROWS_ROOT}/${name}`;
}

/**
 * The catalog folder of one published revision: `.skills/<name>@<revision>`. `@` is outside the
 * skill name grammar, so it never lists under `skillRowFolder` of another name.
 */
export function skillRevisionRowFolder(name: string, revision: number): string {
  return `${SKILL_ROWS_ROOT}/${name}@${String(revision)}`;
}

/** The list prefix for every revision of one skill, for the skill's delete. */
export function skillRevisionsPrefix(name: string): string {
  return `${SKILL_REVISIONS_PREFIX}/${name}`;
}

/** The full store key for this platform's own record about one skill. See this module's header. */
export function skillMetaKey(name: string): string {
  return `${SKILL_META_PREFIX}/${name}.json`;
}

/**
 * The store key of the marker an earlier release wrote for a pending delete. It is only read, and
 * removed when its skill's delete finishes; while it exists no catalog sync may create the row
 * again, and it records the owner so the owning Builder can finish an interrupted delete.
 */
export function skillDeleteMarkerKey(name: string): string {
  return `${SKILL_DELETE_PREFIX}/${name}.json`;
}

/**
 * The store key of the record an earlier release wrote of what it last installed for a built-in
 * skill (its digest). It is only read, to fill the row's `builtin_digest`.
 */
export function skillBuiltinMarkerKey(name: string): string {
  return `${SKILL_BUILTIN_PREFIX}/${name}.json`;
}

/** The list prefix under which every skill's metadata record lives, for `GET /api/skills`. */

/**
 * Recover a skill's name from one of its metadata records' keys — the inverse of
 * {@link skillMetaKey}. Returns `null` for anything that is not `skill-meta/<name>.json` shaped, so
 * a caller can skip a stray entry rather than crash on it (this module owns the whole of
 * `skill-meta/`, so nothing else should ever write there, but a filesystem backend's own listing
 * is not this module's to trust blindly).
 */
export function skillNameFromMetaKey(key: string): string | null {
  const prefix = `${SKILL_META_PREFIX}/`;
  const suffix = '.json';
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  const name = key.slice(prefix.length, key.length - suffix.length);
  return isValidSkillName(name) ? name : null;
}
