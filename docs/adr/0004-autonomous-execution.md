# ADR-0004 — Execution is autonomous; decisions are logged, not asked

Status: accepted
Date: 2026-09-03
Decided by: Owner (this session)
Scope: whole programme

## Context

The Owner's instruction, verbatim in substance: asking a question stops the run, so run
non-stop; if there is something to ask, decide it and leave every decision in an ADR directory
as a decision log; proceed in auto mode.

Plan §3.5 previously routed three situations to a stop: an ambiguous spec (PL-0 → PL-1/PL-2),
an unverifiable external fact (→ PL-2), and a needed credential or product decision (→ PL-3).
Two of those three assumed a human would answer.

## Decision

No agent asks a question. Plan §3.5 is amended for this programme:

| Situation | Old route | New route |
| --- | --- | --- |
| Spec ambiguous | stop, flag for review | implement the smallest reading, write an ADR, continue |
| External fact unverifiable | stop, open a research request | research it; if still unverifiable, declare it **unverified** in the capability model, write an ADR, continue |
| Credential / product decision | stop, add a §11 row | take §11's default ([ADR-0002](0002-owner-decision-defaults.md)), write an ADR, continue |

What does **not** change, and must not:

- An unverified capability is still declared unverified. Autonomy is permission to decide, never
  permission to pretend. Spec §12, §14.5, §41 and A.12 are untouched, and plan §9.3's honesty
  gates apply to ADRs too: an ADR asserting a fact needs the same citation a research note does.
- A blocked task still delivers everything not blocked, and says plainly what it left out.

## Alternatives considered

- **Queue questions and batch them at wave boundaries.** Rejected: the Owner asked for non-stop
  execution, and a batched question is still a stop.
- **Let agents pick defaults without recording them.** Rejected outright. The ADR is the entire
  compensating control for the removed conversation; without it the programme becomes a pile of
  unexplained choices, which is the failure mode plan §12 was written to prevent.

## Consequences

- Decisions get made by whichever agent hits them first, with that agent's context only. An ADR
  can therefore be locally reasonable and globally wrong. The orchestrator reviews ADRs at each
  wave close and supersedes the ones that do not hold.
- The Owner loses the chance to redirect before work is done, and gains a written record after.
  Reversing a decision costs the work built on it.
- Volume is a risk: an ADR per micro-choice would bury the ten that matter. The README's
  "when NOT to write one" list is load-bearing, not politeness.
