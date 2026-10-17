# ADR-0114 — The SDK and the CLI give each operation one name

Status: accepted, not built yet — decided in the SDK and CLI design review (decisions S1–S6 of the SDK and CLI design document)
Date: 2026-10-04
Decided by: the product owner, choosing among the options and recommendations the design page put to them
Scope: `packages/contracts` (`routes.ts` operation ids), `packages/sdk` (method paths, `check*` twins, name arguments, `audit` and `metrics`), `packages/aw` (confirmation, name arguments, `aw ask`), `packages/cli` and `packages/create` (entry points), the docs site; extends ADR-0080, ADR-0108 (as amended by Q5) and ADR-0101

## Context

the SDK and CLI design document read the route catalogue
(`packages/contracts/src/routes.ts`, 108 routes) and every `aw` command
(`packages/aw/src/commands/*.ts`, 121 commands) on `main` at `2af294b`. It found that the names
and shapes do not line up, even though the behaviour is correct:

- **Operation ids and SDK paths differ in eight places.** The catalogue says
  `agents.listVersions`, `agents.createVersion`, `agents.setPointer`, `agents.promote`,
  `agents.rollback`, `agents.evaluate`, `agents.listFeedback` and `runs.feedback`. The SDK reaches
  the same routes as `aw.agents.versions.list`, `.versions.create`, `.pointers.set`,
  `.pointers.promote`, `.pointers.rollback`, `.evaluations.create`, `.feedback.list` and
  `aw.runs.rate`. The OpenAPI document is generated from the catalogue (ADR-0080), so a client
  generated in another language uses different names from the TypeScript SDK. The configuration
  agent, which names SDK operations (ADR-0108 as amended by Q5), would show one or the other.
- **Confirmation is uneven.** `aw push`, `aw promote`, `aw rollback`, `aw agents pointers set`,
  `aw agents versions create`, `aw eval add-case`, `aw init` and `aw deploy` show a plan and act
  only with `--yes`. `aw agents remove` deletes at once, and the delete cascades through the
  agent's history. `aw secrets remove`, `aw connectors remove` and `aw team api-keys revoke` also
  act at once.
- **Some commands take a name and some take only an id.** `aw promote support` takes a name, and
  so does `aw skills get refund-policy`. `aw agents get` needs a UUID.
- **Only observability drops a level in the CLI.** `aw.observability.audit.list()` is
  `aw audit list`, and `aw.observability.metrics.recentRuns()` is `aw metrics recent-runs`.
- **There are four entry points.** The bins are `aw`, `agent-workspace`,
  `create-agent-workspace` and `create-indx-workspace`. `aw deploy` already wraps
  `agent-workspace deploy`.

## Decision

1. **S1 — one name per operation.** A route's `operationId` equals the SDK method path that
   reaches it, and the `aw` command path is the same words, separated by spaces and in kebab
   case: `agents.versions.create` ≡ `aw.agents.versions.create(…)` ≡
   `aw agents versions create`. The eight catalogue ids above are renamed to the SDK paths. Each
   old id stays as an alias in the generated OpenAPI for one minor release, under the deprecation
   window in `03-sdk-design.md` (P-4). The reference pages and the configuration agent's `≡ aw …`
   line are generated from the same catalogue.
2. **S2 — show first, then `--yes`, for anything that cannot be undone.**
   - Every command whose effect cannot be undone shows what it would do and acts only with
     `--yes`. This covers removal, revocation, pointer moves, version saves and deploys.
   - The SDK keeps a `check*` twin for each such operation. A twin is the same request with
     `dryRun: true`, and it returns the same response with `saved: false`, as
     `versions.check`, `pointers.checkPromote` and `pointers.checkRollback` already do.
   - Agents get `archive` and `restore` (RF-201). `remove` is refused while the agent has
     versions or sessions.
3. **S3 — `aw ask`.** The terminal gets the configuration agent. It is the same agent, with the
   same typed SDK operations, as the console's assistant. It runs with the person's own `aw login`
   token, prints each operation it ran with its `≡ aw …` equivalent, and writes only draft
   (`local`) versions. It cannot widen a policy ceiling. A change outside the ceiling files a
   request to an admin instead (ADR-0102). No API is built for it (Q5). The operations come
   from the same contract the Claude Code plugin uses (ADR-0107).
4. **S4 — ids or names, in the SDK and in the CLI.**
   - Every SDK method argument that identifies a resource accepts `string | { name: string }`.
     A string is the id; `{ name }` is the resource's exact name in the workspace, for example
     `aw.agents.get({ name: 'support' })`.
   - The CLI accepts either in every `<id>` position and passes `{ name }` when the value is not
     an id.
   - The resolution happens on the server, through a name lookup on the family's list route. A
     name that matches nothing answers that family's existing `404`.
   - Skills, already addressed by name, are unchanged.
   - (The design page recommended resolving names in the CLI only. The product owner chose this
     option instead.)
5. **S5 — `audit` and `metrics` are top-level families.** The SDK exposes `aw.audit.list` /
   `listAll` and `aw.metrics.recentRuns`. `aw.observability.*` stays for one minor release,
   marked `@deprecated`. The CLI spelling (`aw audit list`, `aw metrics recent-runs`) is
   unchanged and now matches the SDK.
6. **S6 — developers type two commands.**
   - Developers type `npm create @indx-workspace` and `aw`, and the developer docs name nothing
     else.
   - `agent-workspace` remains the operator's command (start, validate, deploy), and `aw deploy`
     stays its wrapper.
   - `create-agent-workspace` and `create-indx-workspace` remain as the bins behind `npm create`
     and are not documented as entry points.

## Alternatives rejected

- **Flatten the SDK to the catalogue ids** (`aw.agents.createVersion`). Rejected: it loses the
  `versions` and `pointers` namespaces, which mirror the resource model of ADR-0101.
- **Keep the names apart and publish a mapping table.** Rejected: every reader, generator and the
  configuration agent would need the table.
- **A single `{ dryRun: true }` option instead of `check*` twins.** Rejected: the twins already
  exist, are typed, and read as intent at the call site.
- **Resolve names in the CLI only** (the recommended option for S4). Not chosen by the product
  owner.
- **Move the CLI to `aw observability …`.** Rejected: it lengthens the commands people type for
  the sake of a namespace no one asked for.
- **Fold `agent-workspace` into `aw`.** Rejected for now: operating a deployment and developing
  agents are different jobs with different credentials.

## Consequences

- `routes.ts`, the generated `openapi.json` and the reference pages change their operation ids
  for eight routes. `tests/docs/openapi.test.ts` and `pnpm docs:check` keep them in step.
- Every list route of a family that S4 covers gains a `name` filter, and the SDK's argument types
  widen to `string | { name: string }`. The contracts change only additively.
- The removal and revocation commands gain `--yes`. A script that called them without it now
  stops at the plan. This is a breaking change for the CLI, released in a minor with a notice,
  under the same deprecation window.
- `aw ask` depends on the configuration agent's operation contract (ADR-0108, Q5) and is built
  after it.
- `docs/sdk/site/concepts/target-architecture.mdx` is corrected to the real package and hook
  names (`@indx-workspace/react`, `useConversation`, `tokens.mint`) as part of this work (audit
  A10 of the design page).
