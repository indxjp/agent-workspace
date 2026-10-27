# 3. SDK design

## 3.1 Principles

1. **Contracts first.** The wire is the product's stable surface; the SDK is a convenience over
   it. Anything the SDK knows about a response, it knows from a schema in
   `@indx-workspace/contracts`, and that schema is the same one the application's serializers
   are tested against. A consumer who cannot use our client (another language, a strict
   dependency policy) can still use the contracts.
2. **The application is the first consumer.** Every contract is adopted by `apps/web` before it
   is offered to a customer, through a conformance test that pins the server's real output to
   the schema. A contract nobody consumes is a guess.
3. **Validate on the way in, everywhere.** A response is `unknown` until the schema accepts it
   (`ENGINEERING_GUIDELINES.md`, "Types and runtime boundaries"). Drift is a named failure, not a
   half-read object.
4. **Three failures, typed.** Every SDK call ends in a value the contract accepted or one of
   `ApiProblemError` (the server refused, with `status` and stable `code`),
   `ContractViolationError` (the server answered something the contract does not describe), or
   `TransportError` (no answer; `aborted` says whether the caller asked for that).
5. **Isomorphic by construction.** Web platform APIs only — `fetch`, `Headers`, `URL`,
   `AbortSignal`, `ReadableStream`, `TextDecoder`. No `node:` import, no `@types/node`; the
   package's `tsconfig` says `lib: ["ES2023", "DOM", "DOM.Iterable"]` and that is the whole
   environment it may assume.
6. **No speculative layers.** No generic repository, no plugin system, no retry framework. One
   transport, one resource client per domain, one follower for the one streaming endpoint.

## 3.2 Package structure and layering

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  consumers: apps/web (browser + server), customer backend, customer UI   │
└───────────────┬──────────────────────────────────────┬───────────────────┘
                │                                      │
     ┌──────────▼───────────┐                ┌─────────▼──────────┐
     │  @indx-workspace/sdk │ ──depends on──►│ @agent-workspace/  │
     │  .        createClient│                │ contracts          │
     │  ./events SSE parser  │                │ .          problem,│
     │           follower    │                │            ids     │
     └──────────┬───────────┘                │ ./agents ./runs …  │
                │ zod (peer of contracts)     └─────────┬──────────┘
                ▼                                       │ zod only
             nothing else in the workspace ◄────────────┘
```

### `@indx-workspace/contracts`

| Subpath         | Holds                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`             | `UuidSchema`, `IsoDateTimeSchema`, `isUuid`; `ApiProblemSchema`, `COMMON_PROBLEM_CODES`.                                                                                                                 |
| `./agents`      | `AgentResourceSchema`, `AgentPermissionsSchema`, `AgentResourceAssignmentsSchema`, list/assignment envelopes, input types, bounds.                                                                       |
| `./runs`        | `RUN_STATUSES`, `MODEL_PROVIDERS`, `ACCOUNTING_STATES`, `RunResourceSchema`, `StartRunRequestSchema`, `StartRunResponseSchema`, `RunListResponseSchema`, `RunListQuery` + `runListSearchParams`, bounds. |
| `./run-events`  | `CONTROL_FRAME_NAMES`, `RUN_STATUS_EVENT`, `RELAYED_EVENT_NAMES`, `EVENT_NAME_PATTERN`, per-frame `data` schemas.                                                                                        |
| `./sessions`    | `SessionResourceSchema`, list/item envelopes, `UpdateSessionPatch`.                                                                                                                                      |
| `./projects`    | `ProjectResourceSchema`, list envelope, `ProjectSessionResponseSchema`, input types, `PROJECT_LIST_FILTERS`.                                                                                             |
| `./workspaces`  | `WorkspaceResourceSchema`, `WorkspaceMembershipViewSchema`, envelopes, input types.                                                                                                                      |
| `./team`        | `MEMBERSHIP_ROLES`, `MembershipResourceSchema`, list envelope.                                                                                                                                           |
| `./invitations` | `InvitationResourceSchema`, `IssuedInvitationResponseSchema`, list envelope.                                                                                                                             |

Rules the package follows and the gates enforce:

- One subpath per domain; no root barrel of everything (guidelines: "avoid barrels that export
  unrelated implementations"). `check-package-exports.mjs` rejects wildcard exports and requires
  every subpath to be listed in `tsconfig.architecture.json`.
- Owned schemas are `.strict()`: an unknown key in a response is drift and is refused. The one
  `looseObject` is `RelayedEventDataSchema`, because the Claude Agent SDK's message union grows in
  patch releases and the platform passes it through deliberately.
- Types are derived (`z.infer`) except for **input** shapes (`CreateAgentInput`, `ProjectPatchInput`,
  …), which remain interfaces because the server's hand-written parsers own their field-specific
  error messages; a client-side schema would be a second, competing validator.
- Dates are ISO-8601 strings on the wire (`z.iso.datetime()`); `bigint` never appears; the run
  cost is a decimal string.
- `dependency-cruiser`: `contracts-depend-on-nothing-in-the-workspace`.

### `@indx-workspace/sdk`

| Module                 | Responsibility                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.ts`              | `HttpClient`: URL joining (base path prefix safe), auth header or `credentials: 'include'`, JSON encoding, status expectation, problem/contract/transport classification, `AbortSignal` + timeout. |
| `errors.ts`            | `AgentWorkspaceError` and the three subclasses.                                                                                                                                                    |
| `events/sse.ts`        | `splitSseFrames`, `parseSseFrame`, `readSseFrames(body, signal)` — the consumer side of HTML §9.2 for a stream in which every frame is named.                                                      |
| `events/run-events.ts` | `classifyRunEventFrame`: `done` / `run-failed` / `stream-reset` / `run-status` (validated) / `runtime` (passed through).                                                                           |
| `resources/*.ts`       | One class per domain, methods named by intent, every method takes `{ signal }`.                                                                                                                    |
| `index.ts`             | `createClient(options): AgentWorkspaceClient` and the public types.                                                                                                                                |

`dependency-cruiser`: `sdk-depends-only-on-contracts`. The SDK never imports `core`, `runtime` or
`gateway` — those are server implementations.

## 3.3 Build, test, publish

| Concern         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language/target | TypeScript, `module: NodeNext`, ES2023, the repository's strict options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, …). Relative imports carry `.js`.                                                                                                                                                                                                                                                                                                                                                   |
| Build           | `tsc -p tsconfig.build.json` → `dist/` with `.d.ts`, declaration maps and source maps. Same two-config layout as every other package (ADR W0-INF-01). The SDK builds `src/testing.ts` too: it ships as `./testing` (P-2).                                                                                                                                                                                                                                                                                                                                      |
| Exports         | `types` → `src/*.ts`, `default` → `dist/*.js`, so type-checking never needs a build and runtime always gets JavaScript (the pattern `packages/core` set; enforced by `check-package-exports.mjs`). The published manifest swaps `types` to `dist/*.d.ts` through `publishConfig`, which `pnpm pack` applies.                                                                                                                                                                                                                                                                                                                                                           |
| Test            | Vitest, no network: a recording `fetch` double (`packages/sdk/src/testing.ts`) and in-memory `ReadableStream`s. `vitest.config.ts` aliases both packages to `src/` so package suites run unbuilt; the web suites resolve `dist/`, which `pnpm test` now builds first (`scripts/test-with-services.mjs`).                                                                                                                                                                                                                                                     |
| Lint/format     | The repository's type-aware ESLint and Prettier; complexity ceiling 32; no suppressions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Dead code       | Knip: entry files are the declared subpaths; every other export must be used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Runtime deps    | `zod@4.6.4` pinned exactly, as everywhere in the repository; the SDK depends on `contracts` at `workspace:*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Publishing      | **Published (issue #246, ADR-0082).** `@indx-workspace/contracts`, `@indx-workspace/sdk` and `@indx-workspace/aw` — the workspace names are the npm names; the `@agent-workspace` scope on npm belongs to a third party. `files` ships `dist/` (no source maps) and the manifests; `publishConfig` points `types` at `dist/`; `pnpm pack` turns `workspace:*` into the exact sibling version. All three carry `CONTRACTS_VERSION`. `.github/workflows/publish-packages.yml` publishes them, contracts first, from a `packages-v<version>` tag with npm trusted publishing (GitHub OIDC, no token), with provenance switched off while the repository is internal, after `scripts/release/pack-packages.mjs --smoke` has verified each tarball and installed all three into an empty project. |
| Versioning      | Additive changes (a new optional response field would fail `.strict()` — so **additive response fields are minor bumps of both packages, released together**; a client on the old contracts refuses the new field by design). Removals and renames happen only in a major release, `0.x` included. A customer pins the contracts version to the control-plane release they deploy against. **Deprecation window (P-4):** a route or field is first deprecated in a minor — `@deprecated` in the contracts, a note in the reference and the package `CHANGELOG.md` — and removed in the next major, no earlier than one minor after the deprecating release; the deprecating release stops depending on it (the SDK moves to the replacement, and a to-be-removed response field becomes `.optional()`). **Served range:** the server serves its current minor and the previous minor of the same major; at `X.0` it serves the previous major's last minor instead, for that one minor (`minimumServedContractsVersion`, `apps/web/server/versioning/contracts-version.ts`). It refuses a client that declares a version outside that range with `426` before doing anything else; a request without the header is always served at the current version (S-7, ADR-0078). The renames of units 3 and 9 comply: unit 3's run-control renames keep their old paths until the next major, and unit 9's move of runtime detection (S-9) is specified the same way. |

## 3.4 Public API and usage patterns

### A customer backend starts a run and waits

```ts
import { createClient, ApiProblemError } from '@indx-workspace/sdk';

const aw = createClient({
  baseUrl: 'https://agents.example.com',
  auth: { kind: 'api-key', apiKey: process.env.AGENT_WORKSPACE_API_KEY },
  timeoutMs: 15_000,
});

try {
  const { run } = await aw.runs.start(agentId, { prompt: 'Triage the overnight alerts.' });
  const settled = await aw.runs.waitForOutcome(run.id);
  console.log(settled.status, settled.usage.totalTokens, settled.cost.amount);
} catch (error) {
  if (error instanceof ApiProblemError && error.code === 'session_not_usable') {
    // start a fresh session instead
  }
  throw error;
}
```

### A frontend renders a live run and survives a reconnect

```ts
import { createClient } from '@indx-workspace/sdk';

const aw = createClient({ baseUrl: window.location.origin, auth: { kind: 'session' } });
const controller = new AbortController();

for await (const frame of aw.runs.follow(runId, { signal: controller.signal })) {
  switch (frame.kind) {
    case 'run-status':
      setStatus(frame.data.status);
      break;
    case 'runtime':
      appendEvent(frame.name, frame.data); // the Claude Agent SDK message, verbatim
      break;
    case 'stream-reset':
      clearTranscript(frame.data.reason);
      break;
    case 'run-failed':
      showFailure(frame.data.message);
      break;
  }
}
```

`follow` reconnects with `Last-Event-ID` when a connection drops before `done`; a `stream-reset`
means the server could not serve that cursor and the client must discard what it rendered. `done`
says the stream is over and nothing about whether the run succeeded — `run-failed` says that, and
`runs.get` has the settled record.

### A project-attributed session

```ts
const { id: sessionId } = await aw.projects.startSession(projectId);
const { run } = await aw.runs.start(agentId, { prompt, sessionId });
```

### Paging history

```ts
let cursor: string | null = null;
do {
  const page = await aw.runs.list({
    status: 'failed',
    from: since,
    limit: 100,
    cursor: cursor ?? undefined,
  });
  record(page.runs);
  cursor = page.nextCursor;
} while (cursor !== null);
```

### Using only the contracts

```ts
import { RunResourceSchema } from '@indx-workspace/contracts/runs';

const run = RunResourceSchema.parse(await response.json());
```

## 3.5 Feature mapping

| Existing feature (domain)                                       | Contract module                            | SDK client                                                      | Application module that now consumes it                                                                      |
| --------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Workspaces, switching                                           | `contracts/workspaces`                     | `workspaces.list/get/create/update`                             | conformance only (serializer is not exported; see gaps)                                                      |
| Agents, permissions, resource assignment                        | `contracts/agents`                         | `agents.*`                                                      | `apps/web/contracts/agents.ts` (re-export), `server/agents/contract.ts`, `sdk-conformance.test.ts`           |
| Runs: start, read, list                                         | `contracts/runs`                           | `runs.start/get/list`                                           | `sdk-conformance.test.ts` (`renderRun`, `parseStartRunBody`, enums, bounds)                                  |
| Run event stream                                                | `contracts/run-events`                     | `runs.events/follow/waitForOutcome`, `sdk/events`               | `components/run/live.ts` (parser), `sdk-conformance.test.ts` (`sseFrame`, `sseControlFrame`, reserved names) |
| Sessions, transcripts                                           | `contracts/sessions`                       | `sessions.list/get/update`, `sessions.transcript.read/subkeys`  | `sdk-conformance.test.ts` (`serializeSession`, transcript and subkeys handlers)                              |
| Projects, archive, project sessions                             | `contracts/projects`                       | `projects.*`                                                    | `apps/web/contracts/projects.ts` (re-export), `sdk-conformance.test.ts` (`toProjectResource`)                |
| Team (memberships, users, API keys)                             | `contracts/team`, `contracts/api-keys`     | `team.members/users/apiKeys.*`                                  | `apps/web/contracts/team.ts` (re-export), `sdk-conformance.test.ts` (real rbac handlers)                     |
| Invitations                                                     | `contracts/invitations`                    | `team.invitations.*`                                            | `apps/web/contracts/invitations.ts` (re-export), `sdk-conformance.test.ts`                                   |
| Error envelopes (standard, RBAC `detail`, bare code)            | `contracts` (`ApiProblem*Schema`)          | `ApiProblemError` (reads all three)                             | `sdk-conformance.test.ts` (`problem()`, rbac `problem()`, `errorResponse()`)                                 |
| Files (path headers, raw upload, download, subtree move/delete) | `contracts/files`                          | `files.*`                                                       | `apps/web/contracts/files.ts` (re-export of the header helpers), `sdk-conformance.test.ts`                   |
| Skills                                                          | `contracts/skills`                         | `skills.*`                                                      | `sdk-conformance.test.ts`; the `aw` CLI                                                                      |
| Connectors                                                      | `contracts/connectors`                     | `connectors.*`                                                  | `sdk-conformance.test.ts`; the `aw` CLI                                                                      |
| Model connections, discovery                                    | `contracts/models`                         | `models.connections.*`, `models.discover`                       | `sdk-conformance.test.ts`; the `aw` CLI                                                                      |
| Runtime profiles and connections                                | `contracts/runtimes`                       | `runtimes.profiles/connections.*`                               | `apps/web/contracts/runtimes.ts` (re-export), `sdk-conformance.test.ts`                                      |
| Secrets                                                         | `contracts/secrets`                        | `secrets.*`                                                     | `sdk-conformance.test.ts`; the `aw` CLI                                                                      |
| Shares, sharing policy                                          | `contracts/shares`, `contracts/workspaces` | `shares.*`, `workspaces.sharingPolicy.*`                        | `sdk-conformance.test.ts`; the `aw` CLI                                                                      |
| Metrics, audit                                                  | `contracts/observability`                  | `observability.metrics/audit.*`                                 | `sdk-conformance.test.ts`; the `aw` CLI                                                                      |
| Neutral event view                                              | —                                          | `sdk/events` `toAgentEvent`, `assistantResponseFromAgentEvent`  | `components/run/model.ts` (re-export), `home-chat.tsx`; the `aw` CLI                                         |

## 3.6 Migration

Incremental, one domain per change, each gated the same way. The order follows the value to a
customer and the stability of the server side (domains with an open RF item wait for it).

| Step | Domain                      | Precondition                                                  | Change                                                                                                                                                            | Gate                                                               |
| ---- | --------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 0    | Foundation (this change)    | —                                                             | Packages, contracts for the run loop, client, conformance test, `apps/web/contracts/*` re-exports, SSE parser reuse.                                              | `pnpm check:fast`, `pnpm test`, `pnpm build`                       |
| 1    | Runs (browser)              | 0                                                             | `components/run/live.ts` `startAgentRun*` and `followRunEvents` call `@indx-workspace/sdk` (`auth: session`); `history.ts` parses with `RunListResponseSchema`.  | existing `live.test.ts`/`history.test.ts` unchanged; browser smoke |
| 2    | Runs (server)               | 0                                                             | `server/runs/api.ts` `renderRun` returns `RunResource` (typed by the contract) and `parseStartRunBody` delegates to `StartRunRequestSchema` where messages allow. | `sdk-conformance.test.ts` extended per field                       |
| 3    | Sessions                    | export the serializer                                         | `server/sessions/api.ts` serializes through a named function pinned by conformance; browser session list uses the SDK.                                            | conformance                                                        |
| 4    | Workspaces                  | RF-401 application port for workspaces (or a narrower export) | Serializer pinned by conformance; shell workspace switcher uses `workspaces.list`.                                                                                | conformance, `tests/browser` workspace switch                      |
| 5    | Files, skills, connectors   | RF-304 (storage ops)                                          | Contracts + clients; files use raw bodies with the header helpers from `apps/web/contracts/files.ts`.                                                             | conformance per domain; connector item routes enforce ownership    |
| 6    | Models, runtimes, secrets   | RF-204 (typed credential ownership)                           | Contracts + clients; credential fields never appear in a response schema.                                                                                         | conformance; secret-scan of every response body in tests           |
| 7    | Team, invitations, API keys | RF-202/RF-203                                                 | Clients for the contracts that already exist; API-key minting (plaintext once).                                                                                   | conformance; the "plaintext appears in exactly one body" test      |
| 8    | Shares, metrics, audit      | RF-103 (options-only publish)                                 | Contracts + clients.                                                                                                                                              | conformance                                                        |
| 9    | Browser token for customers | product decision (02 §2.4)                                    | Control-plane endpoint + SDK `auth: { kind: 'browser-token' }`.                                                                                                   | new authorization matrix                                           |
| 10   | Publish                     | scope ownership, provenance, ADR                              | `private: false`, `files`, `publishConfig`, changelog, generated API reference.                                                                                   | release evidence                                                   |

Rules that hold at every step:

- The application never keeps a second copy of a contract the package publishes; it re-exports
  (`apps/web/contracts/*.ts`) until the last importer moves, then the re-export is deleted.
- A domain is consumed through the SDK only after `apps/web/server/sdk-conformance.test.ts`
  proves its serializer satisfies the schema — the test is the migration's definition of done.
- Behaviour-preserving: no route changes its status, envelope or codes to suit the SDK. Where the
  wire is irregular (bare item vs `{ run }`), the contract says so and the client hides it.
- The Claude Agent SDK boundary is untouched: nothing new imports `@anthropic-ai/claude-agent-sdk`.

## 3.7 Non-goals

- A cache layer. The React binding is a separate package, `@indx-workspace/react` (`<Chat/>` and
  `useConversation()`, issue #623), not part of `@indx-workspace/sdk`.
- A server-side "SDK" for writing routes; the application's HTTP adapters stay in `apps/web`.
- Re-exporting `packages/core` schemas (`RunRequest`, `RuntimeProfile`): those are the control
  plane ↔ runner protocol, not a customer surface.
- OpenAPI as the source of truth. The Zod schemas are; the OpenAPI 3.1 document is generated from
  them (issue #245, [ADR-0080](../adr/0080-the-openapi-document-is-generated-from-a-route-catalogue-in-the-contracts.md)).
  The emitter is `scripts/docs/generate-openapi.mjs`, run by `pnpm docs:generate` and checked by
  `pnpm docs:check`; it writes `docs/sdk/site/openapi.json`. The mapping rule: every entry of
  `API_ROUTES` in `packages/contracts/src/routes.ts` is one operation — its `METHOD` and `:param`
  path (as `{param}`), its `operationId` (the SDK operation name), its `tag` (the SDK family), a
  request body and one response per success status from the named `API_SCHEMAS` entries, and the
  standard error envelope as `default` plus `400` (`contracts_version_malformed` among its codes)
  and `426 contracts_version_unsupported` (ADR-0078; the header names and statuses are imported
  from the contracts). A route whose credential is not the default names it in `security`. A
  declared route that is neither catalogued nor one of `API_ROUTE_EXCLUSIONS` fails
  `tests/docs/openapi.test.ts`; the exclusions are browser journeys (04 §1) and private runner
  routes (the transcript writes and the ENG-06 state routes, called only by `apps/runner` with the
  per-run token).

## 3.8 Declared gaps in the foundation

- Workspaces have a contract and a client but no application-side conformance test, because the
  serializer is module-private today (step 4 exports it). Sessions closed theirs in this phase.
- `runs.follow` reconnects on a dropped connection — a body that ends or errors before `done`,
  which `events` classifies as a non-aborted `TransportError` — and on nothing else: a problem
  response, a contract violation (a `200` that is not an event stream included) and an abort are
  rethrown. It does not back off exponentially or observe `retry:` — the server pins 3 s and the
  default matches it.
- `timeoutMs` covers response headers only, by construction: the deadline is an `AbortController`
  disarmed the moment `fetch` resolves, so it can never sever an open stream. A JSON body that
  stalls after its headers is bounded only by the caller's `signal`.
- The CLI signs a person in with a device flow, so the eight commands whose routes refuse an API-key principal
  (`workspaces list|get|create|update`, `team invitations *`) run after `aw login` (issue #242, ADR-0083).
- The events URL is derived from the run id rather than from the `events` field of the `202`;
  the two are equal by the route's own contract (`Location` header) and the SDK does not yet
  assert it.
- `apps/web` still builds `dist/` of both packages before its own tests (`quality.yml`,
  `test-with-services.mjs`); a `development` export condition resolving to `src/` would remove
  that step and is a candidate for the next infrastructure change.
