# ADR-0016 — A measured number does not live in prose; it is emitted or it is absent

Status: accepted
Date: 2026-09-03
Decided by: orchestrator
Scope: whole programme — code comments, PR bodies, ADRs, wave manifests, research notes

## Context

Wave 0 ran six verification rounds. Every single round found at least one artefact asserting a number
or a behaviour that was true when written and false when read. A partial census:

| Round | The stale assertion |
| --- | --- |
| 2 | "vitest.config.ts scopes projects to `packages/*` and `apps/runner`" — in three files at once |
| 3 | "the five directories that exist today" — a sixth already existed |
| 4 | ADR index: "12 records" while the directory held 20 |
| 5 | self-test "97 assertions", "262 prettier lines", FALLBACK_TREE's "seven areas" |
| 6 | ADR index: "21 records" while the branch's tip held 24 |
| 6 | per-stage self-test failure counts, measured at 109 fixtures, restated after 27 were added |

Two of these were introduced *by the commit that fixed the previous one*. One was introduced by the
fix for the finding about stale numbers. The correction rate is not improving, because correcting a
number does not change the thing that makes numbers go stale.

The pattern is not carelessness. Every one of these was measured honestly at the moment of writing.
The defect is that a **measurement was transcribed into a medium that does not re-measure**. Prose
has no `--check`. A comment cannot fail CI.

This is also the same failure the product is built to prevent, one level down: spec §41 and A.12
forbid a hand-maintained capability matrix precisely because a `✓` written by hand stops tracking
what the tests do. The tooling was doing to itself what the specification forbids the product to do
to its users.

## Decision

**A number obtained by measuring something does not appear in prose.** It is either emitted by the
thing that measures it, or it is absent.

Concretely, and without exception:

1. **Code comments state invariants, never counts.** Not "97 assertions, 3 groups" but "every
   refusal shape has a fixture". If the count matters, the self-test prints it on every run.
2. **Generated blocks are generated.** Any list, index or table derived from the tree carries
   `BEGIN/END GENERATED` markers, ships the command that produces it, and that command has a
   `--check` mode wired into CI. `docs/adr/regenerate-index.sh` is the pattern; the ADR index drifted
   three times before it existed and once more afterwards, because the generator ran on one branch
   while records were added on another.
3. **PR bodies quote command output, never summarise it.** A pasted transcript is evidence and ages
   visibly. "11 named FAIL lines" is an assertion and ages silently.
4. **Where a number must be written down** — a research note's probe result, a manifest's SHA — it
   carries the provenance inline: the command, and *as of* which commit and when
   ([ADR-0014](0014-concurrent-sessions-on-one-repository.md)'s snapshot rule).
5. **A verifier that finds a stale number reports the medium, not just the number.** "This count is
   wrong" is a finding worth one fix; "this count is in a comment and therefore will be wrong again"
   is a finding worth a mechanism.

## Alternatives considered

- **Keep correcting them each round.** Rejected on evidence: six rounds, no improvement, and fixes
  that introduced fresh instances of the thing they fixed.
- **Ban the numbers entirely, including from generated output.** Rejected: the counts are genuinely
  useful to a reviewer. The problem is the medium, not the information.
- **A CI grep for digit-bearing comments.** Rejected under §40 and on precision: it cannot
  distinguish "97 assertions" from "port 8080", and a check with that false-positive rate gets
  disabled within a week, which is worse than no check.

## Consequences

- Some review context is lost from comments. A reviewer who wants the count runs the self-test,
  which is one command and is authoritative.
- `--check` modes must be wired into CI or the generated blocks drift silently again — which is
  exactly what happened between rounds 5 and 6. A generator nobody runs is a comment with extra steps.
- Wave 0 closes with known stale numbers still in PR bodies and comments on the lower branches. They
  are declared in the W0 manifest rather than chased: the mechanism is now in place, and re-measuring
  six branches of prose to close a wave would be the seventh round of the mistake this record exists
  to stop.
