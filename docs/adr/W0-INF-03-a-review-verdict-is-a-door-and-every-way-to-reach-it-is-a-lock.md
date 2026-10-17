# ADR-W0-INF-03 — A REVIEW verdict is a door, so every way of reaching it wrongly is a lock to fit

Status: accepted
Date: 2026-09-03
Decided by: W0-INF-03, Infra agent
Scope: `scripts/check-licenses.mjs`, `docs/dependency-policy.md`, research note R-16

## Context

This gate has two verdicts that fail a build, and they are not equivalent. **DENY** cannot be cleared
by anything short of a policy edit with an ADR. **REVIEW** can be cleared by a two-line entry in the
exception register at the top of the script. That asymmetry is deliberate and it is the whole design:
REVIEW is "a human read this and wrote down why it is fine", DENY is "no".

It also means REVIEW is a **door**. Anything that turns a licence the policy denies into a REVIEW is
a way to put that licence into the redistributed tree with a register entry and a green CI run. Four
such paths have now been found in this gate, from four directions, and the ADR that closed the first
one — [unparseable SPDX expressions](W0-INF-03-unparseable-spdx-expressions.md) — named the shape
without naming the class:

> if a package ever declared a string of this shape, the base licence … would be laundered into a
> reviewable verdict by the fact that the *rest* of the string did not parse.

**Path 1, closed there.** A string that does not parse. `GPL-2.0-only WITH <OpenSSL exception>`
throws at the `<`, and a parse failure routed to REVIEW. Closed by the salvage scan.

**Path 2, open until this record.** A string that *does* parse, into the wrong shape. SPDX's seven
deprecated single-identifier `WITH` spellings — `GPL-2.0-with-classpath-exception` and its six
siblings — are each **one token**. They parse cleanly, into a bare `lic` node. `expressionDenied` has
a `with` branch whose entire job is to decide an exception expression on its base licence, and that
branch was never reached: the node was a `lic`, so the whole expanded string went to
`denySet.has(…)`, which holds bare family identifiers and does not hold
`GPL-2.0-only WITH classpath-exception`. All seven classified REVIEW — measured on the shipped script
before this change, one probe per identifier, and every one of the seven is a GPL licence. The
comment above `canonicalLicence` asserted the opposite — "the base licence is what the policy
classifies" — and the expansion it produced named an exception identifier (`classpath-exception`)
that exists on no SPDX list, so the string it built could not have matched anything even if the
lookup had been the right one.

**Path 3, also open until this record.** Not a licence string at all, but the register that clears
one. The expiry check was `Date.parse(entry.expires) < now`. `Date.parse` returns `NaN` for a
missing, empty or unrecognised value; `NaN < now` is `false`; the expired branch was skipped and
control fell through to `continue // Cleared by the exception`. An exception with no readable expiry
cleared its package **permanently** — the one thing the register's design says an exception must
never do. The self-test's five-fields assertion did not cover it, because that assertion reads the
register in this file rather than the register the evaluator is handed, and because it accepts any
truthy value, including `'soon'`.

**Path 4, open until this record — and the one that says what the other three have in common.**
Not the shape of the string and not the register, but its **case**. Licence matching was
case-sensitive at every comparison site, and SPDX matches licence identifiers case-insensitively.
So `gpl-2.0-with-classpath-exception` and `GPL-2.0-WITH-CLASSPATH-EXCEPTION` classified REVIEW —
clearable by a register entry — where `GPL-2.0-with-classpath-exception`, the one spelling that had
been tried, classified DENY. The behaviour was uniform and it was documented (`mit` likewise failed
to reach ALLOW), which is precisely why it survived three review rounds: a defect that is
consistent and written down reads as a decision. It is not one. npm's `license` field is free text
typed by the package author, and pnpm reports it verbatim, so the registry does and will emit
identifiers in any case.

**What the four have in common, stated as a rule.** Each was found by someone trying a spelling
nobody had tried, and each fix so far had the option of special-casing that spelling. **A gate must
decide on a positive assertion — "this token IS licence X" — never on the absence of a negative —
"this token does not match anything we deny."** A deny check phrased negatively is only ever as
complete as the list of spellings its authors happened to think of, and the next spelling is found
by the next verifier rather than by the gate. This programme has now shipped that same defect four
times.

> **Declared gap.** That rule belongs in a programme-level record, and this task cannot write one:
> `docs/adr/NNNN-` records are the orchestrator's ([ADR-0003](0003-adr-naming-preserves-file-ownership.md),
> [ADR-0012](0012-reconciling-two-adr-series.md)), and a task-level PR writing one is the very thing
> ADR-0012 declares CI does not stop. It is recorded here, in the task record for the fourth
> instance, so it is written down somewhere in the tree. **`docs/adr/0015` does not exist on any ref
> in this repository** — checked across every `refs/heads` and `refs/remotes` on 2026-09-03; the
> sequence runs `0012`, `0014`, and `0013` is reserved for Wave 1. Promoting this rule to a
> programme record is the orchestrator's to do.

## Decision

**1. Deprecated SPDX identifiers are normalised to their current spelling before classification, and
the mapping is read off the SPDX list rather than derived from the spelling.**

`normaliseDeprecatedSpdx` runs first in `classify`, ahead of every stage. It rewrites each of the
seven deprecated `WITH` forms into the expression SPDX says it stands for, so the string re-parses
into a real `with` node and the base licence decides. `GPL-2.0-with-classpath-exception` is now DENY,
and an exception granted for exactly that string cannot clear it.

The mapping is a literal table, not a pattern, because it is not derivable. The exception half
carries its own version: `GPL-2.0-with-GCC-exception` becomes `GCC-exception-2.0` but
`GPL-3.0-with-GCC-exception` becomes `GCC-exception-3.1`, and `GPL-2.0-with-bison-exception` becomes
`Bison-exception-2.2`. Each replacement is transcribed from that identifier's own
`v3.28.0/json/details/<id>.json`, field `licenseComments`, which reads `DEPRECATED: Use license
expression including main license, "WITH" operator, and identifier: <exception-id>`; the main licence
is the deprecated identifier's own base in current spelling. Every exception id was checked against
`v3.28.0/json/exceptions.json` (84 exceptions). The self-test asserts the map holds exactly the seven
deprecated `-with-` identifiers on 3.28.0, that each replacement parses, and that each of the seven
classifies DENY — one named fixture per identifier, so a regression says which one came back.

A GNU-family identifier with a `-with-` tail that is on **no** SPDX list is expanded on its base by
the same pass. An invented or misspelled exception half can only make the verdict stricter, never
laxer, and a future SPDX deprecation therefore denies before anyone updates the map.

The version-suffix half of the deprecation problem stays where it was, in `canonicalLicence`'s
`GNU_FAMILY` regex, because *that* half genuinely is derivable: `X` → `X-only`, `X+` → `X-or-later`.
The `-with-` tail has been removed from that regex; it now belongs to exactly one place.

**2. Identifiers are canonicalised ONCE, at the boundary, and never compared case-insensitively.**

`canonicaliseSpdx` (formerly `normaliseDeprecatedSpdx`) is the single point every licence string
passes through on its way into `classify`. It now does two things in order: fold each identifier onto
its one registered SPDX spelling, then rewrite the deprecated `WITH` forms. Everything downstream
goes on comparing exactly, because everything downstream sees exactly one spelling.

The fold is a **positive** lookup, not a fuzzy match. `spdxSpellingRegistry` is a map from the
lower-cased form of every identifier this policy can recognise to that identifier's registered
spelling, built from the verified SPDX 3.28.0 list, the policy's own five lists, both sides of the
deprecated-`WITH` map, and the deprecated bare GNU forms derived from the family identifiers already
in it. A token in the map is replaced by its registered spelling; **a token not in the map is passed
through exactly as it arrived**, because it is not a licence we know and must reach REVIEW as an
unknown rather than be massaged into something decidable. Registering two spellings that differ only
by case throws, since SPDX's own case-insensitivity makes that ambiguous.

Two things are deliberately left alone. **Operator case**: SPDX operators are upper-case, and folding
`or` up to `OR` would turn an invalid expression into a valid one — `GPL-3.0 or MIT` is unparseable
today and denied by the salvage scan, but as `GPL-3.0-only OR MIT` it would be ALLOW. That is the
laundering direction, so operator case is preserved and a fixture pins it. **Unknown identifiers**:
`MITTENS` is not `MIT` and `Apache-2.1` is not `Apache-2.0`; both stay REVIEW.

`GNU_WITH_FORM` is separately case-insensitive, because `GPL-3.0-WITH-INVENTED-EXCEPTION` is one
token — the `WITH` inside it is not an operator — and an invented tail in upper case must not be the
spelling that escapes. The two mechanisms overlap for the seven known identifiers and each is
independently load-bearing: removing the fold produces 15 named self-test failures, removing the `/i`
produces 1, and both were measured rather than assumed.

**3. An exception whose expiry the gate cannot read clears nothing.**

`expires` must be a string that `Date.parse` accepts. Anything else — absent, empty, `'soon'`,
`null`, or a number — is reported as an unreadable expiry and the package appears in the output. The
`typeof` half is not belt-and-braces: `Date.parse` coerces its argument, so `expires: 90` parsed as
the year 1990 and reported "expired 90", naming a date nobody wrote. Five fixtures, one per shape,
plus one that a readable future expiry still clears.

## Alternatives considered

* **Add the seven deprecated spellings to `denyFamilies` as literal strings.** Two lines, and it
  fixes the seven cases we know about. Rejected: it treats a structural defect as a data gap. The
  reason they escaped is that a single-token `WITH` form never reaches the `WITH` branch, and that
  reason applies to any deprecated identifier SPDX has published or will publish. It would also have
  to be repeated in `allow` and `review` to keep the exact-match stages honest.
* **Make `canonicalLicence` return the normalised `WITH` string and look that up.** This is what the
  code did, and it is the shape of the defect: `canonicalLicence` has four call sites, and in three
  of them its result is looked up in a `Set` of bare identifiers. A function that sometimes returns
  an identifier and sometimes returns an expression cannot be used by a caller that only understands
  identifiers. Normalisation has to happen at a point where the result can be **re-parsed**, which
  means before classification, not inside a lookup.
* **Guess the mapping from the spelling** — title-case the tail, and take the version from the GPL
  version in the identifier. Rejected on the evidence: the exception's version does not follow the
  licence's. That rule gets `Classpath-exception-2.0`, `Font-exception-2.0`, `GCC-exception-2.0` and
  `Autoconf-exception-3.0` right, and gets `Bison-exception-2.2` (under GPL-2.0) and
  `GCC-exception-3.1` (under GPL-3.0) wrong. No rule over the spelling produces all seven, and a
  licence gate that invents SPDX identifiers is a gate whose output nobody can check.
* **Treat a missing expiry as "expires today".** Rejected: it is the same silent behaviour with a
  different sign, and the register would fill with entries whose author believed they had recorded
  something. Naming the mistake costs one row of output and is the only version that teaches.
* **Compare case-insensitively at each comparison site** — lower-case both operands in
  `denyLiteralSet.has`, `reviewSet.has`, `canonicalSet`, `expressionSatisfies`, `expressionDenied`
  and `salvageDenied`. Rejected, and it is the alternative worth naming most carefully, because it
  is the one a hurried fix would take. There are eight such comparisons today. Eight edits leave the
  ninth — the one added next month — to be found by the next verifier, which is exactly how this
  defect reached its fourth instance. It also spreads one decision (what counts as the same licence)
  across eight sites that would then each have to be re-read to answer it. Canonicalising on the way
  in makes the decision once and lets every comparison stay exact.
* **Lower-case everything at the boundary and lower-case the policy lists to match.** Simpler than a
  registry, and it works. Rejected because it destroys the registered spelling: the `WHY` column, the
  `PACKAGE`/`LICENCE` table and the deprecated-`WITH` map keys all read as SPDX identifiers, and a
  gate whose output says `gpl-2.0-only` is a gate whose output cannot be pasted into an SPDX tool or
  compared with the list it claims to implement. Canonicalising *onto* the registered spelling costs
  one map and keeps the output checkable.
* **Assert the five fields harder in the self-test and leave the evaluator alone.** Rejected: the
  self-test can only see the register in this file. `evaluateInventory` takes `exceptions` as a
  parameter, and the check belongs where the decision is made.

## Consequences

* A licence string can now be rewritten between what pnpm reported and what the gate classified. The
  `WHY` column quotes the parse error against the normalised string, so when the two differ the
  message names the normalised expression explicitly rather than reporting an offset into a string
  the reader cannot see.
* The stage list in [`docs/dependency-policy.md`](../dependency-policy.md) §3 gains a stage, and that
  file now states which stages actually change a verdict — measured by short-circuiting each one and
  re-running `--self-test`, not asserted. Stage 4 (`review` exact match) changes nothing today; that
  is written down rather than claimed the other way.
* The seven fixtures pin SPDX License List **3.28.0**. If the list is re-verified at a later version
  and an eighth `WITH` form is deprecated, the map, the fixture that asserts its key set, and R-16 F8
  all have to move together. The fixture asserting the exact key set is what makes that a failure
  rather than a silence.
* Three mutants of this script — `matchException` keyed on name only, the expiry check removed, the
  scope check removed — each now produce **named FAIL lines** rather than a `TypeError` from indexing
  `[0]` into an empty result. That was a diagnostics defect, not a gate defect: the exit code was
  always non-zero. But a CI failure that names no invariant teaches the next maintainer nothing.
* **The self-test grew from 109 fixtures to 136**, 27 of them for case. They assert the outcome at
  `classify` rather than the output of `canonicaliseSpdx`, so a future refactor that moves the fold
  elsewhere still has to keep the verdicts. Both directions are pinned: eleven mixed-case denied
  identifiers stay DENY, six mixed-case allowed identifiers stay ALLOW, and three near-misses
  (`MITTENS`, `Apache-2.1`, `Unknown`) stay REVIEW so the fold cannot over-reach.
* **The parser grew from 171 lines to 210**, across eleven functions rather than nine. That widens
  the gap against spec §40's "approximately 50 lines" threshold, which
  [the other record](W0-INF-03-policy-lives-in-the-gate.md) already declares is not what carries the
  decision to own this parser; ownership is. The count is re-derived there rather than carried.
* Nothing here loosens the gate. Every change moves a verdict from REVIEW to DENY, or from cleared to
  reported. The live `--prod` and `--dev` runs are unchanged and still pass.
