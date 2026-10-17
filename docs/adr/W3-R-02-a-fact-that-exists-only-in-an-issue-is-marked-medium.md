# W3-R-02 — A fact that exists only in an issue or a changelog is marked `medium`, and that is a fourth confidence value, not a violation of the third

Status: accepted
Date: 2026-09-05
Decided by: R-02's round-2 repair, after fact-check finding F6 raised the conflict and declined to resolve it inside a note
Scope: the Decisions table and confidence labels of every research note under `docs/research/`

## Context

Two binding documents give research notes their confidence vocabulary, and they do not agree
about how many words are in it.

The development plan §5.1 rule 4 enumerates three values and says so emphatically: the
three "have FIXED meanings", `verified` means tested live, `documented` means primary source and
untested, `unknown` means neither, and "there is no fourth value". That last clause exists for a
specific reason and it is a good one: round-1 fact-checking found four notes inventing
qualifiers — `verified (contract)`, `verified (source read)`, `documented (inferred)` — each of
which smuggled an untested claim into a tested-sounding label.

The development plan §5.1 rule 3 and the research README checklist item 3 both say
that where a fact appears only in a changelog or a GitHub issue, the note must say so explicitly
**and mark confidence as `medium`**.

So rule 3 mandates a word rule 4 forbids. Every note in the wave so far has resolved this
silently by ignoring rule 3's second half: naming the issue number inline (which rule 3 also
requires, and which the notes do well) and then labelling the fact `documented`. R-02's
fact-checker raised that as finding F6 and explicitly refused to let a note settle it alone,
which is right — a note choosing its own vocabulary is how the round-1 qualifiers happened.

The two rules are not actually in tension about *meaning*. They are in tension about *counting*.
Rule 4's list was written to close a hole, and the hole it closes is qualifier-invention: taking
a value with a fixed meaning and appending a parenthetical that weakens it. `medium` is not
that. It is a distinct value with its own definition, written down in two governing documents
before any note existed, and it means something neither of the other three means.

It matters that it means something different. `documented` is a promise about the *source*: a
vendor's primary documentation asserts this, and you may rely on it the way you rely on a
contract. An open GitHub issue asserts nothing of the kind. It is one reporter's account of one
configuration, unreviewed by the vendor, frequently about a version other than the current one,
and sometimes wrong. R-02's own Finding 6 is the worked example: issue #180's failure reproduced
on a first-party run, while #429's and #428's could not be reproduced at all on the available
host and remain somebody else's report. Collapsing both into `documented` tells a reader of the
capability record that the vendor said something it never said.

## Decision

**`medium` is the fourth value, its scope is exactly rule 3's, and rule 4's prohibition is a
prohibition on qualifiers, not on this word.**

1. **The four values are `verified`, `documented`, `medium`, `unknown`.** Nothing else. A note's
   confidence legend lists all four or lists only the ones it uses; it invents none.
2. **`medium` means: the fact appears only in a GitHub issue, a changelog, a release note, or a
   comparable non-authoritative source, and the note names that source.** It is not "somewhat
   verified", it is not a hedge on a documented fact, and it is never used to soften a claim a
   primary source actually makes.
3. **Rule 4's "there is no fourth value" continues to bind against qualifiers.**
   `verified (contract)`, `verified (source read)`, `documented (inferred)`, `medium (probably)`
   and every construction of that shape remain invalid. Reading a file, a spec JSON, a type
   definition or a feature's absence from a README is a documentation read; it produces
   `documented`, never a parenthesised `verified`.
4. **A fact that is issue-only and then independently reproduced by the note becomes
   `verified`,** and the note says both — that the claim originated in an issue and that the
   note reproduced it. R-02 Finding 6 is the pattern: #180 and #417 are `verified` because the
   note ran them; #429 and #428 stay `medium` because it could not.
5. **`medium` is a reason to probe, not a resting place.** Where a `medium` fact is load-bearing
   for an implementation task, the note says what would resolve it, in the same row.

The test for whether a label is legitimate is not how many values the list has. It is whether
the label names *what kind of evidence exists* without implying a stronger kind. Four words,
each naming a distinct evidence class, does that. Three words plus parentheses does not — which
is what rule 4 was written to stop, and it still stops it.

## Consequences

- The development plan §5.1 rule 4 and the research README's checklist should be
  amended to state the four values together, so the next note does not rediscover this conflict.
  Neither file is inside R-02's owns-globs, so this ADR records the decision and the amendment
  is left to whoever owns those files. Until it lands, this record is the reconciliation and
  notes cite it.
- Notes already merged that labelled issue-only facts `documented` are not wrong in a way that
  invalidates their conclusions, but a re-verification pass on any of them should re-grade those
  rows. R-02 is re-graded as of this record.
- A reviewer applying checklist item 3 now has something to check against: an issue-only fact
  labelled `documented` is a finding, and an issue-only fact labelled `medium` with its issue
  named is correct rather than a rule-4 violation.
