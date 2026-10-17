# W2-CP-03 — A key or prefix is safe because one decode-then-validate function said so, checked twice

Status: accepted
Date: 2026-09-05
Decided by: W2-CP-03 (ObjectStore)
Scope: `packages/core/src/storage/**`

## Context

The Wave 2 plan's acceptance criterion: "a path traversing out of its workspace prefix is
refused BY CONSTRUCTION, proven with all three of: a `..` segment, an absolute path, and a
percent-encoded form." This task's dispatch adds the reason the wording is that specific: a prior
sub-wave (2a) shipped a declared gap where a traversal predicate had, in its own words, "NO CALL
SITE outside its own unit test", and a verifier used the unguarded paths to read another
workspace's rows. A predicate nobody calls is not a guard; it is documentation of an idea.

R-15 §1e (research note R-15) records the shape the local-filesystem attack takes
and one trap in it: a naive `rel.startsWith('..')` check both rejects the legal filename
`..config/x.txt` and accepts the empty key `''`, which resolves to the storage root itself. It also
records, honestly, that the local-filesystem guard it probed *accepts* a percent-encoded traversal
form (`w1/..%2f..%2fetc`) as "an ordinary filename … but only if the HTTP layer has not already
decoded it once" — a conditional correctness this task's acceptance criterion cannot rely on,
because nothing here controls whether every future caller's HTTP layer decoded first.

## Decision

One function, `evaluateRelativePath` in `key-safety.ts`, decides every key and prefix for every
backend. It is a **filter, never a rewriter**: its only non-throwing result is the identical string
it was given. It:

1. Decodes the input **exactly once** with `decodeURIComponent`, and uses the decoded form to
   *judge* with — never as the value it returns. A malformed sequence is refused outright rather
   than treated as licence to skip the check. Decoding before splitting is what makes the third
   required proof possible: splitting into segments first would see `..%2f..%2fetc` as one
   legal-looking segment containing no literal `/`.
2. Rejects, as an explicit named rule rather than falling through: a malformed percent sequence: a
   control character (raw or decoded): a backslash: a leading `/` or drive letter (raw or revealed
   by decoding): an empty segment: a segment that is exactly `.` or `..`: and a segment ending in
   the reserved metadata suffix (below).
3. Ends with the positive assertion the whole module rests on — `decoded === raw`, rule
   `non-canonical` — and returns `raw` unchanged. So the accepted set is exactly the fixed points
   of `decodeURIComponent` that also pass every check above; that is the positive assertion
   ADR-0015 asks for, not a blocklist of shapes remembered from an incident.

### Why a filter, and not a canonicaliser (verification round 2)

The first revision of this module returned the **decoded** string as the canonical key. That was
wrong, and W2-CP-03's verification round 1 built the counter-example: the guard runs three times per
operation (see the two call sites below, plus `apps/web/server/files/handlers.ts` at the HTTP edge),
and a rewriting guard is not idempotent, so three applications meant three different decodes.
`toObjectKey('a%252fb')` returned `'a%2fb'`; applying it again returned `'a/b'`. `POST /api/files`
answered `201` naming `a%2fb`, wrote the bytes to `a/b` — silently overwriting an unrelated object —
and minted an id that then addressed the victim on `GET` and `DELETE`. The same non-idempotence gave
`uploadFile` an input its first guard call accepted and a later one refused, which escaped the route
as a framework 500 while the comment beside the `catch` claimed a documented 400.

Two repairs were available: apply the guard exactly once at a named boundary, or make it idempotent.
Applying it once was rejected — it turns a structural property into a rule every future caller has to
remember, which is exactly the "predicate nobody calls" failure this ADR's Context is about. Making
the guard total and idempotent needs no discipline from anyone: `f(x) ∈ {x, throw}` gives
`f(f(x)) = f(x)` for every `x` by construction, and `key-safety.test.ts`'s "the guard is a filter,
not a rewriter" block asserts it over the whole legal and illegal corpus rather than a sample.

### The reserved metadata marker — a name reservation, and nothing more (rounds 1-4)

`local-fs-store.ts` records an object's content type in a sidecar file. Until round 4 it named that
file by appending `.__objectstore_meta__.json` to the object's own name, and its `list()` filtered
that suffix back out. Round 1 found the suffix documented as "never a legal object key" while being
a perfectly legal one: `POST /api/files` accepted `note.txt.__objectstore_meta__.json` with a `201`, so an
uploader could choose the `Content-Type` that `GET /api/files/:id` served for someone else's
`note.txt`, invisibly to `list()`, and have it destroyed as collateral when that object was deleted.

Round 2's repair declared the suffix in `key-safety.ts` and refused it with
`segment.endsWith(OBJECT_METADATA_SUFFIX)` on every segment. **Round 3 showed that this closed one
string, not the class**, and reproduced all of F3's evidence against it. Two mechanisms, both
measured with `node:fs` on this branch's own stated dev platform (Windows 11) rather than argued:

```
writeFile('A.TXT'); readFile('a.txt')      -> 'AAA'     (NTFS folds case; so does APFS by default)
writeFile('w.json'); writeFile('w.json::$DATA', 'FORGED'); readFile('w.json') -> 'FORGED'
```

So `note.txt.__objectstore_meta__.JSON` was accepted by the guard and landed on the victim's
sidecar anyway, and `note.txt.__objectstore_meta__.json::$DATA` reached the same file without
ending in the suffix at all. An exact-case tail comparison cannot survive transformations the
guard does not perform. Round 3 made two changes, and offered the second as load-bearing — which is
the claim round 4 falsified:

1. **The rule is now about a marker, not a suffix.** `OBJECT_METADATA_MARKER`
   (`__objectstore_meta__`) is refused by the `reserved-name` rule *anywhere* in a segment, on
   **every** segment of a key or prefix, and **without regard to case** — folded both down and up,
   because neither fold is a superset of the other for every code point (`'ſ'` upper-cases to
   `'S'`, and Windows' own uppercase table folds it the same way). It is declared in the
   backend-agnostic guard, not in the backend, so "which keys are legal" stays one answer for every
   backend — the property the shared contract suite depends on.
2. **The sidecar's name was given a `%`, because the accepted set contains no `%` at all.**
   `OBJECT_METADATA_SUFFIX` became `` `.%${OBJECT_METADATA_MARKER}%.json` ``. The reasoning — no
   transformation of the caller's string introduces a `%` — is true, and **round 4 showed the
   conclusion does not follow from it, because the attacker never needed a `%`:**

```
dir /x  <metadata sidecar of note.txt>
28  NOTETX~1.JSO  note.txt.%__objectstore_meta__%.json
```

   `NOTETX~1.JSO` is the 8.3 short name NTFS mints for that file *after* the guard has run. It
   contains no `%` and no marker, so it is a legal key; it is blind-guessable from the victim's
   name (the first six `%`-free alphanumerics, then `~1.JSO`); `NtfsDisable8dot3NameCreation = 2`
   is the stock Windows 11 default on the system volume; and putting it overwrote the victim's
   sidecar, forged the content type `get`/`list`/`GET /api/files` reported, was hidden from its own
   listing, and was deleted as collateral with the victim. It hit the exact
   `.claude/skills/<name>/SKILL.md` shape W2-CP-04 depends on, via `SKILLM~1.JSO`.

   The `%` argument reasons about transformations **of the caller's string**. The filesystem
   transforms in the other direction: it invents a second name for a file this module created. A
   string function cannot see that, and no widening of it ever will.

**So the rule stopped being the defence.** `OBJECT_METADATA_SUFFIX` is `.__objectstore_meta__.json`
again — an ordinary, recognisable name — and the `reserved-name` rule is kept for what it is
actually worth: a *name reservation* shared across backends, so any backend may build internal
names out of the marker knowing no caller's key spells it. It is not a lock, it is not claimed to
be one, and `contract.ts` says so in the block that tests it.

### What actually keeps a sidecar out of reach: two trees, not a clever name (round 4)

The root cause of rounds 1, 2 and 3 is one thing, and it is not the rules: **a name derived by
appending to a caller-controlled key inherits every alias the namespace mints for that key** — case
folds, 8.3 short names, `::$DATA` streams, and whatever the next filesystem does. Round 2's own
carried note said the fix might have to be structural ("a parallel directory, or a hash-named
sidecar, rather than a broader guard"); round 4 is the second failure of the same cause, so that is
what round 4 does. A digest-named sidecar was rejected for the same reason as a `%`-named one: a
digest sitting in the object tree gets an 8.3 alias of its own.

```
<rootDir>/objects/workspaces/<id>/note.txt                              the bytes
<rootDir>/metadata/workspaces/<id>/note.txt.__objectstore_meta__.json   its content type
```

Every key resolves under `objects/` and only there: `toFsPath` joins the validated key onto that
directory, and the guard refuses `..`, an absolute path, a drive letter, a backslash and an empty
segment, so a key cannot climb out of it — which is this task's *second acceptance criterion*, now
carrying a second load. `metadata/` is a sibling of that tree, not a place inside it. The two
namespaces do not intersect, so it does not matter what a key is spelled like, nor what second name
NTFS, APFS or anything else mints for a file: no key addresses a sidecar, because every key
resolves to a path inside `objects/`.

That last sentence is about *path resolution*, and it is stated that way on purpose. Whether the
directory tree those paths land in stays inside `objects/` is the filesystem's business, not the
guard's: a junction or symlink planted inside `objects/` — which needs a write into `rootDir` from
outside this API — makes the tree extend wherever it points, and `node:fs` follows it. That is out
of band rather than an API privilege escalation, and it is declared on this task's PR rather than
repaired here; the honest form of the claim is the one above, not "no key reaches anything outside
`objects/`" in a world where a directory entry can be a portal.

`NOTETX~1.JSO` is now simply a legal key naming an ordinary object. It is *accepted*, deliberately:
refusing it would be a fourth spelling rule, and a spelling rule is what failed three times.

```
put('note.txt', 'text/plain'); put('NOTETX~1.JSO', '{"contentType":"text/html"}') -> ACCEPTED
get('note.txt').contentType = text/plain        <- unchanged
list("")  = ["note.txt:text/plain", "NOTETX~1.JSO:null"]   <- both visible, nothing hidden
metadata/ = ["note.txt.__objectstore_meta__.json", "NOTETX~1.JSO.__objectstore_meta__.json"]
```

Two further properties, so the split is not a new hiding place. Sidecars cannot collide with each
other through short names: a write always uses the long name, and a name ending in the
26-character suffix is never itself an 8.3 short name (which is at most 12 characters), so a
sidecar write can only ever resolve to the sidecar it names. And `list` no longer filters anything
**by name** — the object tree holds objects only, so no name a caller can write is hidden from its
own listing, which was the invisibility half of F3 in every round. It does still skip entries that
are neither a file nor a directory (`!entry.isFile()`), a filter about *kind*: a junction or
symlink planted inside `objects/` out of band is reachable through `get`/`list` and absent from its
parent's listing. Round 4's flat "filters nothing" overstated that, and it is declared on this
task's PR alongside the junction gap below.

The cost is real and is not hidden: `put` and `delete` touch two trees instead of one, so they can
drift. Round 4 priced that drift as "a content type and nothing else" for both, and round 5 showed
that was false for `put` and remains true only for one of them. Each is now stated separately:

* **`put` — a content type, and nothing else.** The object write is the operation; the sidecar
  write is best effort and is wrapped in a `catch`. A sidecar failure leaves the object complete
  and readable with `contentType: null`, which is the degradation this backend already applied to a
  missing or unparseable sidecar, and `put` resolves. A *stale* sidecar from an earlier object at
  the same key is removed on that path, so a caller never sees new bytes described by an old
  content type; if that removal fails too, the stale value survives, and that is the one residual
  of this path. The object is written first for the same reason the sidecar is second: the reverse
  order would leave a content type describing bytes that are not there.

  Round 5 forced this from the public API with two uploads — `POST note.txt`, then
  `POST NOTETX~1.JSO/x.txt`, where the second key's metadata *directory* collides with the first
  key's sidecar *file* through that file's NTFS 8.3 alias. Without the `catch`, `mkdir` threw
  `EEXIST` out of the route handler as a framework `500` **after the upload had landed on disk** —
  an API reporting failure for a write that succeeded. It now answers `201` with the content type
  unknown, which is what the sentence above always claimed.

* **`delete` — not wrapped, and it can cost more than a content type.** If the object is removed
  and the sidecar removal then throws, the call throws with the object already gone and an orphaned
  sidecar behind it, which a later object at the same key adopts if its own sidecar write also
  fails. That requires a metadata tree this process cannot write to, so it is out of band rather
  than reachable from the API. It is declared on this task's PR and not repaired here.

`contract.ts` asserts the marker class against every backend over a table of spellings and says
plainly what it does *not* establish; `local-fs-store.test.ts` asserts the structure (two trees,
`list` filtering nothing, every accepted key landing inside `objects/`) and re-runs round 4's
counter-example against the real 8.3 alias read from the filesystem with `dir /x`, skipping where
that concept does not exist rather than asserting a guessed alias.

It runs at **two call sites**, named so a reader does not have to find them:

* `object-store.ts`'s `createScopedObjectStore`, on the caller's own unprefixed key, before the
  workspace prefix is computed at all.
* Every backend's own put/get/delete/list (today, `local-fs-store.ts`'s `toFsPath`/`toFsDir`), on
  the full, already-prefixed key — so a backend reached directly, bypassing the scoping wrapper (a
  test, or a future caller), is still guarded.

Both are exercised by `contract.ts`'s shared suite (all three attack strings, against every one of
`put`/`get`/`delete`/`list`, plus a positive check that nothing was written anywhere) and by
`key-safety.test.ts` (the guard's decision on a wider set of inputs, including the ones that must
be *accepted* — `..config/x.txt`, `...hidden/y` — so a guard that rejected everything would not
pass either suite).

### The deliberate trade-off, stated at its real size

The accepted set contains no `%` at all. Not "a vanishingly rare filename that happens to spell a
traversal" — that was the first revision's description of the cost and round 1 was right that it
understated it. Every one of these is refused, and none of them is an attack:

```
toObjectKey("50%.txt")              -> REFUSED malformed-encoding
toObjectKey("Q1 report 100%25.pdf") -> REFUSED non-canonical
toObjectKey("100%2Fdone.txt")       -> REFUSED non-canonical
```

**Declared gap: a file whose name contains a literal `%` cannot be stored through this API.** The
remediation is an explicit transport encoding chosen at the HTTP edge — `x-file-path` carrying a
`base64url` name the way `:id` already does, so the store is never asked to guess whether a `%` was
typed by a user or generated by a client — which is a change to the route contract and to whatever
UI calls it, and belongs with the task that owns that contract.

What is *not* a trade-off any more is the behaviour this replaced. The first revision stored
`100%2Fdone.txt` at `100/done.txt` and `Q1 report 100%25.pdf` at `Q1 report 100%.pdf`: not refused,
not reported — stored somewhere other than where the caller asked. Refusing is visible; relocating
is not, and a caller cannot compensate for what it is not told.

The guard still has to give one answer regardless of whether a caller's own layer already decoded
once, which is what makes "one suite passes against both backends" (the first acceptance criterion)
check one thing rather than two backends that quietly disagree about which keys are legal.

### What this guard cannot decide (ADR-0031)

It judges a string, so it does not and cannot decide whether a legal key would overwrite something,
collide with a folder, or be storable by the backend behind it. One consequence is already known and
carried: the local-filesystem backend on Windows cannot create a file whose name contains `"`, `*`,
`?`, `<`, `>` or `|`, all of which this guard accepts, so such a `put` fails with an `ENOENT`
from `node:fs` rather than a named refusal. That is a backend-portability gap, declared on this PR
and not repaired here.

Round 3 stated the axis that produced its own finding and then withdrew it in the next clause, by
naming a property that supposedly made it moot. Round 4 broke exactly that property. So it is
stated here once, and nothing after it takes it back:

> **This guard cannot decide which distinct strings a particular backend's namespace treats as the
> same name, nor what second names that namespace mints for a file after the guard has run.**

Case folding (JavaScript's Unicode mappings are not NTFS's uppercase table and not APFS's),
normalisation (macOS decomposes; Linux does not; nothing here applies NFKC, so `％` U+FF05 and `﹪`
U+FE6A are ordinary characters to this module), NTFS alternate data streams, and NTFS 8.3 short
names are all outside what a string function can see. The `reserved-name` rule is an
over-approximation of the first of those — the widest *decidable* rule available here, and per
ADR-0031 refusal is its `else` — and it is **not** offered as covering any of the rest.

What follows is a rule for *backends*, which is where ADR-0031's "undecidable must mean refused"
lands once a guard admits it cannot decide: **a backend must not place anything a caller must not
reach at a name derived from a caller's key.** The local-filesystem backend obeys it structurally
(two trees, above); a future S3 backend must either do the same or say in its own header why its
namespace mints no aliases. Three consequences are carried, not repaired, and are declared on this
PR:

* Two *ordinary* keys this guard accepts as different can be one file on the local-filesystem
  backend: `Note.txt` and `note.txt`, and equally `MYDOCU~1.TXT` and `mydocument.txt`. A `put` of
  one therefore overwrites the other. This is a property of that backend's namespace, shared by
  neither the in-memory backend nor S3, and not repairable by a string guard.
* `note.txt::$DATA` is accepted as a key, and on NTFS writing it **replaces `note.txt`'s own
  bytes** — the same shape, stated as the overwrite it is rather than as "aliasing".
* The guard accepts `％` U+FF05, `﹪` U+FE6A and a fully fullwidth marker. Nothing collides on NTFS
  today, so there is no finding — but they fold to `%` and to the marker under NFKC, so a backend
  or transport that ever applies NFKC turns them into live keys.

## Consequences

* The guard's idempotence is what lets the three call sites stay three. `object-store.ts`'s
  scoping wrapper, the backend, and `apps/web/server/files/handlers.ts` each apply it, and none of
  them has to know how many others did — which is the property `key-safety.test.ts`'s "the accepted
  set is closed under the guard" asserts directly.
* A future S3/MinIO backend (blocked on a dependency —
  [W2-CP-03-s3-minio-backend-blocked.md](W2-CP-03-s3-minio-backend-blocked.md)) calls the same
  `toObjectKey`/`toObjectPrefix` before building a `PutObjectCommand`/`GetObjectCommand`, so the
  three attack strings are refused identically on both backends the day it lands — `contract.ts` is
  already written to accept a second `defineObjectStoreContract('S3 (MinIO)', …)` call with no
  other change.
* `packages/core/src/db/schema/files.ts`'s two CHECK constraints (`files_path_shape`,
  `files_path_no_dot_segments`) settle the same question for the `files` metadata table, by a
  different mechanism (a PostgreSQL CHECK, not a TypeScript function) and without this module
  importing it or being imported by it. The two were not cross-checked against each other line by
  line; both independently land on "a positive grammar for a segment, then an explicit rejection of
  `.`/`..`", which is this repository's now-established shape for the same problem.
