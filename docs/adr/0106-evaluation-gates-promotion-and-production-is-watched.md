# ADR-0106 — Evaluation gates promotion, and production is watched for quality and health

Status: proposed — draft from the developer-journey hearing (decisions D11, D23, D24, D27); 2026-10-04: evaluation cases are data (blueprint decision Q2) and automatic rollback is off by default (Q7), not built yet
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; to be confirmed when this ADR is accepted
Scope: `packages/core` (evaluation runs), `apps/web` (versions, conversations, monitoring), `packages/aw` (`eval`), `apps/runner` (telemetry export); relates to `docs/sdk/site/resources/observability.mdx`

## Amendment — evaluation cases are data; the YAML file is a copy (blueprint decision Q2, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q2). Today `aw eval` reads the cases from `evals/<agent>.yaml` and stores a
`cases_snapshot` with each evaluation (#618), and `aw eval add-case` appends to that file (#620).
The end state moves the source of truth into the platform:

- The cases of a unit are rows (`eval_cases`), written by the console, by the "turn into a case"
  action on a low-rated conversation, by the configuration agent and by `aw eval add-case`.
- `evals/<agent>.yaml` becomes a copy: `aw pull` writes it and `aw push` reads it, the way
  `agents/*.ts` relates to versions. A team that keeps cases in Git keeps working.
- An evaluation still stores the snapshot of the cases it ran, so a stored score never changes when
  a case is edited later.
- "`evals/*.ts` is optional" below reads as "`evals/<agent>.yaml` is optional"; the cases are YAML,
  not TypeScript.

The gate itself is unchanged and already built (#619): the policy ceiling's
`promotion.minEvalScore`. The 90% pass rate and +10% cost written below remain a proposed default,
not what an unset ceiling does today.

## Amendment — automatic rollback is off by default (blueprint decision Q7, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q7). A crossed threshold notifies; it never moves a pointer on its own unless the
environment opted in. Each notification carries the `aw rollback` command and a one-click rollback
in the console. An environment turns automatic rollback on explicitly, and the move is recorded in
`agent_pointer_moves` with reason `rollback` like a manual one.

## Context

There is no evaluation in the platform today. Observability is `metrics.recentRuns` and
`audit.list`, which give an operator a glance at recent activity. They are not a quality signal,
an alert or a store that is kept for a set period. Transcripts have no retention setting.

## Decision

### Evaluation

- An **evaluation set** belongs to a published unit. A case is an input, the conditions on a good
  answer (contains, does not contain, a rubric judged by a model), and a cost ceiling.
- Content owners build cases from real conversations, by marking an answer good or bad, or by
  writing a case in the UI. `evals/*.ts` is optional, for engineers (D23).
- Every draft version is evaluated in `preview` (a pointer in the same control plane, ADR-0101 amendment Q1) automatically and compared with the version in
  production: pass rate, cost and answer length.
- A version below the gate (by default a 90% pass rate and no more than 10% higher cost) cannot be
  requested for promotion (ADR-0101, ADR-0102).
- Promotion ends with a smoke subset run in production before traffic switches.

### Watching production

- **Quality**, for content owners: low-rated conversations, handoff rate and frequent questions.
  A low-rated conversation can be turned into an evaluation case in one action.
- **Health**, for admins: error rate, latency and cost (D24).
- Thresholds raise notifications. Each environment may opt in to **automatic rollback** to the
  previous version when a threshold is crossed.
- Telemetry can also be exported through OpenTelemetry.

### Retention

- Versions are kept forever (ADR-0101).
- Conversations are kept for a period the admin sets, 90 days by default.
- Conversations used as evaluation cases are kept for as long as the case exists (D27).

## Alternatives rejected

- **Leave evaluation to each team's CI.** Rejected: promotion cannot be gated on something the
  platform does not run, and content owners cannot use a CI pipeline.
- **Admins watch everything.** Rejected (D24): quality signals belong to the people who change the
  content.

## Consequences

- Evaluation runs are runs, metered and billed like any other. The gate's cost appears in the
  version view.
- A rubric judged by a model needs a judge model connection, which is set per environment.

## Open questions

- Which notification targets ship by default: Slack, email or PagerDuty.
