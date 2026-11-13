# ADR-0164 — A recipe writes app data as the person's agent

Status: accepted
Date: 2026-11-01
Decided by: the implementing agent of U6.1a-a (issue #1527, agent portal programme, tracker #1476), on the Owner's delegation for the programme. It takes the recommendation of the unit's plan, option B for schedules
Scope: `packages/app` (`recipe.ts`: `RecipeContext.store`, `StepOptions.actingFor`, `RecipeResourceStore`; `server/recipe-runner*.ts`; `server/app-stores.ts`; `server/mcp-person.ts`, now exported; `testing/recipe-harness.ts`). No platform table, route or migration, and no app-template migration
Related: [ADR-0142](0142-tools-learn-who-is-asking.md) D2 (the subject a run asserts); [ADR-0156](0156-a-trigger-carries-a-configured-run-subject.md) (a configured subject for runs nobody asked for); [ADR-0151](0151-a-stopped-run-holds-no-lease-and-run-start-is-idempotent.md) (a step's run key); [ADR-0114](0114-the-sdk-and-the-cli-give-each-operation-one-name.md)

## Context

A recipe (F-2, issue #1513) is TypeScript the app runs over the SDK: each `step` is at most one
platform run, with the idempotency key `recipe:<recipeRunId>:<stepKey>`. The reference apps of
Phase 6 write their own data from recipe bodies:

- team-chat (#1527) stores the helper agent's answer as a reply `message`;
- crm (#1529) finds or creates a `company` and links the `contact` to it;
- service-desk (#1530) lists open `ticket`s from a schedule and escalates the breached ones.

None of them can do that from published packages. `RecipeContext` held only
`{ aw, input, step, person, recipeRunId }`. The resource stores apply the person's `access` and,
for `via: 'agent'`, the resource's `agents` rule (`agents.read`, the `agents.write` fields, and a
`runId` on every write, which the `app_audit_events` CHECK also requires). But a recipe had no
store, the `Person` an agent tool call acts as is built inside the MCP endpoint (`agentPerson`,
not exported), and a scheduled recipe (`person: null`) had no actor at all. Its runs could not
assert a subject either, so a connector that asks for identity refused them (ADR-0142 D2).

Writing app data from a recipe touches "agents never exceed the person" and "every agent write
carries `run_id`", so it is decided here before it is built.

## Decision

1. **`RecipeContext.store(resource)`** returns the resource's records bound to the recipe:
   `list`, `get`, `search`, `create`, `update` and `delete`, without a person argument. Under it
   is the same `ResourceStore` the generated routes and the agent tools use (`appStoresOf`), so a
   recipe's write publishes on bound channels and starts the recipes on it like any other write.
2. **The actor is the person's agent.** Every call acts as
   `{ principalId: <the recipe's person>, role, via: 'agent', runId }`. The role is read from the
   member directory the MCP endpoint uses (`cachedMemberDirectory`, `GET /api/memberships` with
   `AW_APP_API_KEY`, 60 s cache). The store then decides exactly as for an agent tool call: the
   person's `access` ∩ `agents.read` / `agents.write`. A recipe never does more than its person
   could do through an agent.
3. **A write needs a run.** `create`, `update` and `delete` are allowed only inside a step whose
   `aw.runs.start` has answered in this execution. They carry that run's id as `runId`, which goes
   into the audit row (`via: 'agent'`, `run_id`). Anywhere else the write is refused before the
   store is called, with the `RecipeError` code `recipe_write_needs_run`. Reads need no run.
   The write therefore sits in the step that produced it:
   `step('reply', async () => { const { result } = await aw.runs.start(…); await store(message).create({ …, body: (await result).text }); })`.
4. **A schedule acts for a named member, step by step (option B).** A recipe with no person
   (a schedule) has no actor: every `store` call is refused with `recipe_store_needs_person`.
   The exception is a step given `{ actingFor: <principal id> }`
   (`step(key, fn, { actingFor })`). Inside that step, `store` acts as that member's agent, under
   rules 2 and 3, and the step's run asserts that member as its `subject`, so an identity-scoped
   connector answers it. `actingFor` is refused with `recipe_acting_for_refused` when the
   recipe run has a person, when the id is not a principal id, or when the principal is not a
   member of the workspace.
5. **Store refusals keep their codes.** An `AppStoreError` that leaves a step fails the step,
   and so the recipe run, with its own public code (`forbidden`, `resource_not_found`, …).
   An `internal_error` (the app's database) interrupts the run instead, so `resume()` executes it
   again.
6. **The harness has the same store.** `recipeHarness` gives the recipe `memoryStoreOf` stores
   that outlive `crashAfter` and `restart`. It also takes `members` (roles by principal id; the
   harness person is a `builder` by default) and offers `storeOf(resource)` for reading the
   records and audit rows back. App recipe tests (#1529, #1530) can then run offline.

## Alternatives considered

- **(A) A schedule's store is read-only, and its writes are refused.** It is the safest choice,
  but the service-desk SLA sweep could not escalate at all, and that is a Phase 6 signature
  flow.
- **(C) An app principal with a new audit `via` (`'app'`).** It would need an app-template
  migration to widen the `app_audit_events` CHECK, and a new kind of actor that no person's
  access bounds. It would break "agents never exceed the person", and the template's migration
  numbering is kept free for U3.6b's `0003_wiki`.
- **Writes attributed to the run of an earlier step.** This would let a run-less step write, but
  a write would then carry the id of a run that did not cause it. Rule 3 keeps the run id
  truthful.
- **A recipe-level `actingFor` (a configured subject for the whole schedule, like ADR-0156's
  trigger subject).** This is simpler for a sweep, but it gives one member's authority to every
  step, including reads and writes about other people's records. A per-step `actingFor` names
  the person each write is about. The recipe-level option stays open as an upgrade.

## Consequences

- A recipe body writes app data from `@indx-workspace/app` and `@indx-workspace/app/server`
  exports only. Each write is audited as the person's agent with the run that produced it.
- **Declared gap (schedule):** with `actingFor`, the member named by the record (a ticket's
  requester or assignee) did not ask for the write. The recipe's code chose to act for them. The
  write stays within that member's own access and the resource's `agents` rule, and the audit
  row names them and the run. Upgrade: a delegated grant the member gives the recipe, when the
  platform has one.
- **Declared gap (schedule reads):** a schedule reads only inside an `actingFor` step. A sweep
  over many people's records reads as the one member it names, typically a configured
  on-call member, and sees only what that member may see.
- shortcut: a step's write and the step's completion are not one transaction. A crash after the
  write and before the step is recorded as completed repeats the write when `resume()` runs the
  step again. A crash after the step completed never repeats it, because the stored value is
  returned. Upgrade: an idempotent write keyed by the step (a `recipe_step` column on the
  record, or an outbox row), when an app needs exactly-once writes.
- shortcut: the step's run itself is still started with the app key and attributed to the
  person by `subject` (unchanged from #1513). The store's checks, not the run start, are what
  keep a recipe's writes inside the person's access.
- The role cache is the MCP endpoint's: a demoted member keeps the old role for up to 60 s.
- A recipe that writes the resource it starts on (team-chat's `message.created`) starts itself
  again on its own write. It must tell its own writes apart, for example a reply that mentions
  no agent.

## Amendment — a test clock and a schedule-slot trigger (issue #2077, 2026-11-01)

Reason: the service-desk SLA journey (#1530) cannot bring a ticket past its SLA. A schedule slot
is evaluated against the wall clock, `serveRecipes` takes no clock, `aw dev` passes the app only
allowlisted variables, and nothing starts a slot on demand. The runner already took `now`
(`recipeRunner`), so the gap is in the parts above it. Decided by the implementing agent of G3
(tracker #1476), on the Owner's delegation for the programme.

1. **An injectable clock (T1).** `recipeRunner` takes `clock: { now(): Date }` besides `now`
   (which stays); a clock wins when both are given. Every time the runner reads (schedule
   evaluation, leases, step stamps) comes from it. `serveRecipes(app, environment, { clock })`
   passes it on. With a clock, `serveRecipes` throws the `RecipeError`
   `clock_override_refused` when `NODE_ENV` is `production`, in the environment it is given or
   in the process's. No environment variable sets a clock, and neither `aw dev` nor
   `appKitEnvironment` changes.
2. **`runner.fireSlot(recipe, at)` (T2).** Starts the slot of the schedule recipe `recipe` at the
   instant `at`, exactly as the evaluation loop starts a due slot: input `{ slot: at.toISOString() }`,
   no person, dedupe key `schedule:<recipe>:<slotIso>`. So a second call with the same `at`, or the
   loop reaching that slot itself, starts nothing more. The recipe run is recorded before the call
   returns and executes in the background (`drain()` waits for it). An unknown name is refused
   with `recipe_not_found`, and a recipe that is not a schedule with `recipe_not_schedule`.
3. **`POST /api/recipes/slots` (T3).** A generated route file,
   `export const { POST } = recipeRoutes(app).slots;`, with a `.strict()` body
   `{ recipe, at }` (`recipe` matches the recipe name pattern; `at` is an ISO 8601 date-time with an
   offset). It answers `404 not_found` whenever `NODE_ENV` is `production` (`next start`, the
   image), before it reads the request. Otherwise it needs a signed-in person (`401
unauthenticated`) whose role is Owner or Admin (`403 forbidden`). It answers `400
invalid_body` for a body that does not match, `400 recipe_not_found` or `400
recipe_not_schedule`, `503 recipes_unavailable` when no runner serves the process (as the
   sibling routes do), and otherwise `202 { run }`, the recipe run of the slot. Every answer is
   `no-store` and every failure the ADR-0075 envelope. The slot's recipe run has no person,
   like any scheduled one: who fired it is not recorded as its `startedBy`, because rule 4 would
   then refuse its `actingFor` steps.
4. **`testClock()` (T4).** `@indx-workspace/app/testing` exports `testClock(start?)`:
   `{ now, set, advance }`. `recipeHarness` takes `clock` and gains `fireSlot(at?)`, which fires
   the harness recipe's slot at `at` (the clock's time when not given) and waits for it.
5. **Production schedules do not change (T5).** Without a clock and without the route, the
   runner evaluates schedules from the wall clock as before. The production image runs with
   `NODE_ENV=production`, where both are refused.

Names (ADR-0114): the route `slots`, the handler `recipeRoutes(app).slots`, the runner method
`fireSlot` and the testing helper `testClock`; the wire is `RecipeSlotRequest` and
`RecipeSlotResponse` in `recipe-wire.ts`.

Alternatives considered:

- **An environment variable that sets the app's clock under `aw dev`.** It would make every time
  the app reads move (sessions, audit stamps), and an allowlisted variable reaching production
  by mistake would move a production clock. Refused.
- **Firing a slot through the testing helper only.** The apps lane drives the app in its own
  process under `aw dev`, where a test's helper does not reach the served runner.
- **Allowing any member.** A slot of a schedule acts for its configured member (rule 4); firing
  one is an administrator's act, as configuring the schedule is.

Consequences:

- shortcut: the route trusts `NODE_ENV` to tell production from development, as Next.js does;
  upgrade to the deployment posture once the app kit reads one.
- A development app's Owner or Admin can start a schedule's slot at any instant, past or future;
  each instant runs at most once.
