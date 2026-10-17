# Formal programme — manifest

The programme's state, updated after every phase or domain. A new session given
the formal programme handover notes (maintainers' copy), [`00-orchestrator-prompt.md`](00-orchestrator-prompt.md),
this file, [`decisions.md`](decisions.md) and [`findings.md`](findings.md) can continue without
asking anything. Since Phase 1 the programme proceeds one domain at a time, end to end
([ADR-0063](../adr/0063-the-formal-programme-proceeds-one-domain-at-a-time-and-fixes-the-bugs-it-finds.md)).

## Where things are

- Programme worktree: `../claudeworkspace-formal`, branch `formal/d1-runs`.
- Workflow scripts: `.claude/workflows/formal-*.mjs`. Run ids are listed in the tables below.
- Local Lean: elan in `~/.elan`, Lean `v4.34.0`. `pnpm formal:check` runs the gates.
- Private security ledger (outside the repository): `<home>\.claude\formal-private\security-findings.md`.

## Phases (horizontal plan, closed after Phase 1)

| Phase                                 | Branch                    | PR   | Run id(s)                                                                           | State                               |
| ------------------------------------- | ------------------------- | ---- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| 0 — Bootstrap and the RunStatus slice | `formal/p0-bootstrap`     | #273 | (serial, orchestrator)                                                              | merged (`962d084`)                  |
| 1 — Concepts and the ER model         | `formal/handover-domains` | #281 | `wf_c504decc-c19` (stopped after P1's units; integrated by the orchestrator, D-014) | merged                              |
| 2–7                                   | —                         | —    | —                                                                                   | replaced by the domain plan (D-015) |

## Domains (ADR-0063)

| Domain                                | Branch           | PRs | Run id(s)                                               | State                                                                                 |
| ------------------------------------- | ---------------- | --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D1 — Runs and the event stream        | `formal/d1-runs` | #282–#294 | `wf_4785d14b-eaf`, `wf_3776212c-378`, `wf_37f7a594-db8` | Models and replays integrated; product repairs merged; proposed ADR-0064 awaits Owner decisions |
| D2 — Shares and publication           | —                | —   | —                                                       | not started                                                                           |
| D3 — Identity and access              | —                | —   | —                                                       | not started                                                                           |
| D4 — Files and paths                  | —                | —   | —                                                       | not started                                                                           |
| D5 — Catalog                          | —                | —   | —                                                       | not started                                                                           |
| D6 — Configuration                    | —                | —   | —                                                       | not started                                                                           |
| D7 — SDK and CLI surface, and closing | —                | —   | —                                                       | not started                                                                           |

## Counts (from `formal/generated/catalogue.json`, after D1 repairs)

| Tier     |  T0 |  T1 |  T2 |  T3 |  T4 |  T5 |
| -------- | --: | --: | --: | --: | --: | --: |
| Theorems | 758 | 532 | 363 | 123 |  94 |  77 |

- Catalogue entries: 2531, of which 1947 are theorems. 1432 of the theorems cite a document.
- Theorems per family: ErCore 460, ConceptCatalog 212, ConceptIdentity 203, ConceptWork 181,
  ConceptConfiguration 158, ConceptPublication 111, ErSynthesis 82, Runs 11,
  ContractsFoundation 58, AuthzDecide 160, AuthzTenancy 55, ContractsRuns 41,
  LifecycleRun 20, EventsSse 38, AuthzRunToken 25, RunCompose 24,
  BehaviourRuns 29, SdkRuns 27, CliRuns 20, AdversarialRunsAccess 16,
  AdversarialRunsStream 16.
- Model: 10594 declarations audited, and only `propext`, `Classical.choice` and
  `Quot.sound` are used. 380 import edges, all in the layer direction.
- Vectors: 147 files. The integrated Foundations, layers, behaviour, and red-team replay has
  28 passing files, 7950 tests passing against the real TypeScript, one file and five tests
  skipped. The controlled PostgreSQL and launcher interleaving reproductions are recorded
  separately in the R-stream unit report.
- Phase-1 mutation record before D1 debt: 74 of 86 (86%). Foundations checks: contracts' three
  formerly surviving mutations now fail a theorem; authz-decide's third verifier killed 20/20;
  authz-tenancy's independent six-mutation check killed 6/6.

| Unit                    | Independent verification                                           | Mutations caught |
| ----------------------- | ------------------------------------------------------------------ | ---------------- |
| P1-publication          | passed                                                             | 12/13            |
| P1-catalog              | passed                                                             | 12/12            |
| P1-foundation (er-core) | failed after 3 rounds; 7 problems open                             | 11/14            |
| P1-identity             | failed after 3 rounds; 7 problems open                             | 12/14            |
| P1-configuration        | failed after 3 rounds; 5 problems open                             | 14/16            |
| P1-work                 | failed after 3 rounds; 6 problems open                             | 8/9              |
| P1-synthesis            | round 1 failed (8 problems); repair 1 applied; round 2 interrupted | 5/8              |

The open problems are debt that the domains pay down before they build on each unit (handover
§3.2). They are mostly mutation gaps, plus some conformance suites that re-derive a property in
TypeScript instead of calling the real repository function. The verifiers' problem lists are in
the run journal (handover §3.2).

Foundations, layers, behaviour, and red-team integration passed `pnpm formal:build`,
`pnpm formal:generate`, `pnpm formal:check`, and 7950 formal replay tests across the completed
suites. After the D1 repairs and document pass, `pnpm check:fast`, `pnpm build`, and
`pnpm formal:check` passed. The service-backed `pnpm test` launcher cannot start with this Windows
pnpm because `npm_execpath` is an executable that it passes to Node. With the installed JavaScript
pnpm entry supplied, the full suite ran 13,637 passing tests and nine expected failures; four
tests failed. Three are pre-existing Windows failures: two SDK reference generator synthetic-client
cases and one CLI `.env` mode case. The fourth had retained the pre-fix proxy bearer-case
expectation; it was corrected and the focused 33-case adversarial-runs-access suite then passed.
The tenancy workflow's first two independent verifiers found missing statements, including route
problem codes, resolver order, path segments and credential refusal. Two repair rounds closed
their listed gaps; the second repair's 13 definition mutations each failed a theorem, and its
1,053 replay tests passed. The third workflow verifier stopped during read-only inspection.
A separate independent review then killed 5 of 6 fresh mutations: dropping the workspace condition
from `resolveMembership`'s membership lookup survived. A foreign-membership-first theorem was
added; that exact mutation now fails its statement, and the source was restored and rebuilt.
`pnpm check:fast` found a root formal test importing the SDK's private source entry. That import
now uses the exported package root, with a declared root workspace dependency; the export check
and 1801-case contracts replay pass. The full fast gate passed after the correction.

## Findings and gaps

- Findings: 105 in total. By severity: correctness 44, documentation 39, naming 21, and 1
  security. Security finding withheld; see the private ledger. D1 product repairs are merged in
  PRs #282–#294; document corrections and remaining choices are recorded in the triage ledger.
- Proposed ADRs awaiting the Owner's ratification: `docs/adr/FORMAL-P1-*.md` (10 drafts) and
  ADR-0064. None of them changes product code yet.
- Open gaps: the P1-identity and P1-configuration verifier problems for their later domains;
  the D1 unit-specific gaps in `docs/formal/units/*.md`; and the decisions in ADR-0064.
  R-access and R-stream independent mutation checks are complete.

## Next action

Run the final gates, publish the D1 PR for review, and obtain the Owner's decisions on ADR-0064
before changing the remaining public contracts. The D1 scope checklist remains the coverage target.
