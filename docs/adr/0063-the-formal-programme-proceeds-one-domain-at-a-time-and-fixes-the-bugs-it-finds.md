# ADR-0063 — The formal programme proceeds one domain at a time, end to end, and fixes the bugs it finds

Status: accepted — amends [ADR-0062](0062-the-specification-is-a-lean-4-model-and-typescript-is-tested-against-it.md) (decision 8)
Date: 2026-09-23
Decided by: the Owner (direction given after Phase 1 of the formal specification programme)
Scope: the formal specification programme (`docs/formal/`), its Workflow scripts
(`.claude/workflows/formal-*.mjs`), and product code wherever the programme proves a defect

## Context

ADR-0062 made Lean 4 the machine-checked specification and the TypeScript the thing tested against
it. Its decision 8 kept the programme away from product code: a disagreement between the model and
the code became a finding, and the only permitted product edits were behaviour-preserving
extractions. The charter (`docs/formal/00-orchestrator-prompt.md` §7) then planned the work as
horizontal phases across every domain: all concepts, then all contracts, then all authorisation,
and so on, run as one Workflow script (decision D-010).

Phase 0 (the RunStatus slice, PR #273) and Phase 1 (concepts and the ER model) followed that plan.
They produced a broad model and a findings ledger. They fixed nothing. The Owner's judgement after
Phase 1 was that a finding which stays in a ledger does not reach an outcome. The programme is only
worth its cost when a proof or a counterexample changes the product. A horizontal plan also delays
that moment, because no single domain is modelled from its wire contract to its behaviour until the
last phases.

## Decision

1. **The programme proceeds one domain at a time, end to end.** A domain is a coherent area of the
   product, such as runs and their event stream, or shares. For that domain the programme models
   everything the domain means, in one self-contained, readable body of Lean:
   - its wire contracts and codecs;
   - who may do what, including tenancy;
   - its behaviour as state transitions;
   - its lifecycles and events;
   - its attacker model.
     It proves the properties users rely on. It replays generated vectors against the real TypeScript,
     down to the route handlers where a test harness exists, and triages every disagreement. The
     domain is done only when every defect it found is fixed or explicitly deferred by the Owner.
     Charter §7's phase plan (Phases 2 to 7) and decision D-010 are replaced by this domain plan. The
     rest of the charter still governs.
2. **The programme fixes the product bugs it proves.** This replaces ADR-0062 decision 8. A bug is a
   case where the code contradicts the documented or clearly intended behaviour, shown by a
   conformance vector or a counterexample. The programme fixes it in product code:
   - in the smallest correct place;
   - with a regression test in the product's own suite, which fails before the fix and passes after
     it;
   - with the Lean model updated so that the theorem states the fixed behaviour;
   - with the conformance vectors passing against the fixed code.
     Each fix is reviewed as its own pull request, or as a clearly separated part of the domain's pull
     request when it is small. It follows the repository's usual rules: engineering guidelines, gates
     and the `Owns globs` declaration. When the code is right and a document is wrong, the document is
     fixed, as before.
3. **Some fixes still wait for the Owner.** A fix that would change any of the following is drafted
   as an ADR, and the programme stops for ratification, as charter §13 requires:
   - a public wire contract (`packages/contracts`, the HTTP API, the SDK surface or `aw`);
   - a database schema or migration;
   - a repository-wide gate.
     Behaviour that the contract already specifies is not a contract change. For example, returning
     the documented problem code instead of a different one is not.
4. **Security fixes are handled privately first.** A defect that holds against today's code and has
   security impact is recorded in the private ledger outside the repository and reported to the
   Owner with the evidence. It is fixed only after the Owner says how to disclose it. Its pull
   request describes the change neutrally and never describes an exploit.
5. **Tests are never weakened to make a fix pass.** A disagreement is never closed by editing a
   vector, loosening a theorem, skipping a test or narrowing a gate. The model, the code or the
   document is corrected, and the correction is shown.

## Alternatives considered

- **Keep decision 8 and route every bug to an issue.** This keeps the programme's diffs small, but
  the proofs stop at a list. Nobody owns the list with the model's context, so the findings go
  stale while the code moves.
- **Keep the horizontal phases and add a fix phase at the end.** Bugs found in Phase 3 would wait
  for Phase 7. Their fixes would then be reviewed long after the reasoning that found them, and
  against a model that is too wide to re-check quickly.
- **One domain at a time, without fixes.** Modelling is deeper per domain, but it still ends at a
  finding. The Owner rejected this explicitly.

## Consequences

- Programme pull requests may now touch product code, but only to fix a defect the model proved.
  Each such pull request declares the product paths in `Owns globs` and carries its own regression
  test.
- Reviewers see fewer, deeper model pull requests, one per domain, together with the fix pull
  requests that the domain produced.
- The Phase 1 concept and ER model stays as the shared base that every domain imports. Nothing in
  it is discarded.
- The findings ledger records, for each entry, how it ended: fixed (with a PR), document corrected,
  deferred by the Owner, or waiting for ratification.
