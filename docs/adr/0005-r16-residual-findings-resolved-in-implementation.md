# ADR-0005 — R-16's residual findings are resolved by W0-INF-03, not a fourth research round

Status: accepted
Date: 2026-09-03
Decided by: Owner (this session)
Scope: W0-INF-03, `scripts/check-licenses.mjs`, `docs/dependency-policy.md`

## Context

Research note R-16 (licensing) took three rounds. Round 1: PASS_WITH_NOTES, 7 findings. Round 2:
**FAIL** — the repair had introduced two contract-level defects of its own (a Decisions verdict
inverted relative to its own question, and a claim that unexercised classifier stages "would produce
the same result"). Round 3 fixed those by re-probing rather than re-wording, and the re-check
returned PASS_WITH_NOTES with six residual findings.

Those six are not prose problems. They are statements about the **CI licence-check contract**:

1. A `socat` row whose SPDX column holds `GPL-2.0-only WITH <OpenSSL exception>`, which throws in
   `spdx-satisfies`. There is no standard SPDX exception id for socat's OpenSSL exception.
2. `matchException` keys on package **name** only; the `licence` field every exception entry carries
   is never compared against what pnpm reports, so an exception recorded for one licence silently
   clears that package under any other.
3. "All identifiers this policy uses exist on SPDX 3.28.0" is followed by 16 identifiers; the policy
   actually uses 30.
4. A path invented against the spec: `packages/runtime/src/drivers/external/<provider>.ts`. No
   `drivers/` directory appears anywhere in `docs/spec.md`; §29 places it at
   `packages/runtime/src/managed/external.ts`.
5. A stale `shadcn` version row (4.20.0 recorded, 4.20.1 already published on the probe date).
6. A taxonomic wobble in the load-bearing / defensive stage labelling.

## Decision

Do not run a fourth research round. Hand R-16 plus the six residual findings to W0-INF-03 as inputs
and resolve each **in the implementation** of `scripts/check-licenses.mjs`, where the resolution is
executable and testable rather than asserted in prose.

Finding 4 is the exception: it is a factual error about *this repository's* layout, not about the CI
contract, and W0-INF-03 corrects it in the note directly.

## Alternatives considered

- **A fourth research round, then implement.** Rejected by the Owner. Findings 1–3 and 6 cannot be
  settled by reading a source: whether an unparseable SPDX string is a policy error or a case the
  script must handle is decided by writing the script. Fixing them on paper would be re-litigated the
  moment the code was written.
- **Accept them as declared gaps and ship the script as-is.** Rejected: findings 1 and 2 are
  soundness holes in a gate. Finding 2 means the gate can pass a package it should stop — plan
  §9.3's "a published ✓ not backed by a passing scenario" wearing a different costume.

## Consequences

- R-16 lands carrying six open findings, unusual for a note the plan calls "landed and approved"
  before PL-2 work starts. The compensating control is that W0-INF-03 must close each one **with a
  test**, and its verifier checks them off individually.
- If W0-INF-03's author disagrees with a finding, the disagreement is settled in code and recorded as
  a task-level ADR — not sent back to the researcher.
