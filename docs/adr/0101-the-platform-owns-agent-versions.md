# ADR-0101 — The platform owns agent versions; the UI and `aw push` both create one

Status: accepted in part (slice 1: immutable numbered agent versions, a `local` pointer, and `POST /api/agents/:id/versions` with a dry run; slice 2: `aw dev` does not apply over an agent edited in the UI; 2026-10-04: the blueprint decisions Q1 and Q8, recorded as amendments and not built yet); the rest remains proposed — draft from the developer-journey hearing (decisions D14, D17, D19, D21, D27)
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; slice 1 accepted 2026-10-02 by the planning writer of the developer-journey delivery on the Owner's delegation (see "Slice 1 acceptance"); slice 2 accepted 2026-10-03 by the implementing agent of S2-00b on the Owner's delegation (see "Slice 2 acceptance"); the rest to be confirmed when it is accepted
Scope: `packages/contracts/src/agents.ts`, `packages/core` (agent store), `apps/web` (agent screens), `packages/sdk`, `packages/aw`; amends the thesis of `docs/sdk/site/concepts/target-architecture.mdx`

## Slice 1 acceptance

Accepted on 2026-10-02 for slice 1 of the developer-journey delivery
(the delivery plan), by the planning writer on the
Owner's delegation. Only the decisions below are accepted. Everything else in this record remains
proposed.

Accepted now:

- **A version is an immutable snapshot of one agent.** Teams (ADR-0104) are not units yet.
  Versions are numbered per agent (`1`, `2`, …) and carry the principal who made them, `via`
  (`ui`, `aw-push` or `api`) and a summary of 1–200 characters. The store offers insert and read
  only.
- **The body is `{ definition: AgentDefinition, surfaces: SurfaceDefinition[] }`.**
  `AgentDefinition` (ADR-0076) is unchanged, so `export` and `import` keep working. Surfaces sit
  beside it, not inside it, so the strict v1 file format does not change. The surface schema is
  ADR-0108's slice-1 subset.
- **`POST /api/agents/:id/versions` creates a version.** With `dryRun: true` it runs the same
  validation and writes nothing; `aw check` calls that. `POST /api/agents` gains a second body
  form, `{ version }`, that creates the agent, version 1 and the `local` pointer in one
  transaction, because a new name has no id to post to. Both forms run one validation pipeline.
- **Environments point at versions, and slice 1 has one environment, `local`.**
  `PUT /api/agents/:id/pointers` moves it. Moving the pointer materialises the version onto the
  existing agent row and its skill, connector and file assignments in one transaction, with an
  audit event. Runs, `agents.get` and the agent screen keep reading the row.
- **`aw push`** creates versions from `agents/*.ts` and `surfaces/*.ts` and moves `local`.

Interim exceptions, stated so that no reader takes them for the decision:

- The legacy writes (`PATCH /api/agents/:id`, `PUT …/policy`, `PUT …/resources`, the agent screen)
  still edit the row and create no version until V-2. A later `aw push --yes` replaces such an
  edit, so `aw push` without `--yes` prints the difference between the current row and what it
  would write, and writes nothing.
- `agents.remove` still cascades over the agent's versions (RF-201 stays open). That contradicts
  "all versions are kept" until archive replaces delete.
- A version does not pin skill or tool revisions yet (N-1 / V-3).

Still proposed: pinned revisions, promotion and rollback, preview URLs, evaluation of every draft,
the update route creating a draft, `aw pull`, a conversation finishing on its version, and the
retention questions.

## Amendment — what S1-22 settled (issue #504, 2026-10-02)

Reason: the S1-19 exit test found that an agent `aw dev` pushes cannot run. `toAgentVersionBody`
always writes `runtimeProfileName: null`, which the contract described as "the deployment default",
but no such default existed: `resolveDefinition` turned the null name into `runtimeProfileId: null`,
and `runs.start` answered `422 agent_runtime_profile_missing`.

- **A null `runtimeProfileName` means the workspace's default runtime profile, read when the
  version is applied.** A workspace may mark one of its own runtime profiles as its default
  (`runtime_profiles.workspace_default`, `true` or `NULL`, at most one `true` per workspace by the
  unique key `runtime_profiles_workspace_default_key`). The mark lives on the profile, not as an id
  on `workspaces`: a reference from the tenant root back into `runtime_profiles` would be a second
  schema cycle, which the dependency gate limits to the workspace model default alone (the same
  reason `agents.setup_configured_at` lives on the agent). On the profile, another workspace's
  profile can never be the default, and deleting the profile removes the default with it.
  `resolveDefinition` resolves a null name to that profile's id, or to `null` when the workspace
  has none. A null name is never reported missing or ambiguous. A named profile resolves exactly as
  before and never falls back to the default.
- **Every path that materialises an agent resolves it**: `POST /api/agents {version}` and
  `PUT /api/agents/:id/pointers`. The agent row therefore carries a concrete profile id, and the
  run preflight and the launch are unchanged and stay strict.
- **Versions stay immutable.** The stored body keeps `runtimeProfileName: null`; only the meaning of
  that null changed. Applying the same version in a workspace whose default changed later
  materialises the new default.
- **Nothing is silently picked.** A workspace that never chose a default keeps today's
  `422 agent_runtime_profile_missing`. The first writer of a default is the local runtime's
  bootstrap (ADR-0109, amendment for S1-22); there is no screen for choosing one yet.
- **A default chosen later reaches the agents that were waiting for it.** `aw push` applies
  nothing when the body is unchanged, so an agent applied while the workspace had no default (or
  whose default was deleted: the foreign key sets the row to `NULL`) would otherwise stay refused.
  Each time `ensureWorkspaceDefault` leaves the workspace with a default (`kept`, `adopted` or
  `created`), it also writes that default, in the same transaction, onto every agent whose row has
  no runtime profile, whose pointed versions all name none, and whose row was not edited after its
  pointer moved (`agents.updated_at <= agent_version_pointers.updated_at`). That is exactly what
  applying the pointed version again would write, so `agents.updated_at` is left alone and the
  next `aw push` still reads the agent as unedited. Agents that were never pointed, were edited by
  hand, or whose version names a profile are not touched. In the local runtime this runs on every
  start, so restarting `aw dev` after fixing the profile repairs such agents.
- **Declared: agents applied before this change keep `runtimeProfileId: null`** until their
  workspace's default is ensured (above) or their version is applied again (a pointer move or a
  new `aw push` with a changed body). No migration rewrites agent rows.
- **Declared: the `agent_runtime_profile_missing` hint** still says to attach a runtime profile or
  finish the setup wizard. Re-pointing the agent (`aw agents pointers set`) or restarting `aw dev`
  after a default exists also clears it; the hint text lives in the run preflight, outside this
  change.
- **Declared: a profile deleted between resolution and the write** is the existing
  `reference-gone` race: the write is retried once with a fresh resolution, as for any reference.

The contract's doc comment on `runtimeProfileName` (`packages/contracts/src/agents.ts`) and the
SDK's (`packages/sdk/src/define/version-body.ts`) now say "the workspace's default runtime profile
(none: runs are refused until the agent names one)". No schema or wire shape changed.

## Amendment — `production` is a pointer (issue #612, 2026-10-04)

`PUT /api/agents/:id/pointers {environment: 'production'}` is allowed now, under the same pointer
permission as `local`. It moves only the `production` pointer and writes no promotion approval.

## Amendment — the promotion gate (issue #619, 2026-10-04)

Every move of `production` but a rollback passes the promotion gate: with the policy ceiling's
`promotion.minEvalScore` set, the version's newest evaluation must pass at least that share of its
cases.

## Amendment — a console edit is a version (issue #616, 2026-10-04)

The first interim exception above ends for the three legacy writes. `PATCH /api/agents/:id`,
`PUT …/policy` and `PUT …/resources` save the edited agent as the next version (`via: 'ui'`)
through the same version save and pointer move `aw push` uses, and point `local` at it; their
response bodies are unchanged. The edit lands on the `local` version's body while the row is still
materialised from it, otherwise on the row and its assignments. `POST /api/agents` and the setup
agent's reconciliation still write the row without a version.

## Amendment — setup marks the workspace default (issue #832, 2026-10-12)

A version that names no profile resolves to the workspace default at apply time, so `aw push`
(which always sends `runtimeProfileName: null`) detached the agent from the runtime the setup
wizard had just attached whenever no default existed. First-run setup now makes the runtime
profile it creates the workspace default, because the admin chose that runtime in the wizard.
It never replaces a default someone already chose, and nothing is picked silently otherwise.

Applying a version that names no profile to `local` also keeps the profile the agent row already
has (set by setup, the console or an earlier apply); the workspace default is written only to a
row with none. A version that names a profile still sets exactly that profile.

## Slice 2 acceptance

Accepted on 2026-10-03 for slice 2 of the developer-journey delivery
(the delivery plan, §8), by the implementing agent of
S2-00b (issue #521) on the Owner's delegation. Only the decisions below are accepted. Everything
else in this record remains proposed.

Accepted now:

- **SD11 — `aw dev` does not apply over an agent edited since `local` last moved**, including an
  agent made in the UI that has no `local` pointer at all. The sync stops before it writes, names
  the agent and leaves the edit in place. `aw push --yes` stays the explicit overwrite. Reason:
  the slice-1 interim exception above lets the legacy writes (`PATCH /api/agents/:id`, the agent
  screen) edit the row without creating a version, so a sync that wrote anyway would silently
  replace a content owner's edit (plan §8, SD11).
- **C21 — what counts as an edit.** `aw dev` never applies over an agent whose `updated_at` is
  later than its `local` pointer's. Replacing an agent's assignments (skills, connectors, files)
  bumps `updated_at`, so an assignment edit counts as an edit. Marking or clearing the setup agent
  does not bump it (S2-07a, S2-07b).

Declared gap: the guard checks and then writes, so a millisecond race between the check and the
write remains until V-2 makes every UI edit create a version.

Still proposed: everything slice 1 left proposed (pinned revisions, promotion and rollback,
preview URLs, evaluation of every draft, the update route creating a draft, `aw pull`, a
conversation finishing on its version, and the retention questions). A tool is pinned per
connector state, not per version, until N-1: D21 waits for N-1, as
[ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md) records
(SD1).

## Amendment — `preview` is a pointer in the same control plane (blueprint decision Q1, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q1). It changes "Environments point at versions" below and, with it,
[ADR-0103](0103-one-project-file-holds-every-environment.md)'s "Preview is a small environment in
the production cloud".

- `preview` is a third environment pointer beside `local` and `production`, in the **same** control
  plane. `AGENT_ENVIRONMENTS` gains `preview` when this is built; the pointer table, the pointer
  history and the promotion gate need no other change.
- A draft version's preview URL is the surface on that control plane with the version pinned
  (`/p/s/<name>?v=<n>`), not a workspace in a separate preview control plane.
- Moving a version to `preview` is a pointer move (`aw promote --to preview`), audited in
  `agent_pointer_moves` like the others. The automatic evaluation of a draft (ADR-0106) runs there.
- Why: one control plane keeps versions, evaluation cases and connections in one store, so nothing
  is synchronised between two deployments, and it is the model the pointer work (#612, #615, #619)
  already built.

## Amendment — no `workspace/` folder; versions and `aw push` / `aw pull` replace it (blueprint decision Q8, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q8). The workspace-as-code folder of the earlier roadmap (Phase 2,
`aw pull` / `plan` / `apply` over `workspace/`, #334) is not built. Content is versioned by this
ADR and moves between code and the platform with `aw push` and `aw pull`; infrastructure stays in
`agent-workspace.yaml` (ADR-0103). Members, invitations, shares and runtime profiles are managed
through the console, `aw` and the SDK. #334 is to be closed as superseded by this ADR.

## Amendment — eject to code keeps Agent Workspace resources (#1855, 2026-10-25)

Decided by the Owner (option (c) of #1855). Ejecting a version back into an Agent Workspace
project (`aw agents export --format ts`, #1850) must not lose what a body only names: file grants,
tools declared in the project's modules, and `mcp()` connector URLs.

- **The printer's input is `AgentVersionSource`**: the body, the parsed `agent-workspace.yaml`, the
  tools the project's modules export (`toolModulesOf()`) and the project's surfaces.
  `agentFromVersionBody()` in `@indx-workspace/sdk/define` is the inverse of `toAgentVersionBody()`
  and is pure; the caller evaluates the modules.
- **Tool sources are the project's modules.** Each name in `resources.connectors` becomes the
  module's exact tool value, so spec, `allow`, auth and `identity` survive. A name no module and no
  `connectors:` entry supplies is a drop at `definition.resources.connectors.N`.
- **MCP connectors stay in `agent-workspace.yaml`.** The converter returns the entries its `mcp()`
  tools need; the printer never writes the project file, and the CLI says which entries to add.
- **Nothing is dropped silently.** The converter runs its result back through
  `toAgentVersionBody()` and reports every differing path.
- **The portable converter is unchanged** (ADR-0133 D5). It keeps leaving Agent Workspace resources
  out when exporting to another platform.
- **Why a second converter.** Extending `PortableAgent` with grants and tool sources would put
  Agent Workspace resources into the form every other platform reads, against ADR-0133. The tool
  sources are the project's modules, which only the project has.

## Amendment — export to code, the first half of aw pull (#1842, 2026-10-25)

`aw agents export <id> --format ts` writes a saved version as `defineAgent` files, the first half of
`aw pull`. The default `--format json` is unchanged, byte for byte.

- **It writes `agents/<name>.ts` and `agents/<name>.md`** under `--out` (default: the current
  directory, which is the project root when run inside one), through the pure `printAgentProject()`.
  The version is the one the `local` pointer names, else the newest; `--agent-version <n>` names
  another (`--version` is `aw`'s own switch).
- **It never writes `agent-workspace.yaml`.** It reads the project file in `--out` for the
  `connectors:` entries the `mcp()` tools need. A connector or module tool it cannot supply is a
  refusal that names the body path (exit 1, nothing written), never a silent drop.
- **It never overwrites without `--force`.** It lists the files that exist and writes none.
- **The exported project passes `aw check`, and `aw push` saves the same body.** A test pins it.
- **`aw pull` will reuse `printAgentProject()`** to write a whole project; only the choice of
  versions and the module tools it evaluates are new.

## Context

Today an agent is one mutable row. `aw.agents.update` and the agent screen overwrite it in place,
and the change takes effect on the next run. There is no version, no diff between two states of
the agent, no preview of a change before it reaches users, and no rollback other than editing the
row back by hand. Skills have the same shape; revision-pinned skills are a roadmap proposal (N-1).

The portable form of an agent exists: `AgentDefinition` (ADR-0076, K-1) is a name-keyed document
that `aw agents export` writes and `aw agents import` recreates in another workspace. It is a
transport format, not a history.

The developer-journey hearing set the target experience around three facts:

- The person who changes an agent most often is a business owner who does not write code (D18).
- Every change must be previewable and evaluated before it reaches production (D11).
- Promotion and rollback must be one action, without redeploying the platform (D17).

An earlier draft of the journey made git the source of truth (agents as TypeScript, promotion by
merge). The hearing rejected that: version control of agents is the platform's job, and git is
one optional way in.

## Decision

### A version is an immutable snapshot of one published unit

- The **unit** is what is published: one agent, or one team (ADR-0104). A version records the
  unit's definition and **pins** the revision of every skill and tool it uses, so a production
  version can always be reproduced (D21).
- A version is immutable. Editing creates a new **draft** version; nothing edits a version in
  place.
- Versions are numbered per unit (`v1`, `v2`, …) and carry who made them, through which surface
  (`ui`, `aw push`, `api`), and a one-line summary.

### Every surface creates versions the same way

- Saving in the agent screen creates a draft version (D18, D25).
- `aw push` creates a draft version from `agents/*.ts` (ADR-0103 defines the files; D14).
- `POST /api/agents/:id/versions` is the one route both use. There is no other write path to an
  agent's definition.
- `aw pull <unit>` writes the current version back as `agents/*.ts` and `.md` (D19), so a unit
  built in the UI can move to code at any time, and back.

### Environments point at versions

- Each environment (`local`, `preview`, `production`, ADR-0103) points at one version of each unit.
- Every draft version gets a preview URL and an evaluation run automatically (ADR-0106). The
  preview is a pointer in the same control plane (amendment, decision Q1).
- **Promotion** moves an environment's pointer to a version, after approval (ADR-0102). It does not
  redeploy infrastructure.
- **Rollback** is promotion of an earlier version.
- A conversation that started on a version finishes on it. New conversations use the new pointer.

### Retention

All versions are kept (D27). They are small, and the history is the audit trail of what users saw.

### The data model stays data

The API keeps treating an agent as data (D14). Versions are added beneath the existing resource:
`aw.agents.get` returns the version the caller's environment points at, and the existing update
route becomes "create a draft and, in `local` only, point at it". The code layer (`defineAgent`,
`aw push`) is an additional client of the version route, not a replacement for the API.

## Alternatives rejected

- **Git is the source of truth** (agents as code, promotion by merge). Rejected in the hearing:
  most edits come from people who do not use git, and the platform needs versions anyway to
  preview, evaluate and roll back.
- **A deployment snapshot of a local folder** (the Vercel CLI model). Rejected because it makes
  the UI read-only for content, and content editing in the UI is the primary path.
- **Versions per resource** (agent, skill and tool each versioned independently, the agent naming
  which revision it uses). Rejected for the published unit: the combinations become hard to
  reason about. Skills and tools still have revisions (N-1); a unit's version pins them.

## Consequences

- `docs/sdk/site/concepts/target-architecture.mdx` changes: "an agent is data" stays, and
  "versions are the platform's" is added. The Time-to-promote budget becomes promotion of a
  version rather than export and import.
- `AgentDefinition` (ADR-0076) becomes the body of a version. `export` and `import` keep working,
  and gain an optional version number.
- `agents.remove` cascading through history (RF-201) becomes harder to justify, because versions
  are history. Archive becomes the only way to retire a unit.
- N-1 (skill revisions) becomes a prerequisite, because a version must pin a skill revision.
- Storage grows with every saved draft. The volume is small next to transcripts, and transcripts
  have their own retention (ADR-0106).

## Open questions

- Whether a draft that was never promoted or evaluated is kept forever, or pruned after a period.
- How a version shows a difference in a pinned skill: inline diff, or a link to the skill revision.
