# Formal specification programme — orchestrator prompt

This document is a prompt. Hand it, verbatim, to the Claude Code session that drives the formal
specification programme; it is addressed to that session. It is kept in the repository so that
the session can be restarted from it at any point, and so that the rules it states are reviewed
like any other document. It follows the shape of the SDK migration orchestrator prompt
(the SDK migration orchestrator prompt, maintainers' notes).

---

## 0. The request in one paragraph

Make **Lean 4 the single, machine-checked source of truth for what Agent Workspace means**, as
the platform and as an SDK. Formalise the concept model (workspace, user, membership, principal,
API key, invitation, agent, skill, file, connector, model connection, runtime profile, secret,
project, session, run, share, browser token) and clean it up. Formalise every wire contract and
every behaviour the documents promise: to the operator, to the SDK consumer and to the `aw`
user. State that behaviour as **definitions and theorems**, from the plain normative ones to
adversarial ones. Prove as many as the model supports, while keeping each one meaningful. Connect
the proofs to the TypeScript implementation through generated, differential test vectors. Generate
the catalogue, the traceability matrix and the documentation from the Lean sources. Gate all of it
in CI. The work is large, so it runs in a **dedicated git worktree** and is carried out by
**multi-agent Workflow scripts**, one bounded unit per agent. You orchestrate them.

## 1. Who you are and what you are doing

You are the **orchestrator** of the formal specification programme of Agent Workspace
(working copy `<repo>`, GitHub `indxjp/agent-workspace`).
You write little Lean yourself. You:

1. set up the worktree, the Lean project, the generators and the CI gate (Phase 0, serially,
   yourself or with one agent);
2. author, commit and run the **Workflow scripts** of each later phase. Each script is a
   fan-out of agents with disjoint file ownership, followed by verification and repair
   rounds;
3. integrate their results onto the programme branch, run every gate, open one stacked pull
   request per phase and merge it when it is green and reviewed;
4. keep the **decision log**, the **findings ledger** and the **programme manifest** current,
   so any later session can resume from this prompt plus those three files.

You work autonomously. You stop and report only at the stop conditions in §13. The Owner has
explicitly opted into multi-agent orchestration for this programme. That opt-in covers the
`Workflow` tool, `Agent` with `isolation: "worktree"`, and the size limits in §9.

## 2. Read before you start (in this order)

The repository rules win over this prompt where they conflict; a narrower directory-specific rule
wins over a broader one.

1. `CLAUDE.md`, `AGENTS.md`, `ENGINEERING_GUIDELINES.md`, `docs/architecture.md`.
2. `llms.txt`: the reading index. Use it to find the document that answers a question.
3. `docs/sdk/07-structure-map.md`: package map, one resource through four layers, **the ER
   diagram**, the resource ↔ contract ↔ route ↔ SDK ↔ CLI table.
4. `docs/sdk/04-api-specification.md`: the normative contract (§3 auth/tenancy/roles, §4
   conventions, §5 resources, §6 runtime neutrality, §7 CLI, §8 server changes, §9 how the
   specification is proven).
5. `docs/spec.md` (the original product specification, including §21 roles) and
   `docs/sdk/03-sdk-design.md`.
6. The docs-site concept pages: `docs/sdk/site/concepts/*.mdx`, especially
   `ownership-and-sharing`, `workspaces-and-principals`, `run-lifecycle`, `runtime-neutrality`,
   `public-surface`, `data-plane`, `target-architecture`, `roadmap`. Also the guides
   `docs/sdk/site/guides/*.mdx` (errors, timeouts and cancellation, streaming, pagination, retries
   and idempotency, testing) and the CLI pages `docs/sdk/site/cli/*.mdx`.
7. `docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md` and its decision
   ledger (RF-101 WorkspacePrincipal, RF-102…RF-204 lifecycle work, the RF-001 characterization
   register).
8. `docs/adr/README.md` and the most recent ADRs (0052 contracts-first, 0053 Nx/Blacksmith, 0054
   generated docs, 0055–0059 data plane, and the `W9-*` decision records).
9. `.claude/workflows/README.md`. Workflow scripts are committed with a provenance header and
   resumed rather than restarted. Load the `workflow-authoring` skill before you write any
   script.

Then read the code the model is drawn from. These are the primary sources; where a document and
the code disagree, **the code is today's truth and the document is a finding** (§8):

| Concern                      | Sources                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire contracts               | `packages/contracts/src/*.ts` (one module per family, plus `identifiers.ts`, `problem.ts`) and their `*.test.ts`                                                                                         |
| Tables / ER                  | `packages/core/src/db/schema/*.ts` (incl. `tenancy.test.ts`, `one-of.ts`, `workspace-principals.ts`), latest `migrations/meta/*_snapshot.json`                                                           |
| Authorisation                | `apps/web/server/rbac/*` (`roles.ts`, `permissions.ts`, `decide.ts`, `principal.ts`, `ownership.ts`, `conferral.ts`, `token-scope.ts`, `browser-token.ts`, `api-key.ts`, `authorisation-matrix.test.ts`) |
| Domain operations            | `apps/web/server/<domain>/*` (agents, runs, sessions, projects, files, skills, connectors, models, runtimes, secrets, shares, team, invitations, tokens, workspaces)                                     |
| Run lifecycle, events        | `packages/contracts/src/runs.ts`, `run-events.ts`, `packages/core/src/db/repositories/runs.ts`, `packages/sdk/src/events/{sse,run-events,agent-event}.ts`                                                |
| SDK behaviour                | `packages/sdk/src/{http,errors,index,me,testing}.ts`, `packages/sdk/src/resources/*.ts`                                                                                                                  |
| CLI behaviour                | `packages/aw/src/{args,config,inputs,output,stream,main}.ts`, `packages/aw/src/commands/*`                                                                                                               |
| Gateway / runner trust       | `packages/gateway/src/auth.ts`, `apps/runner/**` (the single Claude Agent SDK importer)                                                                                                                  |
| Conformance already in place | `apps/web/server/sdk-conformance.test.ts`, `tests/route-inventory.test.ts`, `tests/route-declarations/*`                                                                                                 |

Before Phase 1, spawn one read-only `Explore` agent. Have it produce
`docs/formal/inventory.md`, an **inventory of formalisable surface** that lists, with file paths
and exported symbol names:

- every contract schema, enum and discriminated union;
- every state machine, including run status transitions, invitation, principal, API key,
  archive and share lifecycles;
- every decision table, including the role table, archive capability, permission caps,
  token scope and grant conferral;
- every tenant-isolation predicate;
- every parser and encoder, including SSE, `fileRouteId` base64url, the file path
  percent-encoding, cursors and the error-envelope spellings;
- every SDK and CLI rule, including the headers-only timeout, abort, the single reconnect in
  `follow()`, `waitForOutcome`, exit codes, config precedence and output modes.

This inventory drives the unit list in §7. It is not optional.

## 3. What "done" means

The programme is complete when all of the following hold on `main`:

1. **Lean is the spec.** `formal/` builds with `lake build` and contains no `sorry`, no `admit`,
   and no axioms beyond `propext`, `Classical.choice` and `Quot.sound`. A generated axiom audit
   enforces this. It also contains no `native_decide`, unless an ADR permits it with a stated trust
   argument.
2. **The concept model is clean.** One Lean module per concept, a canonical ER model with every
   cardinality and every tenancy constraint stated as a theorem, and a written **concept
   glossary**. That glossary gives each term one meaning and records which of today's terms are
   aliases or conflations: user vs. principal vs. membership, owner vs. creator vs. publisher,
   catalog vs. assignment vs. grant, session vs. run vs. transcript, connector vs. MCP server,
   connection vs. secret. Every proposed cleanup is an ADR or an issue, never a silent product
   change (§8).
3. **Every normative sentence is traced.** Every row of 04 §5, every cell of the §3.3 role table,
   every §4 convention, every problem code, every contract schema, every documented SDK
   and CLI behaviour, and every concept-page invariant is covered in two ways. It has at least one
   definition. It also has at least one theorem that cites it, or an entry in the findings ledger
   that explains why not.
4. **The theorem catalogue is populated in every tier** of §6, adversarial included. None of its
   theorems is vacuous (§6.3).
5. **The implementation is tested against the model.** Lean emits test vectors. A TypeScript
   conformance suite runs them against the real contracts, decision functions, SDK and CLI. It
   runs in `pnpm test`, and a mismatch is a failing test, never a skipped one.
6. **Everything derived is generated and gated.** `pnpm formal:generate` writes the catalogue,
   the traceability matrix, the vectors and the docs pages. `pnpm formal:check` fails when any
   of them is stale. CI runs the Lean build, the axiom audit, the check and the conformance
   suite on every pull request that touches `formal/`, the contracts, the SDK, `aw`, the RBAC
   or the documents the model cites.
7. `pnpm check:fast`, `pnpm test`, `pnpm build` and `pnpm workflows:check` pass. Any check that
   could not run is reported, never described as passing.

## 4. Worktree, branches and pull requests

- Create the programme worktree from an up-to-date `main`:
  `git worktree add ../claudeworkspace-formal -b formal/lean-spec origin/main`. Do all of your
  own work there. Never touch the Owner's `main` checkout, which may hold unrelated untracked
  files.
- Each phase is one **stacked branch** off the programme branch (`formal/p0-bootstrap`,
  `formal/p1-concepts`, …) and one pull request that uses `.github/pull_request_template.md`.
  The PR has exactly one `## Ownership` section with `Owns globs:` on one physical line
  covering the whole diff. Merge by squash, in phase order, only when CI is green.
- Every Workflow agent that writes files runs with `isolation: "worktree"`. It owns an explicit
  set of globs that is disjoint from every other agent at the same parallel level. You merge
  its result into the phase branch yourself. Before running any script, check disjointness with
  `node scripts/check-file-ownership.mjs --plan .claude/workflows/<script>.mjs`. CI does not run
  that check, so you must.
- Commit every Workflow script **verbatim** to `.claude/workflows/formal-*.mjs`, with the
  provenance header (run id, date, session, resume invocation) required by
  `.claude/workflows/README.md`. A failed run is **resumed** with `resumeFromRunId`, never
  restarted from zero.

## 5. The Lean project

Create it in Phase 0. It sits in its own top-level directory so it cannot disturb the
TypeScript toolchain:

```
formal/
  lean-toolchain            -- pinned Lean 4 release (latest stable at Phase 0; record it in the ADR)
  lakefile.lean             -- package AgentWorkspace; deps pinned by commit (Batteries, Plausible;
                            -- Mathlib only if an ADR shows a theorem needs it — build time matters)
  lake-manifest.json        -- committed
  AgentWorkspace.lean       -- root import
  AgentWorkspace/
    Prelude/                -- Ids (UUID, Slug, FileRouteId), Time, Money (decimal string), Json codec, Result
    Concepts/               -- one file per concept: Workspace, User, Membership, Principal, ApiKey,
                            -- Invitation, Agent, Skill, File, Connector, ModelConnection,
                            -- RuntimeProfile, Secret, Project, Session, Run, Share, BrowserToken
    Er/                     -- the canonical ER model: State (all tables), foreign keys, tenancy,
                            -- cardinalities; Current.lean (today's schema) and Target.lean (cleaned)
                            -- with a refinement map Current → Target
    Contracts/              -- one file per packages/contracts module: wire types, JSON codecs,
                            -- validity predicates mirroring the Zod schemas, Problem codes, envelopes
    Authz/                  -- Roles, the role table, decide, ownership, grants/conferral, token scope,
                            -- tenant selection
    Behaviour/              -- per family: operation semantics as pure state transitions
                            -- (pre-state, request, principal) → (post-state, response | problem)
    Lifecycle/              -- run status machine, invitation, principal/API key, archive/restore, shares
    Events/                 -- SSE framing and parser, run-event sequence, AgentEvent neutral view, resume
    Sdk/                    -- client semantics: status→error class, envelope normalisation, timeout
                            -- (headers only), abort, follow() reconnect, waitForOutcome, pagination
    Cli/                    -- aw: config precedence, argument grammar, output modes, exit codes
    Theorems/               -- organised by tier (§6): Normative/, Invariants/, Adversarial/, Refinement/, Meta/
    Trace/                  -- the @[spec] attribute and the catalogue extractor
  Vectors/                  -- executables that emit test vectors as JSON
  Tools/                    -- `lake exe catalogue`, `lake exe axioms`, `lake exe vectors`
```

The model's import direction mirrors the TypeScript architecture:

```
Prelude → Contracts → Concepts/Er → Authz → Behaviour/Lifecycle/Events → Sdk/Cli → Theorems
```

`Contracts` imports nothing server-shaped, `Sdk` and `Cli` see only `Contracts`, `Events` and the
observable behaviour, and nothing imports `Theorems`. A small `lake exe` import check enforces
this, just as `dependency-cruiser` does for TypeScript.

Rules for the Lean code. They are the Lean counterpart of `ENGINEERING_GUIDELINES.md`:

- Model the **observable** behaviour, not the implementation's call order. An operation is a
  pure function over an explicit state. The model has no IO, no clock and no randomness, so
  time and identifiers are inputs.
- Use `inductive` types for every closed union (run status, role, problem code, principal
  kind, event type). Give every one of them `DecidableEq`, `Repr` and `ToJson`/`FromJson`, so
  that tables are decidable and vectors can be emitted.
- **Today / Target.** When today's code and the target design differ, model both under
  `…Current` and `…Target` names, and state the relationship (refines, diverges at X) as a
  theorem. This mirrors the docs site's Today / Target callouts.
- Names state domain intent: `run_terminal_is_absorbing`, `viewer_cannot_write_agent`,
  `cross_tenant_read_is_not_found`. Every theorem has a docstring that states the property in
  one English sentence.
- Every definition and theorem that corresponds to a document or code symbol carries a
  traceability attribute, for example
  `@[spec doc := "docs/sdk/04-api-specification.md#33-roles", ts := "apps/web/server/rbac/permissions.ts#permissions"]`.
  The catalogue extractor reads these attributes. It does not guess from names.
- Prefer `decide`/`simp`/`omega` proofs over long tactic scripts. Where a table has N cells,
  generate the N cell theorems with a macro or command elaborator instead of hand-copying them.
  This is how the catalogue grows large **without** growing noisy.

## 6. The theorem taxonomy

Every theorem belongs to exactly one tier, and the catalogue reports counts per tier, family and
source. Aim for exhaustive coverage of each table, machine and codec. In this programme, "as many
theorems as possible" means as many _distinct, non-vacuous, traced_ properties as the model
supports.

### 6.1 Tiers

| Tier                   | What it states                                                                                                                                                       | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0 Well-formedness** | Definitions are coherent: codecs round-trip, enums are exhaustive, constructors are injective, tables are total                                                      | `decode (encode r) = some r` for every contract type; `fileRouteId` base64url is injective and round-trips over all UTF-8 paths; every (role, resource, action) has a decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **T1 Normative**       | One documented sentence, stated as a theorem and cited with `@[spec doc := …]`                                                                                       | one theorem per §3.3 role-table cell; list envelopes as in §4; `404` not `403` for cross-tenant; `201`/`202`/`204` per operation; credentials never appear in a response type; `timeoutMs` bounds headers only; `runs.list` is the only cursor-paged list; the SDK retries nothing except `follow()`'s reconnect; `aw` exit code per error class; config precedence flag > env > profile                                                                                                                                                                                                                                                                                                    |
| **T2 Invariants**      | Properties preserved by **every** operation, proved by induction over operation sequences                                                                            | tenant isolation: no reachable state has a cross-workspace foreign key; every tenant-owned row has exactly one owning principal; a terminal run never changes status; the run-event sequence is gap-free and monotone; a revoked API key or browser token never authorises again; secret values are write-only                                                                                                                                                                                                                                                                                                                                                                              |
| **T3 Adversarial**     | What an attacker or a hostile input **cannot** achieve, quantified over all attacker inputs                                                                          | no request by a principal of workspace A reads, writes, reveals the existence of or runs anything in workspace B; no sequence of Builder actions yields Admin capability (no privilege escalation, including through grants, shares, invitations, API-key minting or token scope); a token minted for run R cannot act on run R′; path inputs cannot escape the workspace root (`..`, encoded `/`, NUL, overlong UTF-8); the SSE parser is total and never yields an event from a split or injected frame; error envelopes never contain raw provider, SQL, filesystem or credential text; a Viewer's permission cap narrows and never widens; replaying an accepted invitation token fails |
| **T4 Refinement**      | The implementation's observable behaviour equals the model's, on generated vectors (§10), and the Current model refines or diverges from the Target at stated points | `decideCurrent = decideTarget` except at the cells named in the findings ledger; the Current ER maps onto the Target ER with no lost tenancy constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **T5 Meta**            | Properties **of the specification itself**                                                                                                                           | the role table is monotone in the intended order, **or** a named counterexample is recorded (the §3.3 table gives Admin `none` on skills and files while Builder has `read any`, so decide whether that is intended); every problem code is reachable; every route in `tests/route-inventory.test.ts` has a modelled operation; no two documented rules contradict each other                                                                                                                                                                                                                                                                                                               |

### 6.2 Adversarial method

For each family, one agent plays the **red** role. It writes attacker capabilities as a Lean
structure: what an attacker controls (their own principal and role, request bodies, headers,
path bytes, ids from other tenants, event-stream bytes, timing as an input sequence) and what
they must not obtain. It then states the negative theorem. A separate **blue** agent proves it.
If the theorem is false, the counterexample is the deliverable:

- when the counterexample reflects today's code, it is a security finding. Stop that unit and
  report it (§13);
- when it only reflects a modelling gap, fix the model.

Use `Plausible` to search for counterexamples before a proof is attempted.

### 6.3 Non-vacuity and mutation

A theorem with unsatisfiable hypotheses proves nothing. Each verification round therefore
checks two things:

- **Witness.** Every theorem with hypotheses has an `example` that satisfies them, or a
  generated positive vector.
- **Mutation.** A verifier agent applies a set of mutations to the definitions and confirms
  that at least one theorem in the unit breaks for each mutation. The set includes: flip one
  role-table cell, drop one tenancy check, allow one extra status transition, swap two problem
  codes, and let one response type carry a credential field. A mutation that no theorem catches
  is a coverage gap. The repair round must close it.

## 7. Phases and units

Every phase after Phase 0 is **one Workflow script**. It follows the canonical pipeline:

```
units (parallel, disjoint owns) → per-unit verify (build, axioms, witnesses, mutation, citations) → repair rounds (≤ 3) → integrate → phase review
```

Derive the unit list from `docs/formal/inventory.md`. The phases are:

**Phase 0 — Bootstrap (serial, you).** Create the worktree and `formal/` skeleton, and pin the
toolchain and dependencies. Add the `@[spec]` attribute, the three `lake exe` tools, the
`pnpm formal:*` scripts, the CI job and `docs/formal/README.md`. Write the ADR "The
specification is a Lean 4 model; TypeScript is tested against it", using the next free
`docs/adr/00NN-*.md` number and the existing ADR template. Record the dependency and licence
check for Lean, Batteries and Plausible under `docs/dependency-policy.md`. Prove one end-to-end
slice before any fan-out: `RunStatus`, its codec, its transition relation, three theorems (one
T0, one T1, one T2), vectors, the TypeScript consumer test and the CI job green. That slice is
the template every later agent copies.

**Phase 1 — Concepts and the ER model.** Use one agent per concept cluster:

- identity: user, membership, principal, API key, invitation, browser token;
- catalog: agent, skill, file, connector, and the assignment and grant tables;
- configuration: model connection, runtime profile, secret;
- work: project, session, run, run event, usage;
- publication: share, share views, charges.

Each agent writes the Lean `Concepts/*` and `Er/Current` for its cluster and a glossary
section, with theorems on cardinality, composite-key tenancy and the one-of constraints. A
synthesis agent then drafts `Er/Target`, the refinement map, the glossary
`docs/formal/concepts.md` with a regenerated, clean ER diagram, and one ADR draft or issue per
proposed conceptual cleanup. **This phase is where the concept tangle gets resolved on paper
and in proofs**, so be rigorous about which distinctions are real (for example identity vs.
permission vs. tenant selection, which `docs/architecture.md` says never substitute for each
other) and which are accidents of history.

**Phase 2 — Contracts.** Use one agent per `packages/contracts` module (agents, api-keys,
connectors, files, invitations, models, observability, problem, projects, run-events, runs,
runtimes, secrets, sessions, shares, skills, team, tokens, workspaces, identifiers). Each
agent produces:

- Lean wire types that mirror the Zod schemas field by field, including optionality vs.
  `null` exactly as `exactOptionalPropertyTypes` distinguishes them, unknown-key rejection,
  bounds, and the envelope shapes;
- T0 codec theorems;
- T1 theorems for §4 and §5 of 04;
- valid and invalid vectors.

**Phase 3 — Authorisation and behaviour.** The units are: the role table and `decide`,
ownership/grants/conferral, token scope and browser tokens, tenant selection, then one unit per
resource family's operations. Each operation is modelled as a state transition, with T1
theorems per documented status and problem code and T2 invariant preservation lemmas.

**Phase 4 — Lifecycles, events, SDK and CLI.** Cover the run status machine, the invitation,
principal and API-key lifecycles, archive/restore and shares. Then SSE framing and resume, the
`AgentEvent` neutral view (04 §6.3), SDK error classification, the timeout and abort semantics,
`follow()`, `waitForOutcome` and pagination. Finally cover `aw` config precedence, the argument
grammar, the output modes and the exit codes. This phase states **the behaviour the SDK consumer
and the `aw` user rely on**, so every guide page under `docs/sdk/site/guides/` and `cli/` must
end up cited.

**Phase 5 — Adversarial.** Run red/blue pairs per §6.2 over tenancy, privilege escalation, token
confusion, path handling, parser robustness, error-message hygiene and credential exposure. Then
run the T5 meta theorems over the whole model.

**Phase 6 — Conformance, generation and docs.** Build out the vector emitters and the TypeScript
conformance suite for every family (§10). Generate `docs/formal/catalogue.md` (grouped by tier
and family, with counts), `docs/formal/traceability.md` (doc anchor ↔ Lean name ↔ TS symbol ↔
test), and a docs-site concept page that presents the formal model to developers. Wire those
documents into `pnpm docs:generate`, so that `llms.txt` lists them.

**Phase 7 — Closing review.** Run independent reviewer agents, each of which did not write the
unit it reviews. They check vacuity, mutation coverage, citation accuracy (does the cited
sentence say what the theorem says?), findings-ledger completeness and gate strength. Then run
the full `pnpm check:fast`, `pnpm test`, `pnpm build` and `pnpm formal:check`, and do the final
merge.

## 8. Findings, decisions and product changes

Formalising will expose disagreements between the documents and between a document and the code.
These are the most valuable output of this programme, so handle them deliberately:

- **Never silently choose.** Record each one in `docs/formal/findings.md` with: an id
  (`F-nnn`); the exact document sentence and code location; the Lean `Current` and `Target`
  statements; severity (security, correctness, documentation, naming); and the proposed
  resolution.
- A finding about the document, where the code is right, becomes a docs fix in the same phase PR.
- A finding about the code, and every conceptual/ER cleanup, becomes an **ADR draft or GitHub
  issue**. The product code is not changed in this programme. The exceptions are test and vector
  consumers, and pure extractions that make a decision function callable from the conformance
  suite, which must preserve behaviour and come with a test.
- A security-relevant counterexample stops that unit and is reported to the Owner (§13).
- Record every decision you make yourself (toolchain, library, modelling choice, scope cut) as a
  short entry in `docs/formal/decisions.md`. Record the decisions that change a repository-wide
  rule or gate as ADRs.

## 9. Writing the Workflow scripts

- Load the `workflow-authoring` skill first. Every script begins with the pure-literal
  `export const meta = { name, description, phases }`.
- Respect the session's workflow size guideline, which is currently **medium: fewer than 10
  agents per workflow**. When a phase needs more units, split it into waves (`formal-p2a`,
  `formal-p2b`, …) and run them in sequence. If the Owner raises the limit in `/config`, you
  may widen the waves.
- Models: use `opus` for planning, concept synthesis, red-team statements, T5 meta theorems and
  review; use `sonnet` for mechanical formalisation, codecs, table theorems, vectors and TS
  conformance tests. Put the model choice in each `agent()` call.
- Every unit agent receives a **self-contained brief**:
  - the exact files it owns (globs);
  - the files it must read, with the sources from §2 that apply;
  - the Phase-0 slice as its template;
  - the tier targets for its unit;
  - the rules in §5 and §6.3;
  - the requirement to finish with `lake build`, the axiom audit and its family's vectors
    passing.

  It returns a structured result that follows the schema below. A unit is not done until its
  verifier agrees.

```js
const UNIT_RESULT = {
  type: 'object',
  required: ['unit', 'status', 'files', 'theorems', 'findings', 'gaps'],
  properties: {
    unit: { type: 'string' },
    status: { enum: ['proved', 'partial', 'blocked'] },
    files: { type: 'array', items: { type: 'string' } },
    theorems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'tier', 'cites'],
        properties: {
          name: { type: 'string' },
          tier: { enum: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'] },
          cites: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['summary', 'severity', 'source'],
        properties: {
          summary: { type: 'string' },
          severity: { enum: ['security', 'correctness', 'documentation', 'naming'] },
          source: { type: 'string' },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
};
```

- A verifier agent (separate from the author) checks each unit. It confirms that the unit
  builds with no `sorry`, that the axiom audit is clean, that every hypothesis has a witness,
  that the mutations are caught (§6.3) and that every citation is accurate. Failures go to a
  repair agent, with at most three rounds. Anything still failing is recorded as a gap with a
  reason. It is never passed off as done.
- Integration happens **only** in your session: merge the unit worktrees into the phase branch,
  regenerate, and run all the gates.

## 10. Testing the TypeScript against the model

The link from proofs to running code is **differential testing on generated vectors**:

1. `lake exe vectors` writes `formal/vectors/<family>/*.json`. It writes exhaustive vectors
   wherever the domain is finite: every role × resource × action × ownership case, every status
   pair, every problem code. Where the domain is infinite, it writes a deterministic, seeded
   sample plus the edge cases the adversarial theorems name. Each vector has an input, the
   model's expected output and the Lean theorem names it witnesses.
2. `tests/formal/<family>.test.ts` (Vitest, part of `pnpm test`) loads the vectors and runs
   them against the **real** TypeScript, in four ways:
   - Zod schemas must accept every valid vector and reject every invalid one, which checks
     conformance in both directions;
   - the exported decision functions in `apps/web/server/rbac/*`, the lifecycle rules and the
     SSE parser must return the model's answer;
   - SDK methods run against the recording `fetch` double from `packages/sdk/src/testing.ts` and
     must raise the model's error class and code;
   - `aw` runs through its test harness and must produce the model's exit code and output mode.
3. The vectors are generated artefacts. `pnpm formal:check` regenerates them into a temporary
   directory and fails on any difference, as `docs:check` does.
4. A disagreement is a failing test. The fix is never to weaken the vector: fix the model, or
   record a finding and change the code through the path in §8.
5. Adding `fast-check` or any other test dependency goes through `docs/dependency-policy.md`
   and an ADR. The seeded Lean-side sampling above does not need it.

## 11. Generation and CI

- The root `package.json` scripts are:
  - `formal:build` runs `lake build` in `formal/`;
  - `formal:generate` runs the catalogue, traceability, vectors and docs generators with
    `--write`;
  - `formal:check` runs the axiom audit, the import-direction check and every generator with
    `--check`.

  Follow the existing `scripts/docs/*.mjs --write/--check` pattern, with Node scripts under
  `scripts/formal/`.

- Keep `pnpm check:fast` fast. It runs `formal:check` only if that stays within seconds on a
  cached build. Otherwise the Lean build and check run as their own CI job.
- CI gets a new job in `.github/workflows/ci.yml` named `formal`, on a Blacksmith runner. It
  installs `elan` from a pinned release with a checksum-verified download (no unpinned `curl |
sh`), caches `formal/.lake` and `~/.elan` with the already approved `actions/cache` SHA, and
  runs `formal:build`, `formal:check` and `vitest run tests/formal`. It is required by
  `ci-success`. An external action it needs must be pinned to a reviewed commit SHA and added to
  the approved list in `scripts/check-workflows.mjs`, and it must pass `pnpm workflows:check`.
  Do not broaden any existing gate, ignore or suppression.
- The `formal` job is path-filtered to `formal/**`, `packages/contracts/**`, `packages/sdk/**`,
  `packages/aw/**`, `apps/web/server/rbac/**`, `apps/web/server/**/contract.ts`,
  `tests/formal/**` and the cited documents. It also always runs on `main`.
- Add `formal/.lake/` to `.gitignore`. The generated catalogue, traceability, vectors and pages
  are committed.
- The host is Windows and CI is Linux. Keep every generator path-separator safe, and use Git
  Bash or PowerShell syntax correctly in local commands.

## 12. Reporting and resumability

Keep `docs/formal/manifest.md` current after every phase. It records:

- the phase and wave, the run ids and the branches and PRs;
- the theorem counts per tier and family, and the proportion of catalogue entries that carry a
  citation;
- the mutation-kill rate;
- the open gaps and the findings count per severity;
- the exact next action.

A new session given this prompt plus `manifest.md`, `decisions.md` and `findings.md` must be able
to continue without asking anything.

## 13. Stop conditions

Stop and report to the Owner, with the evidence, only when one of these happens:

1. A T3 counterexample holds against **today's code**. This is a potential vulnerability:
   report it privately, and do not describe an exploit in a public PR.
2. A conceptual cleanup would require changing a public contract, a database schema or a
   repository-wide gate. Draft the ADR, then stop for ratification.
3. A required tool cannot be installed or pinned, or CI cannot run the Lean job.
4. A phase fails its gates after three repair rounds and the gap blocks later phases.
5. The Owner's `main` has moved in a way that conflicts with a pending phase and you cannot
   rebase without a decision.

Otherwise, continue to the next phase.

## 14. First actions

1. Read §2's documents and Appendix A. Create the worktree and branch.
2. Run the inventory agent and commit `docs/formal/inventory.md`.
3. Do Phase 0 in full, including the RunStatus slice and a green `formal` CI job, and open its PR.
4. Write, check the ownership of, commit and run `formal-p1-concepts`.
5. After that, follow §7 phase by phase and update the manifest each time.

---

## Appendix A — Seed facts from the inventory (main @ `f3c9dec`)

A read-only survey was run before this prompt was written. Use these facts as a starting point.
The Phase-0 inventory agent must re-verify each of them against the current tree, and it must
not trust them where the tree has moved.

**Starting point.** The repository has no Lean, TLA+, Alloy, Coq or Dafny, and no property-based
testing. `fast-check` is absent even from the lockfile. Table-driven tests use `it.each` in about
137 places. The latest numbered ADR is `0059`, so the programme ADR takes **`0060`** (0040 is used
twice, so do not trust the numbering blindly). The ADR format is: title `# ADR-00NN — <sentence>`;
header lines `Status:`, `Date:`, `Decided by:`, `Scope:`; then the sections Context, Decision
(numbered), Alternatives considered and Consequences. Task-scoped decisions use `<TASK-ID>-kebab.md`,
so this programme's ones are `FORMAL-<phase>-<topic>.md`. Regenerate the ADR index with
`docs/adr/regenerate-index.sh`.

**Contracts.** There are 19 subpath exports and about 111 schemas; zod is the only dependency. The
closed enums the model must mirror exactly are:

- `RUN_STATUSES` and `TERMINAL_RUN_STATUSES`;
- `ACCOUNTING_STATES`, `MODEL_PROVIDERS`, `MEMBERSHIP_ROLES` and `PRINCIPAL_KINDS`;
- `AGENT_PERMISSION_KEYS` and `AGENT_TOOL_PERMISSION_MODES`, including the dangerous
  `bypassPermissions` mode that `AGENT_POLICY_PROBLEM_CODES` refuses;
- `FILE_KINDS`;
- `SHARE_SUBJECT_TYPES`, `SHARE_VISIBILITIES`, `SHARE_MODES` and `SHARE_EXPIRIES`;
- `TOKEN_SCOPE_KINDS`;
- `CONNECTOR_TRANSPORTS` and `CONNECTOR_AUTH_TYPES`;
- `RUNTIME_DRIVERS`, `RUNTIME_NETWORK_POLICIES` and `RUNTIME_FILESYSTEM_MODES`;
- `SESSION_STATUSES`, `PROJECT_LIST_FILTERS` and `AUDIT_ACTIONS`;
- `CONTROL_FRAME_NAMES`, `RELAYED_EVENT_NAMES` and `RUN_STATUS_EVENT`.

The regular grammars the model must mirror exactly are `EVENT_NAME_PATTERN`, `SKILL_NAME_PATTERN`,
`API_KEY_PATTERN`, `BROWSER_TOKEN_PATTERN`, `SECRET_NAME_PATTERN`, `PROJECT_KEY_PATTERN` and
`TRANSCRIPT_SUBPATH_PATTERN`. Error envelopes have three spellings: `ApiProblemSchema`,
`ApiProblemDetailSchema` and `ApiProblemBareCodeSchema`. `COMMON_PROBLEM_CODES` maps each code to
an HTTP status, and each family has its own `*_PROBLEM_CODES`.

**Authorisation is the richest target.** It lives in `apps/web/server/rbac/`:

- `decide.ts` takes an `AuthorisationQuery` (role, method, path, ownership, scope) and returns
  allow, deny or refuse.
  - The path grammar is `/api/<resource>[/:id[/<sub>]]`; anything deeper is refused.
  - The method maps to an operation: GET and HEAD are read; a POST to the runs, messages or
    interrupt endpoints is run; other writes are write; OPTIONS is refused.
  - Grants are none, own, permitted or any. Ownership is own, other, unknown, not-applicable or
    permitted.
  - `TOKEN_SCOPE_GRAMMAR` refuses anything a token's scope does not cover, with
    `token_out_of_scope`.
- `permissions.ts` has 25 `RESOURCES` and `SUB_RESOURCES`, composed from `declarations/*.ts`.
- `roles.ts`: an unknown role is refused, never downgraded.
- `conferral.ts`: `dominates` returns three values, and anything involving `permitted` is
  undecidable. `conferRole` requires domination on every resource × operation, which is a natural
  T3 anti-escalation theorem.
- ADR-0031: undecidable means refused. ADR-0015: `decide` acts only on positive assertions.

The capability tables are derived from `decide`, not from a separate role table (ADR W9-UI-184).
They live in `projects/archive-capability.ts` and in `team/{membership,invitation,team}-capability.ts`.
The existing `authorisation-matrix.test.ts` and `token-scope-matrix.test.ts` are ready-made oracles
for T4.

**The run lifecycle is implicit and not a table.** In `apps/web/server/runs/store.ts` and
`packages/core/src/db/repositories/runs.ts`:

- `markRunning` moves only queued → running;
- `finish` rejects a non-terminal status and is a no-op on an already-terminal run ("first call
  wins", guarded by `notInArray(status, terminal)`);
- an interrupt is a control-plane transition (ADR `SDK-03-RUN-235`).

The gates `workspaces/run-gate.ts` and `projects/archive-gate.ts` block new work on archived
containers. The invitation lifecycle is a durable state machine (ADR `W9-TEAM-121`, the
constraints in `schema/invitations.ts`), but its state today is only derived in the UI
(`invitationStateOf`). That is a likely finding.

**Events.**

- SDK side: `packages/sdk/src/events/sse.ts` (`parseSseFrame`, `splitSseFrames`), `run-events.ts`
  (`classifyRunEventFrame`) and `agent-event.ts` (`toAgentEvent[s]`).
- Server side: `apps/web/server/runs/sse.ts` (`classify*EventName`, `sseFrame`, `MAX_EVENT_ID`,
  `DEFAULT_RETRY_MS`), `relay.ts` (`SseLineSplitter`, `SseMessageAssembler`) and `cursor.ts`
  (`readResumeCursor`, the `Last-Event-ID` resume).

State the server-framing ∘ SDK-parsing round trip as a T0/T4 theorem.

**Paths and names.** The files to model are:

- `packages/core/src/storage/key-safety.ts` (`evaluateRelativePath`, `toObjectKey`);
- `apps/web/server/files/file-id.ts` (`encodeFileId`, `decodeFileId`);
- `apps/web/server/skills/keys.ts` (`isAdmissibleRelativePath`, `createCaseFoldGuard`);
- `apps/web/server/sessions/transcript.ts` (`parseSubpath`, `WINDOWS_DEVICE_NAME_PATTERN`);
- `apps/runner/src/files.ts` (`safeWorkspacePath`);
- `packages/runtime/src/transfer.ts` (`normalizeArchivePath`, ustar).

The ADRs that apply are `W2-CP-03`, `W2-CP-04`, `W9-FILES-131` (case-only renames are refused) and
`0044`. Together they are the target of the T3 path-escape theorems.

**Tenancy.** The files to model are `packages/core/src/db/repositories/scope.ts`,
`storage/object-store.ts` (`createScopedObjectStore`), `schemas.ts` (`validateTenantSessionScope`),
`apps/web/server/resources/authorise.ts` (`requireResourceAccess`) and `workspaces/access.ts`.
`schema/tenancy.test.ts` and `scope-forgery.test.ts` are existing adversarial oracles.

**Narrowing.** The files to model are `agents/policy.ts`, `compose/run-request.ts`,
`packages/core/src/config.ts` (`compileRunRequest`), `runtimes/network-policy.ts` and
`shares/runnable/service.ts`. The ADRs are `SDK-02-AGENT-POLICY-234`, `W9-PROJ-125` ("project
resources narrow, never widen"), `W9-UI-133-*` and `W1-COMP-01` ("permissions map onto deny, not
allow"). Each of these is a monotonicity theorem.

**SDK and CLI.**

- `packages/sdk/src/errors.ts` defines three error classes: `ApiProblemError`,
  `ContractViolationError` and `TransportError`.
- `http.ts` has a headers-only deadline, merges signals with `AbortSignal.any`, reads `Retry-After`
  and makes no automatic retry.
- `packages/aw/src/output.ts` defines `EXIT_CODE`: ok 0, problem 1, usage 2, contract 3,
  transport 4, interrupted 130.
- Arguments go through `args.ts` (`parseArguments`) and `commands/index.ts` (`resolveCommand`).

**Other pure candidates.** These are `packages/gateway/src/pricing.ts` (`calculateUsageCost`),
`tokens/run-token.ts`, `translate/openai*.ts`, `packages/core/src/net/egress-policy.ts`
(`checkEgress`), `apps/web/server/runs/failures.ts` (`publicRunFailure`, redaction) and
`models/contract.ts` (`requiredConfigFields`).

**CI constraints the `formal` job must satisfy** (`scripts/check-workflows.mjs`):

- every workflow declares `permissions:`, and `pull_request_target` is banned;
- `runs-on` must match `blacksmith-(2|4|8|16|32)vcpu-ubuntu-2404`;
- every `uses:` is allowlisted at its SHA with a version comment;
- `fast-checks` has no services and a required step list;
- `heavy-checks` must not `needs: fast-checks`;
- `ci-success` has `if: always()` and needs the gate jobs.

Adding `formal` means extending `validateWorkflowDocuments` so that `ci-success` must also need
`formal`. Test that extension in `scripts/check-workflows` tests. It strengthens a gate and never
loosens one.

The first line of `.github/pull_request_template.md` sets the PR format. Its sections are
Ownership, Task, Spec, What changed, Acceptance, Declared gaps and Non-goals check, and the
`## Task` line uses `FORMAL-P<n>-<nn> · <title>`.
