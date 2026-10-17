# ADR-0044 — A caller-supplied name that becomes a filesystem name is admitted by a grammar, never screened by a blocklist

**Status:** accepted
**Date:** 2026-09-06
**Scope:** programme
**Context:** the same defect, third task running, six verification rounds

## Context

Three tasks in Wave 2 have now shipped a guard that decides whether a caller-supplied string is
dangerous by **enumerating the spellings it rejects**. Every one of them was defeated, and never by
the spelling the previous round had just closed.

| Where | Rounds | The alias that won each time |
| --- | --- | --- |
| W2-CP-03, the ObjectStore sidecar | 3 | case fold → NTFS alternate data stream → 8.3 short name |
| W2-CP-04, the `cannot_remove_skill_md` guard | 2 | exact-string `skill.md` → `SKILL.md::$DATA` |
| W2-CP-04, the import collision check | 2 | exact-string duplicate → case fold → `SKILL.md::$DATA` |

The pattern is identical each time and so is the repair each time: the guard is widened by one rule,
and the next round finds one more spelling. W2-CP-04's round 2 widened an exact-string test into a
case-folded one and shipped a comment claiming *"the fix that finally held there was structural"*; the
confirmer defeated it with `SKILL.md::$DATA` — an alias the same comment names — and reproduced the
identical harm: `PATCH removeFiles:["SKILL.md::$DATA"]` destroys `SKILL.md` and the API then answers
`200` for a directory that is not a skill. The import check falls to the same string, storing one file
for a two-file manifest with the survivor carrying the other entry's bytes.

**The reason a blocklist loses is not that the authors were insufficiently thorough.** The namespace
belongs to the operating system, not to the program. NTFS mints aliases — alternate data streams, 8.3
short names, trailing dots and spaces stripped on open, case folding — and the set of them is not
enumerable from inside the process. A rule that says *"reject these"* is a claim about a set the
program cannot see, which is the ADR-0031 shape: undecidable, and therefore obliged to refuse.

It is also structurally invisible to CI. Linux has none of these aliases, so every one of these
defects was green on every PR while failing on the machine running the wave.

## Decision

**When a caller-supplied string becomes a name in a namespace the program does not own, the program
admits it only if it matches a grammar the program fully controls, and refuses everything else by
naming the rule that refused it.**

The grammar is a **positive assertion** (ADR-0015): a path is admitted when every segment matches an
explicit character class and an explicit shape, not when no forbidden pattern is found. Anything the
grammar does not describe is refused *without the program having to know why it is dangerous* — which
is the entire point, because the dangerous cases are exactly the ones it could not enumerate.

For this repository's object keys and skill file paths, the conservative grammar is:

* each segment matches `[A-Za-z0-9][A-Za-z0-9._-]*`, and
* no segment ends in `.` or a space, and
* no segment is `.` or `..`, and
* the whole path is under a stated byte length.

That refuses `SKILL.md::$DATA` because `:` and `$` are not in the class — not because anyone reasoned
about alternate data streams. It refuses the next alias too, which is the property a blocklist can
never have.

**Two consequences the implementer must state rather than discover:**

1. **The grammar refuses legitimate names**, and that is a cost to declare, not to design around.
   A skill file called `notes (draft).txt` is refused. Say so; do not add `(` and `)` to the class to
   make one test pass, because widening the class one character at a time is the blocklist failure
   wearing different clothes.
2. **Within the admitted alphabet, case folding is decidable**, so a collision check over admitted
   paths is a real check rather than a guess. Outside it, it was never decidable — which is what
   W2-CP-04's own round-2 comment correctly said and its code then contradicted.

## What this does not replace

The **verify-after-write** half stands alongside the grammar and is not an alternative to it: after a
mutation, read back what was actually stored and fail the operation if the tree is not what was
declared. The grammar stops the classes nobody enumerated; the read-back catches the backend doing
something the grammar could not predict.

W2-CP-04's round 2 implemented a read-back **after** `store.delete` had already run, so it detected a
loss it was meant to prevent and left the skill permanently broken. A read-back that cannot undo is a
detector, not a guard — where the operation is destructive, capture what is at risk **before** the
mutation and restore it when the read-back fails.

## Consequences

* Three tasks stop re-litigating the same question, and a fourth does not begin it.
* Refusals become explainable to a caller: *"segment `SKILL.md::$DATA` is not an admissible name"* is
  a better answer than a 500 after the damage.
* **A guard's own prose must not claim to be structural when it is a wider spelling rule.** Both
  W2-CP-03 and W2-CP-04 shipped that sentence and both were falsified by a run in the next round; the
  word *structural* means the dangerous thing is unreachable by construction, not that the rule got
  longer.
* This is Windows-shaped, so a green CI run proves nothing about it. Evidence is the task's own
  probes on this host — the rule the protocol already states, now with three instances behind it.
