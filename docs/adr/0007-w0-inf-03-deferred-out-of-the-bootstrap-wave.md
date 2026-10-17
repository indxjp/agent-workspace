# ADR-0007 — W0-INF-03 runs after the research wave, not inside the bootstrap stack

Status: accepted
Date: 2026-09-03
Decided by: orchestrator
Scope: Wave 0

## Context

Plan §7.5 lists `wave-0-bootstrap.mjs` as "4 + 4 — Serial: monorepo → CI → policy → governance".
The executed recording has three tasks. W0-INF-03 (the "policy" task: `scripts/check-licenses.mjs`
and the SPDX allow / review / deny lists) is absent.

W0-INF-03 is PL-2 and its research note is R-16. Plan §3.3 states the hard rule: **no PL-2 code is
written before its research note is landed and approved.** When the bootstrap wave launched, R-16
did not exist — the research and bootstrap workflows were run concurrently on purpose, because their
file ownership is disjoint (`docs/research/**` versus root config and `.github/**`).

## Decision

Run W0-INF-03 as a separate task after R-16 lands, stacked on `aw/w0-integration` rather than inside
the bootstrap chain. Wave 0 closes only when it has landed.

## Alternatives considered

- **Serialise research before bootstrap**, preserving the four-task stack. Rejected: it would idle
  the bootstrap work behind ~35 minutes of web research for no dependency reason, and the two touch
  no common file.
- **Write the licence script against remembered licences and reconcile later.** Rejected on the
  spot — the "confident invention" failure mode §3.3 defines PL-2 to prevent. R-16 went on to find
  real surprises: `@anthropic-ai/claude-agent-sdk` publishes `SEE LICENSE IN README.md` rather than
  an SPDX identifier, and `sharp`'s Windows binary is `Apache-2.0 AND LGPL-3.0-or-later`.

## Consequences

- Plan §7.5's agent count for this wave is wrong as written; corrected in the W0 manifest.
- The CI licence step shipped by W0-INF-02 references a script that does not yet exist. It skips with
  an explicit "not yet present" message and fails if the script is present and exits non-zero — a
  deliberate, declared, temporary hole in the gate set, closed by W0-INF-03.
