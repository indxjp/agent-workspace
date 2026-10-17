# 2. Use cases and documentation

## 2.1 Who consumes the SDK

Three consumers, in the order the migration serves them:

| Consumer                    | Runs where                               | Authenticates with                                                                      | Wants                                                                                                       |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Our own web application** | Browser (same origin) and Next.js server | Session cookie (`auth: { kind: 'session' }`)                                            | One typed client instead of per-feature `fetch`+cast; one SSE parser; contracts it no longer has to own.    |
| **A customer's backend**    | Node/Deno/Bun service, worker, cron      | Workspace API key (`auth: { kind: 'api-key' }`)                                         | Start runs, wait for outcomes, read history, manage agents and projects programmatically.                   |
| **A customer's frontend**   | Browser on the customer's origin         | A token their backend obtains — today an API key must **not** reach a browser; see §2.4 | Render a live run, resume after reconnect, list sessions and runs, without re-implementing the wire format. |

## 2.2 Use cases the SDK must support

Marked **F** where the SDK covers it today, **R** where it is roadmap.

### Execution (the run loop) — the reason the SDK exists

| #   | Use case                                                                                                                       | API surface                                                                                    | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------ |
| E1  | Start a run for an agent with a prompt; optionally continue a session; optionally override the model.                          | `runs.start(agentId, { prompt, sessionId?, modelOverride? })`                                  | F      |
| E2  | Stream the run's events as they happen, with typed platform frames and pass-through runtime events.                            | `runs.events(runId)` — one connection, ends on `done`                                          | F      |
| E3  | Survive a dropped connection: resume from the last durable id, surface `stream-reset`.                                         | `runs.follow(runId, { maxReconnects, reconnectDelayMs })` sends `Last-Event-ID`                | F      |
| E4  | Fire-and-wait from a backend: start, block until the stream ends, read the settled record.                                     | `runs.waitForOutcome(runId)`                                                                   | F      |
| E5  | Read one run (status, usage, cost, accounting state).                                                                          | `runs.get(runId)`                                                                              | F      |
| E6  | Page through workspace run history with filters (status, agent, project, provider, model, date range; `user` for Owner/Admin). | `runs.list(query)` → `{ runs, nextCursor }`                                                    | F      |
| E7  | Start a run inside a project so attribution is set before the first run.                                                       | `projects.startSession(projectId)` then `runs.start(…, { sessionId })`                         | F      |
| E8  | Extract the assistant's visible text from relayed events (what a chat UI shows); the neutral event view.                       | `@indx-workspace/sdk/events` `toAgentEvent`, `assistantResponseFromAgentEvent` | F      |
| E9  | Interrupt a running run.                                                                                                       | not exposed over HTTP today (`interrupt` is runner-private)                                    | R      |
| E10 | Revoke a run's gateway tokens (Owner/Admin).                                                                                   | `POST /api/runs/:id`                                                                           | R      |

### Sessions and transcripts

| #   | Use case                                                                        | API surface                                                                                            | Status |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| S1  | List sessions the caller may see, active or archived; know which are resumable. | `sessions.list({ status?, limit?, cursor? })`, `sessions.listAll`                                      | F      |
| S2  | Read, rename, archive, restore a session.                                       | `sessions.get`, `sessions.update`                                                                      | F      |
| S3  | Read a transcript for display or export.                                        | `sessions.transcript.read(providerSessionId, { projectKey, subpath? })`, `sessions.transcript.subkeys` | F      |

### Agents, projects, resources

| #   | Use case                                                                 | API surface                                                                                             | Status |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------ |
| A1  | CRUD agents with explicit permissions; assign files, skills, connectors. | `agents.*`, `agents.getResourceAssignments`, `agents.replaceResourceAssignments`                        | F      |
| A2  | CRUD projects; archive/restore; project defaults for agent and model.    | `projects.*`                                                                                            | F      |
| A3  | Upload/list/move/delete files and folders (raw bodies, path headers).    | `files.list/upload/createFolder/download/move/remove`                                                   | F      |
| A4  | Create and edit skills (SDK-native skill documents).                     | `skills.list/import/get/export/update/remove`                                                           | F      |
| A5  | Register MCP connectors with credentials; test a connection.             | `connectors.list/get/create/update/remove/rotateCredential/test/testDraft`                              | F      |
| A6  | Manage model connections and pick models; runtime profiles; secrets.     | `models.connections.*`, `models.discover`, `runtimes.profiles.*`, `runtimes.connections.*`, `secrets.*` | F      |

### Tenancy and administration

| #   | Use case                                                            | API surface                                                                  | Status                       |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| T1  | Discover the workspaces the caller belongs to and the role in each. | `workspaces.list`, `workspaces.get`                                          | F                            |
| T2  | Create, rename, archive a workspace.                                | `workspaces.create`, `workspaces.update`                                     | F                            |
| T3  | Manage members, users and invitations.                              | `team.members.*`, `team.users.*`, `team.invitations.*`                       | F (accept is browser-only)   |
| T4  | Mint and revoke API keys programmatically.                          | `team.apiKeys.list/create/revoke`                                            | F                            |
| T5  | Read workspace metrics and the audit log.                           | `observability.metrics.recentRuns`, `observability.audit.list`               | F                            |
| T6  | Publish and revoke shares; read sharing policy.                     | `shares.list/revoke`, `workspaces.sharingPolicy.get/set` F; `shares.publish` | R (publish waits for RF-103) |

### Cross-cutting

| #   | Use case                                                                                | Status                               |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| X1  | Branch on a stable problem code, never on prose; know the status; honour `Retry-After`. | F (`ApiProblemError`)                |
| X2  | Detect server/client contract drift as a distinct failure.                              | F (`ContractViolationError`)         |
| X3  | Cancel any call with an `AbortSignal`; bound connection time with a timeout.            | F                                    |
| X4  | Inject `fetch` (tests, proxies, edge runtimes) and per-request headers (trace ids).     | F                                    |
| X5  | Use the same package from a browser bundle and from Node without conditional code.      | F (Web platform APIs only)           |
| X6  | Obtain a short-lived browser token from a customer backend (no API key in a browser).   | R — needs a server feature, see §2.4 |

## 2.3 Documentation needed

| Document                                                                                                             | Audience           | Exists?                                                                                   | Needed by                  |
| -------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- | -------------------------- |
| SDK design and package layout                                                                                        | Us                 | This directory                                                                            | now                        |
| `packages/contracts/README.md`, `packages/sdk/README.md` — install, authenticate, first run, streaming, errors       | Customer engineers | Yes, minimal, in this change                                                              | first external consumer    |
| API reference generated from the contracts (per route: method, path, request schema, response schema, problem codes) | Customer engineers | No. The schemas exist; a renderer (`zod-to-json-schema` → Markdown/OpenAPI) does not.     | before publishing          |
| Authentication guide: API keys (minting, rotation, scope), session cookies, the browser-token pattern                | Customer engineers | No (spec §22 is two sentences)                                                            | before a customer frontend |
| Event-stream guide: frame kinds, resume semantics, `done` vs `run-failed`, retention                                 | Customer engineers | Partly, as comments in `server/runs/sse.ts` and research note R-13 (SSE)               | before a customer frontend |
| Contract changelog and versioning policy (what is additive, what is breaking, how a client detects it)               | Everyone           | No                                                                                        | before publishing          |
| Migration guide for our own app (which module consumes what, per domain)                                             | Us                 | [03 §3.6](03-sdk-design.md#36-migration)                                                  | now                        |
| Publishing runbook (scope ownership, provenance, `files`, `private: false`)                                          | Release owner      | Yes; `docs/release/README.md` § npm packages and ADR-0082                                  | before publishing          |

## 2.4 Two product decisions the SDK surfaces

Neither blocks the foundation; both are recorded so they are decided deliberately.

1. **Browser credentials for a customer frontend.** A workspace API key is a long-lived secret and
   the refactoring ledger already defaults to "an API key may not borrow a human principal". A
   customer's browser therefore needs a short-lived, run- or session-scoped token minted by their
   backend through the SDK — analogous to the gateway's per-run token. This is a control-plane
   feature (an endpoint, a verifier), not an SDK feature; until it exists, the SDK's browser story
   is our own same-origin application.
2. **Envelope regularity.** Item routes return a bare resource for agents, projects, connectors and
   models but `{ run }`, `{ session }`, `{ workspace }` elsewhere. The contracts publish what the
   server does today; the SDK hides the difference behind uniform methods. Normalising the wire is a
   breaking change and belongs to a versioned API, not to this phase.
