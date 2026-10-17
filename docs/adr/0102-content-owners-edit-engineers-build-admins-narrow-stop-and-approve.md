# ADR-0102 — Content owners edit, engineers build, admins narrow, stop and approve

Status: accepted in part (slice 2: the policy ceiling, R-2; 2026-10-04: the content-owner role, by the blueprint decision Q6, not built yet); the rest remains proposed — draft from the developer-journey hearing (decisions D1, D2, D13, D18, D22, D25, D26)
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; slice 2 accepted 2026-10-03 by the implementing agent of S2-00b on the Owner's delegation (see "Slice 2 acceptance"); the rest to be confirmed when it is accepted
Scope: `packages/contracts` (roles, policy), `packages/core` (authorization), `apps/web` (agent screen, administration); relates to RF-102 and the roles table in `docs/sdk/site/concepts/workspaces-and-principals.mdx`

## Slice 2 acceptance

Accepted on 2026-10-03 for slice 2 of the developer-journey delivery
(the delivery plan, §8), by the implementing agent of
S2-00b (issue #521) on the Owner's delegation. Only the decisions below are accepted. Everything
else in this record remains proposed.

Only the R-2 part of this record, the policy ceiling, is accepted.

Accepted now:

- **SD5 — the policy ceiling is deployment configuration (contract C13).** It flows from the
  project file's top-level `policy` to the `start` message's `environment.policy` (sent only when
  the file has one), then to `AW_DEPLOYMENT_POLICY` (canonical JSON), which the server reads once
  at startup with `ProjectPolicySchema`. An invalid value stops the server with the variable
  named, and an absent value means no ceiling. When the process environment or `.env` sets
  `AW_DEPLOYMENT_POLICY` to a value that differs from the `start` message's policy, the runtime
  refuses to start and names the variable, as it does today for a posture variable it cannot use
  (`packages/embedded/src/local-environment.ts:72`): a hand-set value never silently beats the
  project file. No route writes the ceiling, so no role, the Owner included, widens it through
  the API. It applies per deployment, and changing it means restarting `aw dev`, which `aw dev`
  prints. Reason: widening must be an edit to the project file, reviewed like any infrastructure
  change (D13), and a ceiling that an API caller could raise would not be a ceiling. The `start`
  message's side is an amendment of the accepted ADR-0109, made in its own PR (S2-00c), not here.
- **SD6 — ceiling semantics (contract C14).**
  - An explicit value above the ceiling, or a permission switched on above it, is
    `403 policy_cannot_widen` naming the body path. A `null` limit never refuses; it is composed
    at the ceiling.
  - `policy.models` lists **model ids**, never connection names, because a model connection
    carries no model id (C11). An allowlist of connections is out of scope, and the strict schema
    refuses `policy.connections`.
  - A save judges only what the body states: an explicit model id, and the deployment default id
    read from `AW_DEPLOYMENT_DEFAULT_MODELS` without provider discovery. A model the S1-23 ladder
    resolves at run time (live discovery, the dated-release pick, the project and workspace
    layers, `apps/web/server/compose/run-request.ts:298-330, 390-439`) is judged only at compose,
    which refuses it in preflight. A run start's explicit `modelOverride` is judged at the start.
    Reason: a save cannot know what the ladder will resolve without asking a provider.
  - The check runs at every write path and again at compose, whatever the caller's role. Compose
    narrows what can be narrowed and refuses an engine or a model outside the ceiling.
  - Slice-2 keys: `permissions`, `limits.maxTurns`, `limits.maxBudgetUsd`, `engines`, `models`
    and `tools`. Each of `maxCostPerDayUsd`, `network`, `approval` and a per-environment `policy`
    is refused at its path until it is built.
  - `policyWidenings(effective, ceiling)` and `meetPolicyCeiling(effective, ceiling)` are pure
    functions in contracts. The server's write paths and its compose step use them and no copy.
    The dry run and the save answer identically (C8), and a run start or preflight the ceiling
    refuses answers `policy_cannot_widen` with status `403`.
- **This narrows the Decision text below.** "Admins narrow and stop; they never widen" sets the
  policy per environment and lists network policy and cost per day. Slice 2 accepts one top-level
  ceiling per deployment with the keys above; network modes, per-day cost, approval and a
  per-environment policy are refused, not accepted and ignored (plan §8, declared gap "Policy").
- **SD1 and "Tools come from a catalog".**
  [ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md) makes
  a tool defined in code a connector of kind `openapi` or `postgres`, referenced by name in a
  version's `resources.connectors` as an `mcp()` connector is. That is where catalog entries are
  stored; it is not yet the catalog this record describes. Who may register a connector does not
  change in slice 2, and an admin's approval of a catalog entry is not accepted.

Still proposed: the content-owner role and its row in the roles table, the catalog and an admin's
approval of it, stopping a skill, a tool or a unit without a version, who approves a promotion
(and `approval: admin`), the one screen, the audit of widening attempts, and the open question.

## Amendment — content owner is a fifth role (blueprint decision Q6, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q6). "Content owner is a new role between Builder and Viewer" below is
accepted, over the alternatives of widening `agent_grants` per agent or leaving content changes to
engineers.

- `content_owner` joins the role list beside `owner`, `admin`, `builder` and `viewer`, for
  memberships and API keys alike, in the contracts and in `apps/web/server/rbac`.
- It may create versions (through the console, the configuration agent, `aw push` or the API),
  build evaluation cases, rate runs and request promotion. It may not register connectors, secrets
  or model connections, and it never widens a policy ceiling.
- R-1 reviews every route's role check for it. Until R-1 lands the role does not exist and nothing
  changes for the four current roles.

## Context

Today a workspace has four roles: Owner, Admin, Builder and Viewer. A Builder creates and edits
agents, skills and connectors, and registers a connector's URL and credential itself. An Admin can
change anything a Builder can. A setting can be widened from the UI, from `aw` or from the SDK, and
nothing records whether a change made an agent more or less capable. The only switch that stops
something without editing it is `aw skills enable|disable`.

The hearing identified four people with different jobs:

- **Content owner** — a business person (a support lead, a legal reviewer). Changes the words, the
  rules and the skills most often. Does not write code.
- **Engineer** — builds tools, evaluations, the first shape of an agent, and the infrastructure.
- **Admin / operator** — decides where things run and keeps them safe and affordable.
- **Embedder** — puts the agent in front of users (ADR-0105).

## Decision

### What each person does

| Person | Edits | Can also |
| --- | --- | --- |
| Content owner | instructions, skills, wording; adds tools from the approved catalog | build evaluation cases, request promotion, approve some promotions (below) |
| Engineer | tools (`tools/*.ts`), evaluation code, first `agents/*.ts`, `agent-workspace.yaml` | everything a content owner can |
| Admin | `agent-workspace.yaml`, members, model connections, the tool catalog | narrow, stop, approve |
| Embedder | `surfaces/*.ts` | — |

Content owner is a new role between Builder and Viewer. It can create versions (ADR-0101) but
cannot register connectors, secrets or model connections.

### Admins narrow and stop; they never widen

- A **policy** in `agent-workspace.yaml` (ADR-0103), per environment, sets ceilings: allowed
  models, allowed tools, the four permissions, network policy, cost per run and per day (D13).
- A version may ask for less than the policy allows, never more. A save that asks for more is
  refused as `403 policy_cannot_widen`, naming the field.
- An admin can **stop** a skill, a tool or a whole unit in one environment without creating a
  version. Stopping is audited and visible in the plan.
- Widening a ceiling is an edit to `agent-workspace.yaml`, reviewed like any infrastructure change.

### Tools come from a catalog

- An admin approves a tool once: its URL or OpenAPI document, its credential reference, and which
  environments may use it. Approved tools form the workspace's **catalog** (D22).
- A content owner adds a tool to a draft by choosing from the catalog. A tool that is not in the
  catalog is a request to an engineer, not a field the content owner can fill in.
- This replaces today's "a Builder registers a connector with its credential", and closes RF-102
  (per-row connector authorization) by construction.

### Who approves a promotion

- A content-owner lead may approve a promotion when the version's evaluation meets the gate
  (ADR-0106) **and** the version adds no tool and changes no model (D26).
- Every other promotion needs an admin.
- An environment may require an admin for every promotion (`approval: admin`).

### One screen

Content owners and engineers use the same agent screen (D25). By default it shows words, rules,
evaluation results and conversations. "Details" reveals traces and the neutral `agent.*` events.

## Alternatives rejected

- **Code is the source of truth and the UI only narrows** (the hearing's first answer). Superseded
  by ADR-0101: content owners must be able to edit, so the UI creates versions instead.
- **Admins can change anything.** Rejected: it hides who made an agent more capable and why.
- **Separate apps for content owners and engineers.** Rejected (D25): one version history must be
  visible to both.

## Consequences

- The roles table in `docs/sdk/site/concepts/workspaces-and-principals.mdx` gains a row, and every
  route's role check is reviewed for it.
- The policy becomes a deployment-level document, not only a per-agent field
  (`agents.replacePolicy` keeps working inside the ceiling).
- The audit log records widening attempts as well as changes.

## Open questions

- Whether a content owner may edit a skill used by several units, or only the copy one unit uses.
