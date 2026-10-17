# ADR-0051 — Alternate-model re-verification is required after a repair

Status: accepted
Date: 2026-09-13
Decided by: the Wave 9 orchestrator
Scope: adversarial verification after a Wave 9 repair

## Context

Wave 9 repeatedly produced same-head or adjacent-round differences between Sonnet and Opus
verification. The evidence is specific:

- W9-UI-133: Sonnet found a stale write grant reaching run composition; after repair, Opus used a
  real browser to find that a rejected second request wedged the editor and concealed the partial
  save. A later Sonnet pass closed the task.
- W9-WS-119: round 2 split Sonnet PASS-with-minor and Opus FAIL. The additional attack reached
  `runPublic` and the vanished-membership identity substitution. The final head required both
  models to pass.
- W9-RUNS-135: rounds 2 and 3 split Sonnet PASS and Opus FAIL. At the pre-final round-4 head both
  failed, while Opus additionally caught the `from`/`to` year-10000 repair regression and the
  unpinned duration, token, accounting-state, and repository-limit behavior. The final head passed
  both models.
- W9-UI-136: two fresh round-3 verifiers converged on the same missing load-bearing nullable-
  timestamp proof after earlier boundary and mobile repairs.

These observations establish that an alternate model caught defects on heads another model passed.
They do not establish general model superiority or prove that a same-model rerun could never have
found them.

## Decision

After a blocking verification finding is repaired, assign re-verification to a fresh verifier using
an alternate available model. For security- or boundary-heavy work, or after a same-head split,
require both model families to pass the final head. The alternate verifier hunts for regressions
introduced by the repair and reruns the original repro; it does not merely confirm that the diff
contains the requested edit.

## Alternatives considered

- Reuse the original verifier and model. Rejected because Wave 9's observed splits show correlated
  blind spots and confirmation bias are material risks.
- Require dual-model verification for every initial PR. Rejected as disproportionate; the strongest
  evidence supports the requirement after repair, on high-risk work, and after a split.
- Treat a passing model as authority over a failing model. Rejected because findings are adjudicated
  by reproducible evidence, not model identity.

## Consequences

Repair loops consume more verification time and may surface adjacent defects late. In exchange,
final PASS means two independent attack styles agreed on the exact final head where risk justified
it. The manifest records the observed rounds without turning this sample into a benchmark claim.
