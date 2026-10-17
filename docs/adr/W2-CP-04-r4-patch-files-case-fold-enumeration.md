# W2-CP-04 — Round 4: B2-PATCH closed by enumerating every site the case-fold property must hold, not just the one the counter-example named

Status: accepted
Date: 2026-09-07
Decided by: W2-CP-04 (skills), round 4
Scope: `apps/web/server/skills/keys.ts`, `apps/web/server/skills/handlers.ts`

## Context — round 3 fixed two of three sites and claimed all of them

`docs/adr/0048-a-repair-is-applied-at-every-site-the-root-cause-reaches-and-the-sites-are-enumerated-from-the-code.md`
names this task by name: *"the admission grammar and the case-fold collision check, on
`POST /api/skills` and on `PATCH`'s `removeFiles` [were repaired]; `PATCH`'s `files` array — the
third place a caller-supplied path becomes a `store.put` key [was left defective]."*

Round 4's confirmer reproduced B2 — the frozen list's own defect — on the one route round 3 never
gave the check to:

```
POST /api/skills {d1, [SKILL.md]} -> 201
PATCH /api/skills/d1 {"files":[{"path":"SKILL.md", b64("THE REAL SKILL\n")},
                               {"path":"skill.md",  b64("impostor\n")}]}
  -> 200 {"skill":{"name":"d1", ..., "instructions":"impostor\n",
                   "fileCount":1,"files":[{"path":"SKILL.md","sizeBytes":9}]}}
on disk -> ["SKILL.md"]   (9 bytes, "impostor\n")
```

— and a second shape the two-entry probe cannot exercise, because nothing in the *request* collides
with anything else in the *request*: a single `files` entry that aliases a file the skill already
has.

```
POST /api/skills {a8, [SKILL.md, description: real]} -> 201
PATCH /api/skills/a8 {"files":[{"path":"skill.md", b64("---\ndescription: HIJACKED\n---\nEVIL\n")}]}
  -> 200 {"skill":{..., "description":"HIJACKED", "instructions":"EVIL\n", "fileCount":1}}
on disk -> ["SKILL.md"]
```

Both are the same root cause named in `docs/adr/W2-CP-04-file-path-admission-grammar.md`'s
Decision 1 — a caller-supplied path reaching a store key without the case-fold check — reaching a
third site that check was never applied to, exactly as ADR-0048 describes.

## The property, stated once (ADR-0048 step 1)

**No caller-supplied relative path becomes a `skillFileKey` store key without passing (a) the
admission grammar (`isAdmissibleRelativePath`, unchanged this round) and (b) a case-fold collision
check — against every other path introduced in the same request, and, for a `PATCH`, against every
path the skill's directory already contains.**

Clause (b)'s second half — "against what already exists" — is new to this round's statement of the
property. Round 3's version of the property (`W2-CP-04-file-path-admission-grammar.md`, "within the
admitted alphabet, case folding is decidable") was correct but scoped to comparing a batch of new
paths against each other; it said nothing about a batch of exactly one new path against a store that
already has files. That silent scoping is what let the single-entry shape above through even where
the two-entry check would have existed.

## Enumerating the crossings from the code (ADR-0048 step 2)

`grep -n "skillFileKey(" apps/web/server/skills/handlers.ts`, then classifying each call's second
argument as caller-controlled or constant:

```
349:  const skillMd = await store.get(skillFileKey(meta.name, SKILL_MD_FILENAME));       constant
421:    decoded.push({ key: skillFileKey(name, file.path), bytes });                     caller-controlled — importSkill
687:      puts.push({ key: skillFileKey(name, file.path), bytes });                      caller-controlled — patchSkill (files)
694:      deletes.push(skillFileKey(name, relativePath));                                caller-controlled — patchSkill (removeFiles)
714:      const before = await store.get(skillFileKey(name, SKILL_MD_FILENAME));         constant
741:    const skillMdStillPresent = await store.get(skillFileKey(name, SKILL_MD_FILENAME)); constant
746:        await store.put(skillFileKey(name, SKILL_MD_FILENAME), {                     constant
```

Three caller-controlled sites, not two: `importSkill`'s `files`, `patchSkill`'s `files`, and
`patchSkill`'s `removeFiles`. The first and third already carried a case-fold check before this
round (`validateImportBody`'s inline collision logic; `removesSkillMdByName`). The second — line
687, `patchSkill`'s `files` — carried none. That is the whole defect, named by grepping the sink
(`skillFileKey`) rather than by re-running the counter-example that happened to land on it.

No other call turns a caller-supplied string into a `skillFileKey` argument in this file:
`skillMetaKey(record.name)` (the only other place a caller-supplied string reaches a store key) uses
`name`, which `isValidSkillName`'s grammar (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`) admits only in
lower case — no two admitted names can ever differ only by case, so this site has no case-fold
question to answer at all, and is excluded from the enumeration on that ground rather than by
omission.

## The repair — one guard, seeded per call site (ADR-0048 step "applied at every one")

`keys.ts#createCaseFoldGuard` is now the single implementation both `validateImportBody` (`POST`)
and `patchSkill` (`PATCH`'s `files`) call:

* `validateImportBody` seeds it with `[]` — a new import has no prior files to collide with — and
  otherwise behaves exactly as round 3 shipped it (this was a refactor of working code into the
  shared function, not a behaviour change; see Evidence below for the tests proving parity).
* `patchSkill` seeds it with every relative path `walkFiles(store, skillFilesPrefix(name))` returns
  for the skill's *existing* directory — `SKILL.md` included — read before this request's own
  `store.put`/`store.delete` calls run, then checks every `files[i].path` against it, in request
  order, refusing with `409 colliding_paths` on the first collision and writing nothing (the check
  runs entirely before the `puts`/`try` block that performs any mutation).

Seeding from the existing directory is what closes the single-entry shape: `guard.check('skill.md')`
against a guard seeded with `['SKILL.md']` reports the collision with no second `files` entry
required, because the "other spelling" it is being compared against is the seed, not a sibling in
the same array.

**`removeFiles` is unchanged.** Round 3's `removesSkillMdByName` already refuses any `removeFiles`
entry that case-folds to `SKILL.md`, which the frozen list confirmed still holds; ADR-0048's method
is to find every site the root cause reaches, not to re-derive a site that is already correct.

**Declared, deliberate cost — a same-request `removeFiles`+`files` rename is refused, not guessed
at.** `patchSkill` writes every `files` entry before running any `removeFiles` delete (Decision 2 of
the round-3 ADR), so `{"removeFiles":["notes.txt"],"files":[{"path":"NOTES.TXT",...}]}` — a
case-only rename — cannot safely be allowed without knowing whether the backend's `store.delete` for
one spelling also removes the other on a case-insensitive filesystem, which is precisely the
"backend behaviour no grammar predicts" class the read-back exists for, not something this task
verifies for every backend. `createCaseFoldGuard` is seeded from the *existing* directory without
excluding paths that also appear in `removeFiles`, so this combination is refused as a collision —
the caller does the rename as two requests. This is the same "409, not a silently merged 201" choice
`validateImportBody`'s own check already makes for two same-request writes, applied here to a
same-request write-plus-remove.

## Making the enumeration a gate (ADR-0048 step 3)

`apps/web/server/skills/case-fold-enumeration.test.ts` reads `handlers.ts`'s real
`ts.SourceFile` (ADR-0030: the compiler decides, not a regex) and asserts, by exact count, the
argument-expression enumeration in the table above: two `skillFileKey(name, file.path)` sites, one
`skillFileKey(name, relativePath)` site, four `skillFileKey(name/meta.name, SKILL_MD_FILENAME)`
sites — and fails by name, quoting the unrecognised expression and its line, on any call site whose
second argument is not one of those four spellings. A fifth caller-controlled site added later —
whatever it is named — changes the derived count and fails this test the moment it exists, before
anyone has to remember to write a matching probe for it. A second test in the same file counts
`createCaseFoldGuard(` call sites (must be exactly 2) and occurrences of the identifier
`removesSkillMdByName` (must be at least 2), so removing a guard call while leaving its
`skillFileKey` call standing also fails, not just adding an unguarded new one.

## Evidence

Both frozen-list probes, replayed against `apps/web/server/skills/handlers.test.ts`'s real
local-filesystem `ObjectStore`, on this host:

```
$ pnpm --filter web test -- run skills/handlers.test.ts -t "B2-PATCH"
 ✓ patchSkill > refuses a two-entry PATCH files array that collides case-fold — the exact B2-PATCH counter-example
 ✓ patchSkill > refuses a single-entry PATCH files array that aliases an existing file — no second entry required
```

(Full pasted `pnpm test` output, with the real run's pass/fail counts, is in this round's report —
not transcribed here per ADR-0016: a number is generated or absent, never retyped by hand into an
ADR that itself is not the thing that ran the command.)

Also driven this round, proving the fix does not regress the ordinary case:

* `still allows re-supplying SKILL.md's own exact spelling` — an ordinary content edit
  (`files: [{"path":"SKILL.md",...}]` against an existing `SKILL.md`) is not a collision.
* `rejects a duplicate exact path within one PATCH files array, the same as POST does` — a gap the
  same enumeration pass surfaced (two identical `files[i].path` entries in one `PATCH` were
  previously unchecked, unlike `POST`'s `duplicate_path`), closed as part of the same guard rather
  than left as a fourth thing to track separately.
* Every round-2/round-3 test named in `docs/adr/W2-CP-04-file-path-admission-grammar.md`'s own
  Evidence section still passes unchanged — this round's refactor of `validateImportBody`'s inline
  collision `Map` into a call to the shared `createCaseFoldGuard` is behaviour-preserving.

**Attacked with the adversarial shapes prior rounds found, replayed against the newly-guarded
route**, none of which reopen B2-PATCH or regress round 3:

1. `PATCH .../files: [{"path":"SKILL.md::$DATA",...}]` — refused at `validatePatchBody`'s
   `isAdmissibleRelativePath` (`inadmissible_path`, `400`), before this round's guard ever runs;
   unchanged from round 3.
2. `PATCH .../files: [{"path":"notes (draft).txt",...}]` — refused by the same grammar
   (`inadmissible_path`), for the same declared reason round 3 already stated; this round's guard
   never sees it either.
3. Two *different* new files in one `PATCH` that do not collide (`scripts/run.sh`,
   `notes/todo.txt`) — both written, `fileCount` increases by two, proving the guard does not
   over-refuse unrelated paths.

## Consequences

* `docs/adr/W2-CP-04-file-path-admission-grammar.md`'s "Declared gaps" bullet naming this exact gap
  is struck through and pointed here — see that file's own edit this round. Its sentence stated the
  limit ("only for `removeFiles`, not for `files`") and withdrew it in the same clause ("cannot forge
  ... `SKILL.md`"), which is the ADR-0031 defect named for the fourth consecutive round; this record
  is what makes the withdrawn half true instead of removing the sentence and leaving the claim
  unexamined.
* `handlers.ts`'s comment above `patchSkill`'s post-delete read-back is rewritten this round to name
  both arrays' guards explicitly, rather than asserting "every alias ... is already refused" while
  meaning only `removeFiles`.
* The next task that adds a fourth place a caller-supplied skill file path reaches a store key will
  fail `case-fold-enumeration.test.ts` the moment that call exists, with the unrecognised expression
  and its line number in the failure message — not a re-read of this ADR, which is the whole point
  of making the enumeration a gate instead of a paragraph someone has to remember to reread.
