# ADR-0108 — The frontend is a four-rung ladder, and a configuration agent edits it

Status: accepted in part (slice 1: rungs 1 and 2, limited to what slice 1 renders, stored in the agent's version; slice 2: rung 2 completed without confirmation on writes, and D30 deferred; 2026-10-18: D30 reactivated by ADR-0145, not built yet; 2026-10-04: agent-centric development on the SDK, by the blueprint decisions Q3 and Q5, not built yet; 2026-10-25: the Builder (#1842, B-D1…B-D7), not built yet); the rest remains proposed — draft from the developer-journey hearing (decisions D28, D29, D30, D31, D32, D33)
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; slice 1 accepted 2026-10-02 by the planning writer of the developer-journey delivery on the Owner's delegation (see "Slice 1 acceptance"); slice 2 accepted 2026-10-03 by the implementing agent of S2-00b on the Owner's delegation (see "Slice 2 acceptance"); the rest to be confirmed when it is accepted
Scope: the surface package and `@indx-workspace/react` (ADR-0105, P-5), `apps/web` (shell branding, configuration agent), `packages/contracts` (surface schema, tool-result component props), `packages/sdk/define`

## Slice 1 acceptance

Accepted on 2026-10-02 for slice 1 of the developer-journey delivery
(the delivery plan), by the planning writer on the
Owner's delegation. Only the decisions below are accepted. Everything else in this record remains
proposed.

Accepted now, as a strict schema in `@indx-workspace/contracts/surfaces` that refuses every other
key, so that no option is accepted and ignored:

- **Rung 1 (look)**: `theme.colour` (hex), `theme.radius` (0–32), `theme.mode` (`light`, `dark`,
  `system`), `theme.density` (`compact`, `comfortable`), `theme.locale` (`en` or `ja`, the two
  locales the surface ships strings for) and `theme.logo` (`{ text }`, or `{ url }` over `https`).
- **The surface title**: `title`, the visible name in the widget's or page's header, which
  `aw init` writes from the setup question `embedder.surfaceTitle` (ADR-0107). Added on
  2026-10-02 (see "Amendment — the surface title").
- **Rung 2 (layout and parts), the rendered subset**: `layout` (`dock`, `side`, `page`, `inline`),
  and `parts.greeting`, `parts.suggestedPrompts` (at most six), `parts.disclaimer` and
  `parts.toolTrace` (`hidden`, `collapsed`).
- **Surface configuration is part of the agent's version** (ADR-0101, slice 1), beside the
  `AgentDefinition`, so a look change goes through `aw push` like any other change. Under
  `aw dev`, a saved `surfaces/*.ts` reaches the page within the one-minute look budget.

Still proposed: history, attachments, feedback, the agent switcher, `toolTrace: full`,
`toolResults` and confirmation on writes; rungs 3 and 4; control-plane white-labelling; and the
configuration agent.

## Amendment — the surface title (issue #440, 2026-10-02)

Reason: the merged setup question `embedder.surfaceTitle` (S1-01, PR #460) writes a title into
`surfaces/main.ts`, and a strict schema without `title` would refuse that file, so slice 1
accepts `title` beside rung 1 (S1-02, PR #462).

## Slice 2 acceptance

Accepted on 2026-10-03 for slice 2 of the developer-journey delivery
(the delivery plan, §8), by the implementing agent of
S2-00b (issue #521) on the Owner's delegation. Only the decisions below are accepted. Everything
else in this record remains proposed.

Accepted now:

- **SD10 — rung 2 is completed, without confirmation on writes.** `parts` gains `history`,
  `feedback`, `agentSwitcher` (one to six unique agent names) and `toolTrace: 'full'`, and the
  surface gains `toolResults` (`text`, `card` or `table` per tool name), in the same strict schema
  (S2-05a). Resuming and feedback follow ADR-0105's "Slice 2 acceptance" (SD8).
- **Confirmation on writes (D30) is deferred** (reactivated by ADR-0145; see the amendment of
  2026-10-18 below). Platform tools refuse write operations (SD4,
  [ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md)).
  MCP connectors, including those the project file now declares, run their write tools without
  confirmation, as they do today, until the run-pause work lands. `aw dev` prints
  `connectors.<name>: MCP tools that write run without confirmation (ADR-0108)` whenever it
  applies one. Reason: no run can pause today, and openai-agents refuses approvals (ADR-0065 D9).
  The run-pause mechanism is re-planned at the slice-2 close-out, next to F-3 and F-4.
- **The surface agent switcher is a visitor's choice among agents** (ADR-0105, SD8). It is not
  ADR-0104's team switcher, and it creates no team.
- **Attachments are accepted only if S2-05e finds them to be size S.** Otherwise they are declared
  here and move to slice 6. Overridden by the Owner on 2026-10-18 (issue #1306), as
  [ADR-0146](0146-attachments-are-file-store-references-on-the-grant-path.md) records: attachments
  are accepted, as file-store references, at size M to L.

Still proposed: confirmation on writes, rungs 3 and 4, control-plane white-labelling, and the
configuration agent.

## Amendment — attachments are file-store references (issue #1306, 2026-10-18)

Decided by the Owner, approving issue #1306 on 2026-10-18. Attachments (#542) are un-parked: the
parking by #611 ("no customer has asked yet") no longer holds, because six gallery use cases need
them. S2-05e (#541) found them to be size S, but with inline `contentBase64` capped at 384 KiB; that
design is dropped. They are `attachments: [{ fileId }]` references that take the file-grant path,
read-only, as [ADR-0146](0146-attachments-are-file-store-references-on-the-grant-path.md) records.
The "Still proposed" lists above are read with attachments removed.

## Amendment — development is agent-centric, and the configuration agent calls the SDK (blueprint decisions Q3 and Q5, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q3 and Q5). It refines "The configuration agent edits configuration, not files"
below.

- **Agent-centric.** The configuration agent is the primary way to develop in the console. It is
  docked on every screen, and a request in words is the first thing a person does to change an
  agent, a surface, a skill or an evaluation case. The forms and tabs remain for reading and for
  direct edits.
- **The SDK underneath everything.** The console, the configuration agent and `aw` are clients of
  the same SDK and the same `/api/**`. No operation exists only in a screen: every console action
  has an SDK method and an equivalent `aw` command.
- **Its tools are SDK methods.** The "typed operations" below are the SDK's typed client methods
  (`agents.versions.create`, `agents.evaluations.create`, `agents.pointers.checkPromote`, and so
  on), called with the caller's credential. There is no API built for the agent, and it does not
  run `aw` in a sandbox and parse its output.
- **It shows the command.** Every operation it lists pairs the SDK call with the `aw` command that
  does the same thing, so a person can repeat or script it from a terminal. The audit log records
  the SDK calls like any other client's.
- **The console has five groups.** Build (home, agents, skills, tools as the approved catalog,
  files, projects), deliver (surfaces, shared links), quality (conversations, evaluations), operate
  (releases, runs) and administer (models, members, API keys, runtimes, policy, settings).

## Amendment — D30 reactivated (ADR-0145, issue #1297, 2026-10-18)

Decided by the Owner. Slice 2 deferred confirmation on writes because "no run can pause today".
That no longer holds: [ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md)
decides that a run stops in `awaiting_approval` and continues in its session after a decision.

- **D30 is decided again.** An action that writes asks the end user to confirm before the tool runs.
  It is built on ADR-0145 D1–D3 and, as there, applies to the Claude engine only in v1.
- **It is not built yet.** The write-confirmation units (P6, #1304 and #1305) implement it. Until
  they land, the slice-2 behaviour stands: MCP connectors run their write tools without
  confirmation, and `aw dev` keeps printing
  `connectors.<name>: MCP tools that write run without confirmation (ADR-0108)`.
- The slice-2 sentence that the run-pause mechanism "is re-planned at the slice-2 close-out" is met
  by ADR-0145.

## Amendment — the configuration agent builds agents: the Builder (#1842, 2026-10-25)

The Agent Builder design (v1.2, tracker #1842) extends the configuration
agent so that it creates agents, not only front-end configuration. This amends this ADR; it does
not add a competing one. Decisions, with the Owner's defaults from #1843:

- **B-D1.** The Builder **is** the configuration agent. It is an ordinary built-in agent whose
  only tool is the reserved `aw-control` tool server.
- **B-D2.** A new run-token principal, `run-caller`, is accepted **only** by the `aw-control`
  route. It carries the run's `caller` (`caller.sub`, `principalKind`, already in the token:
  `packages/gateway/src/tokens/run-token.ts`, ADR-0142 D2). Each tool call is authorised as that
  person, with that person's role. With no caller, write tools are refused.
- **B-D3.** Drafts only: a save moves the `local` pointer, never `production`. The Builder never
  promotes, rolls back, deletes, changes policy or reads credentials.
- **B-D4.** Never wider than the creator: no saved definition may be wider than the person's role
  allows, nor (for agent creators, B3) than the creating agent's own permissions, tools, files and
  limits.
- **B-D5.** The tool layer is a pure core with ports (hexagonal). It lives in
  `apps/web/server/builder/`, and dependency-cruiser enforces the rule.
- **B-D6.** Wire tool names use underscores (`catalog_list`, `examples_get`, `draft_check`,
  `draft_save`, `evals_run`, `trial_run`), because model APIs accept only `[a-zA-Z0-9_-]{1,64}`.
  The dotted names stay as display names; one table in `packages/contracts` maps one to the other.
- **B-D7.** Every phase sits behind the `builder` workspace feature.

Facts on main that the design (v1.2) and the later issues must not assume away:

- There is no built-in agent mechanism; the seeded "General" is an ordinary row (#1848 builds the
  smallest mechanism).
- There is no per-workspace feature switch yet (#1493, #1494, #1496). The Builder registers one
  feature id and builds no second switch (#1846).
- The version, pointer and evaluation routes have no idempotency key. Only run start has one. The
  Builder's tool-call journal provides safe retries (#1845, #1847).
- There is no project printer and no `aw agents new` (#1850).
- Agents have no archived state (#1851 adds it for auto-archive).
- Run limits are only `maxTurns` and `maxBudgetUsd`; the Builder core enforces its other limits
  from its journal.

## Context

The target customer is an engineer who wants to customize agents deeply and keep them in-house,
in a company of any size (D32, D33). Their
alternatives each leave them stuck:

- A large vendor's no-code platform is fast to start, but its screens and agent structure cannot
  be shaped far enough.
- A systems integrator builds anything, but slowly, and the result is hard to change.
- A SaaS product cannot handle the small details of their own business.

How the frontend can be changed decides most of that comparison.

Today the frontend is fixed:

- The control plane (`apps/web`, Next.js 16, React 19, Tailwind 4) takes its colours from
  `app/globals.css`, with the accent colour written in directly.
- The product name and the navigation in `components/shell` are constant.
- The only end-user page is the read-only share page at `/p/[token]`.
- Embedding means building the whole chat on `@indx-workspace/sdk/events`.
- Tool results reach the UI only as events. Nothing renders them as components.
- There is no React package (P-5).

## Decision

### One ladder for every end-user surface

Each rung is reachable without the rung above it:

1. **Look**: colour, radius, light or dark, density, locale and logo. Set in `surfaces/*.ts` under
   `theme`, or by a content owner in the UI or through the configuration agent.
2. **Layout and parts**: `dock`, `side`, `page` or `inline`, and which parts are shown — history,
   attachments, the tool trace (`hidden`, `collapsed` or `full`), feedback, suggested prompts, the
   disclaimer and the agent switcher. Also set in the UI or through the agent.
3. **Replace parts**: `slots` (header, empty state, composer and so on) and `toolResults`
   components are the customer's own React components. Their props types are generated from the
   contracts, including each tool's output schema, so an upgrade cannot silently break them.
   Engineers only.
4. **Headless**: `@indx-workspace/react` hooks (`useConversation`, `ToolResult`). Reconnection,
   version pinning, confirmation and permissions stay inside the hooks. Engineers only.

Surface configuration is part of the unit's version (ADR-0101). A look or layout change is
previewed, evaluated and promoted like any other change.

### Tool results are components

- For each tool, a surface maps the result to plain text, a built-in component (a summary card, a
  table, a form, or a confirm action), or a custom component from rung 3 (D30).
- An action that writes (for example `create_return`) always asks the end user to confirm before
  the tool runs, whatever the component.

### The control plane can be white-labelled

`branding` in `agent-workspace.yaml` sets the name, logo, colour and the menus shown to content
owners (D28). The shell reads them from configuration instead of from constants.

### The configuration agent edits configuration, not files

- The setup conversation and an assistant available on every screen are the same agent (D31).
- Its tools are typed operations on configuration: `config.set`, `surface.set`, `agents.scaffold`,
  `skills.add`, `catalog.request` and so on. (Amended by decision Q5: these are SDK client methods,
  each shown with its `aw` equivalent.)
- Every turn shows the operations it ran, the file diff and a preview. The result lands in a draft
  version, never directly in production.
- It acts with the caller's role. It cannot widen a policy ceiling (ADR-0102). Asking it to change
  a model or a budget files a request to an admin instead.
- The operations are a contract, so `aw init`, the Claude Code plugin and the browser drive the
  same operations (ADR-0107).

## Alternatives rejected

- **Theme and colour only** (the first draft of this journey). Rejected: it reproduces the
  rigidity customers leave other products for.
- **Components only, no configuration**. Rejected: content owners could not change anything
  without an engineer.
- **A chat that writes files directly**. Rejected: typed operations can be validated, previewed,
  audited and limited by role, and free-form edits to files cannot.

## Consequences

- The tool output schemas become part of the public contract, because component props are
  generated from them.
- The shell's constants move to configuration. `UNIDENTIFIED_WORKSPACE` and the brand row read
  `branding`.
- The configuration agent needs a model connection and a budget, by default `models.default`
  (an open question on the journey page).
