# W2-CP-04 — Round 3: a skill file's relative path is admitted by grammar, not screened by a blocklist

Status: accepted
Date: 2026-09-06
Decided by: W2-CP-04 (skills), round 3
Scope: `apps/web/server/skills/keys.ts`, `apps/web/server/skills/handlers.ts`

## Context — this task's own two rounds are the case study ADR-0044 was written from

`docs/adr/0044-a-caller-supplied-name-is-admitted-by-a-grammar-never-screened-by-a-blocklist.md`
landed on `main` for this round, naming this exact task twice in its own table of prior failures.
This record is the implementation of that decision for this task's two open items, not a new
design — ADR-0044 states the grammar and the two-halves structure; nothing below chooses an
approach ADR-0044 left open.

**B1.** Round 1 refused `removeFiles` entries equal to the literal string `"skill.md"`. Round 2
widened that to a case-folded compare. The confirmer defeated round 2 with
`removeFiles: ["SKILL.md::$DATA"]` — NTFS's default-data-stream syntax — which
`'SKILL.md::$DATA'.toLowerCase() !== 'skill.md'` never matches, so `store.delete` ran and destroyed
`SKILL.md` on this host's real filesystem. Round 2's own read-back ran *after* that delete, so it
could only report the loss (`skill_md_lost`, "re-import this skill") — a detector, not a guard —
and its comment claiming *"the fix that finally held there was structural"* was false the moment
the confirmer's request ran.

**B2.** The identical alias, reaching `POST /api/skills` instead: `files: [{"path": "SKILL.md",
...}, {"path": "SKILL.md::$DATA", ...}]` answered `201` for a two-file manifest that was actually
stored as one file, the survivor carrying the *second* entry's bytes under the *first* entry's
name. Round 2's case-fold duplicate check never fired because `'skill.md::$data'` does not equal
`'skill.md'`.

Both defeats are one root cause: `apps/web/server/skills/handlers.ts` never had a rule that decided
whether a path was **admissible** at all. It had two rules that decided whether a path was
*dangerous by a spelling someone had already thought of* — first an exact string, then a
case-fold — and `key-safety.ts` (`packages/core/src/storage/key-safety.ts`, outside this task's
`Owns` globs) is the same shape one level down: its checks name control characters, a leading `/`,
a drive letter, `..`, and a reserved marker, and none of them mentions `:` or `$`, because nobody
had reasoned about NTFS alternate data streams when that list was written. A blocklist is a claim
about a set the program cannot enumerate; ADR-0044 calls that the ADR-0031 shape, and the fix for
it is a positive grammar, not a wider list.

## Decision 1 — `keys.ts#isAdmissibleRelativePath`, the grammar ADR-0044 states, applied here

A skill file's relative path is admitted only when, split on `/`:

* every segment matches `[A-Za-z0-9][A-Za-z0-9._-]*`,
* no segment ends in `.` or a space,
* no segment is `.` or `..`,
* the whole path is at most `SKILL_PATH_MAX_BYTES` (4096, the conventional `PATH_MAX` most
  filesystems this platform runs on already enforce) UTF-8 bytes.

This is exactly ADR-0044's stated grammar — not narrowed, not widened. `SKILL.md::$DATA` is
refused because `:` and `$` are outside the class; the reason given is the rule name, never a claim
about what NTFS does with a colon. `isAdmissibleRelativePath` is checked in both
`validateImportBody` (`POST /api/skills`, every `files[i].path`) and `validatePatchBody`
(`PATCH /api/skills/:name`, every `files[i].path` and every `removeFiles[i]`), **before** any of
those strings is compared to anything else or turned into a store key — so B1 and B2 are now closed
at validation time, before `store.put`/`store.delete` ever runs, with `400 inadmissible_path` naming
the rule.

`key-safety.ts`'s own guard still runs a second time, unconditionally, when `store.put`/`store.get`/
`store.delete` execute — this task adds a check in front of it, it does not remove or replace the
one behind it (defence in depth; that guard belongs to W2-CP-03 and is outside this task's `Owns`
globs to change).

**Declared cost, stated rather than designed around (ADR-0044's explicit instruction).** This
grammar refuses legitimate names: `notes (draft).txt`, any accented or CJK filename, `Q3 report.pdf`
with its embedded space, a leading-dot "hidden" file. None of those characters was added to the
class to make a test pass, because doing that one character at a time is the identical blocklist
failure this ADR exists to end, aimed the other way. A caller who needs one of those names cannot
use it through this API today; that is this round's declared gap, not a defect to route around.

**Within the admitted alphabet, case folding is decidable, stated once and not withdrawn.** Every
character `isAdmissibleRelativePath` allows is ASCII: a letter, digit, `.`, `_` or `-`. ASCII
case-folding has no direction-dependent exception — nothing here behaves like `'ſ'` (folds up to
`'S'`, not down to itself) or Turkish `İ`/`ı`, because those code points are outside the class
already, refused by the character rule rather than reasoned about by a case rule. So
`validateImportBody`'s collision check and `patchSkill`'s "does this remove `SKILL.md`" check are
now real, decidable comparisons over a bounded set — not the guess `key-safety.ts`'s own header
says it cannot make about an unbounded filesystem namespace.

## Decision 2 — verify after write stands alongside the grammar; a destructive mutation captures first and restores on failure

ADR-0044's second half is explicit that the read-back does not replace the grammar and is not
replaced by it. `patchSkill` keeps a post-delete read of `SKILL.md`, for whatever alias neither this
task nor ADR-0044's authors have found yet — but round 2's version of that check ran only *after*
`store.delete`, with nothing captured, so a genuine loss could only be reported: `500 skill_md_lost`,
"re-import this skill." That is a detector, and its own comment calling it "structural" was false.

Round 3's version captures `SKILL.md`'s bytes and content type **immediately before** the
destructive half of the request (`store.delete`) runs — after any `files` puts in the same request
have already executed, so a capture taken here reflects what this request itself just made current,
not a stale pre-request copy. If the post-mutation read-back then finds `SKILL.md` gone, the
captured bytes are written straight back with `store.put` and the request is refused as
`409 skill_md_removal_rejected`, naming that the file was restored. A request whose loss this task
cannot yet explain now leaves the skill exactly as it was, not permanently broken and unrepairable
through this API.

## Evidence

Both named counter-examples were re-run verbatim against the confirmer's own probe
(`apps/web/server/skills/zzz-conf2-ads.test.ts`, copied in, run, and deleted per instruction) on
this host's real NTFS-backed store:

```
B1: PATCH /api/skills/demo-ads {"removeFiles":["SKILL.md::$DATA"]}
  -> 400 {"error":{"code":"inadmissible_path", ...}}
  on disk -> ["notes.txt","SKILL.md"]
  later GET -> 200 {"skill":{...,"description":"real","instructions":"BODY\n",
                    "fileCount":2,"files":[{"path":"SKILL.md",...},{"path":"notes.txt",...}]}}

B2: POST /api/skills {demo-ads2, [SKILL.md, "SKILL.md::$DATA"]}
  -> 400 {"error":{"code":"inadmissible_path", ...}}
  on disk -> []
  export -> 404 {"error":{"code":"skill_not_found", ...}}
```

`SKILL.md` is untouched in B1 (both files still present, `description` still `"real"`, no
`skill_md_lost`/`skill_md_removal_rejected` — the grammar closes this before the read-back is ever
reached); B2 creates nothing at all, rather than a one-file skill carrying the impostor's bytes.

**Attacked with three admissible-looking strings the frozen list does not name**, against the real
local-filesystem store, none of which reopened B1/B2:

1. A zero-width space appended to `SKILL.md` (`U+200B`) via `removeFiles` — refused,
   `inadmissible_path` (outside the character class), `SKILL.md` untouched.
2. A right-to-left override character disguising a supporting-file path (`U+202E`) alongside a real
   `SKILL.md` on import — refused, `inadmissible_path`; nothing written at all (validation runs
   before any write).
3. `SKILL..md` (a double dot mid-segment, admissible by the grammar) imported alongside `SKILL.md`
   — both created as two genuinely distinct files; no collision.

A fourth probe — a Windows reserved device name (`CON`) as a supporting-file path, which the
grammar admits (`C`, `O`, `N` are all in the class) — was **accepted** and written successfully on
this host/Node version, with no crash and no effect on `SKILL.md`. This is not a B1/B2 regression
(it neither destroys nor forges `SKILL.md`), but it is a real property this grammar does not decide,
carried below rather than fixed, because "which strings a particular OS/filesystem treats specially
beyond the ones this grammar already refuses" is exactly the unenumerable question ADR-0044 says a
program cannot answer from inside itself — the grammar's job is to admit a small, safe alphabet, not
to enumerate every OS-specific special case within it.

`server/skills/keys.test.ts` and `server/skills/handlers.test.ts` carry these cases (and the ones
above) as permanent tests: `71` tests in `apps/web/server/skills/` pass, `pnpm build`, `typecheck`,
`lint` and `format:check` all pass, and the only red file in the full `pnpm test` run is
`tests/no-route-answers-503.test.ts` (W2-INT-02's, ADR-0038 — expected per this round's dispatch).

## Declared gaps carried, not fixed this round

* **Windows reserved device names** (`CON`, `NUL`, `AUX`, `PRN`, `COM1`-`COM9`, `LPT1`-`LPT9`) are
  grammar-admissible and not specially rejected. Probed above with no observed harm on this
  host/Node version, but this task makes no claim about every host this could run on.
* **Per-segment length** is not checked, only the whole path's byte length. A single segment near
  4096 bytes is admitted even though most filesystems cap an individual filename far lower (255
  bytes on NTFS/ext4); such a request would fail at the backend rather than at this task's
  validation layer, surfacing as whatever `store.put` throws rather than a clean `400`.
* ~~**`PATCH`'s own `files` array has no case-fold collision check**~~ — **false as written, and
  withdrawn in the same clause it stated the limit in (the ADR-0016/ADR-0031 defect this task's PR
  body and this file's own comment on `patchSkill`'s read-back repeated in three consecutive
  rounds).** This was round 4's B2-PATCH, not a gap: `PATCH .../d1 {"files":[{"path":"SKILL.md",...},
  {"path":"skill.md",...}]}` answered `200`, one file survived under the first entry's name carrying
  the second entry's bytes, and a *single*-entry `PATCH .../a8 {"files":[{"path":"skill.md",...}]}`
  against an existing `SKILL.md` silently overwrote it the same way — no second entry required. Both
  are fixed, not carried; see `docs/adr/W2-CP-04-r4-patch-files-case-fold-enumeration.md` for the
  repair, its enumeration, and its evidence.
* Every gap `docs/adr/W2-CP-04-skill-storage-keys.md` already declared stands unchanged: the
  non-atomic import/patch, the absent delete route, the three stale `[name]/export/route.ts`
  pointers, the frontmatter reader's YAML limits, no S3/MinIO, no `AgentSkillRepository`.

## Consequences

* `validateImportBody`'s and `patchSkill`'s in-code comments are rewritten in this round to say
  only what is true after it: the case-fold checks are now decidable-and-real, not the "cannot run,
  so it must refuse" and "structural" claims a run had already falsified. No sentence surviving from
  round 2 makes a claim this round's evidence contradicts.
* A caller that previously relied on a path this grammar refuses (a space, a paren, a non-ASCII
  character) needs a different name; there is no migration for existing stored skills with such
  names because none could have been created through this API in the first place (the grammar is
  enforced on every write, not retrofitted onto a scan of existing data).
