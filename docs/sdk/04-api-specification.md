# 4. Agent Workspace SDK — API specification

Status: **proposed, for ratification.** This document is the normative contract for the complete
Agent Workspace SDK and CLI surface. It describes every resource the control plane exposes, the
operations on each, and the SDK method that performs it. Where the control plane's wire is today
irregular or missing, the specification says what the target is, marks the delta as a **server
change**, and never pretends the delta exists.

Precedence: `docs/spec.md` (product) → this document (SDK contract) → `packages/contracts`
(executable schemas) → `packages/sdk` (client). A schema that disagrees with this document is a
defect in one of the two; the conformance test in `apps/web/server/sdk-conformance.test.ts`
decides which.

Reading guide: §1–§4 are the model and conventions; §5 is the resource-by-resource contract;
§6 is runtime neutrality; §7 is the CLI; §8 is the list of server changes this specification
requires; §9 is how the specification is proven.

---

## 1. Purpose and scope

The SDK must let a program do everything the control-plane UI can do, under the same
authorisation, for three consumers: our own web application, a customer's backend, and a
customer's frontend. "Everything" means, in scope order:

1. **Execution** — start, follow, resume, list and read runs; sessions and projects.
2. **Agent authoring** — agents, their permissions and policies, resource assignments; skills;
   connectors (MCP); model connections and model choice; runtime profiles and runtime
   connections; secrets.
3. **Tenancy and administration** — workspaces, members, users, invitations, API keys, sharing,
   metrics, audit.

Out of scope, permanently: first-run setup (`POST /api/setup`), OIDC sign-in, and the public
share pages under `/p/*`. These are browser journeys, not programmatic operations.

### 1.1 Vocabulary

| Term                    | Meaning                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Workspace SDK** | `@indx-workspace/contracts` + `@indx-workspace/sdk` (+ the `aw` CLI, §7). This document.                                                                                                                                                  |
| **Claude Agent SDK**    | `@anthropic-ai/claude-agent-sdk`, the engine that executes an agent today. The reference _engine_ of §6.                                                                                                                                  |
| **Engine**              | The harness that turns an agent definition and a prompt into model calls, tool calls and a stream of events; the `engine` field. `claude-agent-sdk`, `openai-agents`, `pi` and `mastra` today; `acp` is planned (ADR-0065, tracker #299). |
| **Model provider**      | Who serves the model (`anthropic`, `openai`, `azure-openai`, `openai-compatible`, …). A property of a model connection, carried on a run as `provider`. Never the engine.                                                                 |
| **Runtime driver**      | Where a run executes (`local`, `docker`, `kubernetes`, `cloud-run-service`, …). Orthogonal to the engine; selected by a runtime profile.                                                                                                  |
| **Wire protocol**       | The HTTP dialect an engine speaks to the gateway: `anthropic-messages`, `openai-responses`, `openai-chat-completions`.                                                                                                                    |
| **Workspace**           | The tenant. Every resource below belongs to exactly one.                                                                                                                                                                                  |
| **Principal**           | The exact actor a request runs as: a membership (a user in a workspace, with a role) or an API key (with a role). Never a bare user.                                                                                                      |

---

## 2. Resource model

```text
Workspace (tenant, slug, archive state, publicSharingEnabled)
 ├─ Principal ──── Membership(User, Role) | ApiKey(Role, prefix, expiry, revocation)
 │                 Invitation(email, Role, token shown once) ─▶ Membership
 ├─ ModelConnection(provider, config, credential: write-only) ─▶ Model (discovered, capabilities)
 ├─ RuntimeConnection(driver, endpoint, credential: write-only)
 ├─ RuntimeProfile(driver, ─▶ RuntimeConnection?, cpu/mem/disk, network policy, filesystem, timeouts, driverConfig)
 ├─ Secret(name, ciphertext: write-only)
 ├─ File(path, kind file|folder, bytes)          ─┐
 ├─ Skill(name, SKILL.md + files, enabled)        ├─ assignable to an Agent
 ├─ Connector(MCP: transport, url|command, auth, credential: write-only) ─┘
 ├─ Agent(name, instructions, ─▶ ModelConnection?+model?, ─▶ RuntimeProfile?, permissions, policy, assignments, owner Principal)
 ├─ Project(name, instructions, defaults: Agent?, ModelConnection?+model?, visibility, files, connectors, archive state)
 ├─ Session(─▶ Agent, ─▶ Project?, owner Principal, providerSessionId, title, active|archived)
 │    └─ Run(status, ─▶ Session, ─▶ Agent, usage, cost, accounting, error)
 │         └─ RunEvent(id monotonic, name, data)   ← the stream
 ├─ Share(subject: agent|session|project|skill, visibility, snapshot, expiry, passphrase, budget)
 ├─ AuditEvent(actor Principal, action, subject)
 └─ Metrics(recent run telemetry)
```

Ownership is resolved by each resource's adapter. Agents, skills, files, connectors, projects and
sessions store `ownerPrincipalId`; a run has no owner column and inherits its owner from its session
(F-060). Shares store their publishing actor separately. Most authorisation compares principals;
the existing `agent_grants` relation is keyed by user ID (F-053/F-068). `createdBy`, `userId` and
`initiatingUserId` are human attribution fields and may be `null`.

---

## 3. Authentication, tenancy, authorisation

### 3.1 Credentials

| `auth.kind`     | Sends                                                      | Tenant                                                 | For                                                 | Status |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- | ------ |
| `api-key`       | `Authorization: Bearer ak_live_<22>_<43>`                  | The workspace the key was minted in (fixed)            | Backends, CI, the CLI                               | ✅     |
| `session`       | The browser's cookie (`credentials: 'include'`), no header | The session's current workspace                        | Our own UI on the same origin                       | ✅     |
| `browser-token` | `Authorization: Bearer awt_live_<22>_<43>`                 | The token's workspace; scope limited to run/session    | A customer frontend; API keys never reach a browser | ✅     |
| `user-token`    | `Authorization: Bearer awu_live_<22>_<43>`                 | The token's workspace; `aw workspaces select` moves it | The CLI, as a person (issue #242, ADR-0083)         |

A malformed bearer is `401 unauthenticated`; a revoked, expired and unknown key are
indistinguishable (spec §22, R-12 §1.5). The SDK never retries a 401.

#### 3.1.1 Browser tokens (issue #236, SDK-04, S-1)

`POST /api/tokens` (Owner, Admin or Builder, via an API key or a session) mints a bearer with
prefix `awt_live_`, the same anchored fixed-length grammar as `ak_live_` — a 22-character public
half and a 43-character secret half, both base64url — so `apps/web/proxy.ts` can recognise the
credential by shape before any route verifies it. The stored form is a SHA-256 hash, never the
bearer itself; the plaintext is returned exactly once, in the `201` body of the mint call.

**Attenuation, not a fourth identity.** A browser token resolves to its _minting_ principal —
the same session or API key that called `POST /api/tokens` — with a `scope` attached that narrows
what it may do. The minting principal's role is re-read from the directory on every request, never
carried in the token: revoking the minting key, or demoting the minting member, takes effect on
the token's very next call.

**Scope.**

```ts
type TokenScope = { kind: 'run'; id: string } | { kind: 'session'; id: string };
```

**Grammar — the routes each scope may reach, and nothing else:**

| Scope     | Route                                | What it does                                                                                                                                                                                                                                        |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | `GET /api/runs/:id`                  | Read that run, and only that run.                                                                                                                                                                                                                   |
| `run`     | `GET /api/runs/:id/events`           | Follow that run's stream.                                                                                                                                                                                                                           |
| `session` | `GET /api/runs/:id`                  | Read a run that belongs to that session.                                                                                                                                                                                                            |
| `session` | `GET /api/runs/:id/events`           | Follow the stream of a run in that session.                                                                                                                                                                                                         |
| `session` | `POST /api/agents/:id/runs`          | Start a run in that session (`sessionId` required in the body; a request that omits it, or names another session, is refused).                                                                                                                      |
| `session` | `POST /api/runs/:id/feedback`        | Rate a run that belongs to that session.                                                                                                                                                                                                            |
| `session` | `POST /api/files/:id/download-urls`  | Mint a presigned `GET` for a file under that same prefix.                                                                                                                                                                                           |
| `session` | `POST /api/sessions/:id/attachments` | Upload one file (raw body, `?name=`) to that session's `.attachments/<sessionId>/` prefix; answers `201 { fileId, path, size }`. A surface with `parts.attachments` only; at most 10 MiB a file, 20 files or 50 MiB a session, 10 uploads a minute. |

Every route outside this table is refused for a browser-token caller. Most are stopped at the edge
with `401 unauthenticated` before a handler runs — `apps/web/proxy.ts` admits the credential's shape
only on `GET /api/runs/:id(/events)`, `POST /api/agents/:id/runs`, `POST /api/runs/:id/feedback`,
`POST /api/files/:id/upload-urls`, `POST /api/files/:id/download-urls` and
`POST /api/sessions/:id/attachments`, and every other `/api/**` path
falls to the session-cookie gate — and that covers `GET /api/runs` (the workspace-wide list; a scope
reads one row, never a collection) and `POST /api/tokens` itself (a browser token cannot mint
another one: `tokens` is in no scope's grammar). A route inside the grammar's prefix but outside its
cells reaches `decide()` and answers `403 token_out_of_scope`. The scope grammar is keyed by
resource and operation and, for feedback, the sub-resource (so a session scope reaches
`POST /api/runs/:id/feedback` but not `POST /api/runs/:id/interrupt`, the same `run` verb), so it can also classify GET/HEAD shapes without shipped handlers; those
shapes still answer 405 at the route boundary. A run scope's `:id` must name the same run, including
an equivalent upper-case spelling of a valid UUID; a session scope's row identity (its
run must belong to that session) is checked where the row is read, since the path segment on that
shape is a run id or an agent id, never the session id.

**TTL.** `60 ≤ ttlSeconds ≤ 3600`, default `300`. Requesting a wider TTL than the bound, or minting
for a target the caller may not itself reach (an ownership check on the target row, using the same
`own`/`any` width §21 already gives Owner/Admin/Builder over `tokens`), is refused before a row is
written.

**Revocation.** A token stops authenticating when: `expiresAt` passes; the scoped run or session
reaches a terminal state (a run's `cancelled`/`completed`/`failed`, a session's `archived`); or its
minting principal is revoked. There is no separate revoke-by-id call for a browser token itself —
revoking the run or the session (or the minting credential) is how one is invalidated early.

**Problem codes:** `token_out_of_scope` (403, the scope gate itself), `unauthenticated` (401, an
unknown/expired/revoked token — indistinguishable, R-12 §1.5's rule applied to this credential
too), `forbidden` (403, the ordinary §21 grant denied it), `invalid_field` (400, a malformed mint
request).

```ts
const token = await backend.tokens.mint({ kind: 'run', id: run.id });
const browser = createClient({ baseUrl, auth: { kind: 'browser-token', token: token.token } });
for await (const frame of browser.runs.follow(run.id)) {
  /* … */
}
```

### 3.2 Workspace selection

An API key is bound to one workspace, so `createClient` with `auth: { kind: 'api-key' }` needs
no workspace argument — and gets no workspace records either: every `/api/workspaces` route and
every `/api/invitations` route refuses an API-key principal with `403 api_key_not_permitted`
(ADR W9-WS-119: a key has a fixed role and no human membership to list, create or administer
against), so §5.1's `list|get|create|update` and §5.2's invitations are session-only. An API-key
caller reads the workspace and role it was authorised under from `me()` (§5.2), which is the one
route both credential kinds answer. A session may belong to several workspaces; switching is
`POST /api/auth/workspace`, which now answers both shapes on the same route (issue #236, SDK-04,
S-2): a form-encoded body still gets the original `303` redirect and bare error codes; this branch is
the shell's workspace switcher form (`apps/web/components/shell/workspace-switcher.tsx`) and is not
deprecated, and a JSON body (`Content-Type: application/json`) gets `200 { workspace }` plus the new
session cookie, in the standard `{ error: { code, message } }` envelope on failure (with `detail`,
a deprecated duplicate of `message`, until the next major release (ADR-0078 D7)). A workspace the
caller does not belong to answers identically to one that does not exist, on either path.
The SDK exposes:

```ts
createClient({ baseUrl, auth: { kind: 'session' }, workspace?: string /* id or slug */ })
```

`workspace` selects that workspace once, memoised, before the client's first request —
`aw.workspaces.select(idOrSlug)` is the same call made explicitly, any time after construction.

### 3.3 Roles

Four roles (spec §21). The SDK does not encode the table; it surfaces `403 forbidden`. The table
is reproduced so an integrator can predict outcomes; it is `apps/web/server/rbac/permissions.ts`
as of this document's date.

| Resource                                                 | Owner                                                                 | Admin        | Builder                              | Viewer                    |
| -------------------------------------------------------- | --------------------------------------------------------------------- | ------------ | ------------------------------------ | ------------------------- |
| agents                                                   | all                                                                   | all          | read any, write own, run _permitted_ | read any, run _permitted_ |
| skills, files                                            | all                                                                   | all          | read any, write own                  | none                      |
| connectors                                               | all                                                                   | all          | read any, write own                  | none                      |
| model-connections, models, runtime-connections, runtimes | all                                                                   | manage       | none                                 | none                      |
| runtime-profiles                                         | all                                                                   | manage       | read                                 | none                      |
| secrets                                                  | all                                                                   | none         | none                                 | none                      |
| projects                                                 | all                                                                   | manage       | own                                  | none                      |
| sessions                                                 | all                                                                   | own          | own                                  | own (read)                |
| runs                                                     | all                                                                   | read/run any | read/run own                         | read/run own              |
| webhooks (N-3, #250)                                     | all                                                                   | manage       | none                                 | none                      |
| memberships, users, invitations, api-keys                | all                                                                   | manage       | none                                 | none                      |
| tokens (mint only — issue #236)                          | all                                                                   | write any    | write own                            | none                      |
| shares                                                   | all                                                                   | manage       | own                                  | own                       |
| sharing-policies                                         | all                                                                   | read         | read                                 | read                      |
| metrics                                                  | all                                                                   | read         | read                                 | read                      |
| engines, platforms                                       | all                                                                   | read         | read                                 | read                      |
| audit-events                                             | all                                                                   | none         | none                                 | none                      |
| me                                                       | all                                                                   | read         | read                                 | read                      |
| setup                                                    | all                                                                   | none         | none                                 | none                      |
| workspaces                                               | member-scoped: read any membership, write only as Owner of the target |              |                                      |                           |

"Permitted" means an agent the caller owns or an explicit `agent_grants` row names, managed
through `GET/PUT /api/agents/:id/grants`.

The roles are monotonic (ADR-0152): each role holds at least every grant of the roles below it, so
a role may confer itself and any role below it, and an Admin may confer every role but Owner.

---

## 4. Conventions

| Topic                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifiers             | The server mints UUID v4 IDs. The shared identifier parser accepts syntactically valid UUID text of any version or variant, including nil and upper-case hex. `Skill.name` is a slug; files are addressed by `path`, whose route id is the unpadded base64url of its UTF-8 bytes (`fileRouteId`), never percent-encoding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Timestamps              | ISO-8601 UTC strings. `null` means "has not happened".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Money                   | Decimal strings (`"0.001234"`), currency `USD`. One exception the contracts publish as-is: `RunTelemetry.costUsd` on `GET /api/metrics` is a JSON number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Envelopes               | Lists: `{ <plural>: [] }` (the model-connection list is `{ models }`, the metrics list `{ runs }`, the audit list `{ events }`). Items: **bare** for agents, projects, connectors, model connections, runtime profiles, runtime connections, secrets, shares; **wrapped** (`{ run }`, `{ session }`, `{ workspace }`, `{ skill }` — also for a skill export — `{ file }`, `{ membership }`, `{ apiKey }`, `{ invitation }`, `{ user, membership }`) elsewhere. The SDK hides this; the contracts state it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Errors                  | `{ error: { code, message, details? } }` (`ApiProblemSchema`) is the target on every `/api/**` route, and the RBAC layer (every team route, and the 401/403/500/503 refused before any handler runs) and `GET /api/audit-events` answer it since SDK unit 6 (#238, ADR-0075). Those routes also render `detail`, a deprecated duplicate of `message`, until the next major release (ADR-0078 D7). One other spelling exists today: the bare `{ error: '<code>', message? }` of `POST /api/runtimes/test` (**S-4**). Two older spellings — the RBAC layer's `{ error: { code, detail } }` (`ApiProblemDetailSchema`) and the bare code on `GET /api/audit-events` — are still published so the SDK reads the `code` from a deployment older than #238. A failed model-connection probe answers `502` with the probe outcome as the body, not an envelope. `code` is stable; `message` is safe prose; `details` are per-field strings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Status                  | 200 read/update, 201 create, 202 run accepted, 204 delete (except where the delete has something to say: model connections `200 { deleted, referencedBy }`, API keys and invitations `200 { … }` with the revoked row, files `200` with a subtree outcome), 400 malformed/invalid, 401, 403, 404 (also for cross-tenant — never 403), 409 conflict, 410 gone, 413, 415, 422 unprocessable, 426 `contracts_version_unsupported` (see Versioning), 429 with `Retry-After`, 5xx with a fixed message and no cause.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Pagination              | `GET /api/runs`, `GET /api/sessions` and `GET /api/audit-events` return one page and `nextCursor` (`null` on the last); the cursor is opaque, never an offset, and pages are keyed on the immutable `(created_at, id)`. The session and audit cursors are bound to their list and the caller's workspace, and any other is `400 invalid_cursor` (ADR-0079). `limit` ≤ 200 for runs and sessions (sessions answer every remaining row when it is omitted) and ≤ 500 for audit events (default 100). Every other list is unpaginated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Idempotency             | `Idempotency-Key` on `POST /api/agents/:id/runs` (S-6, ADR-0151): a retry with the same key and the same request returns the run the first start queued; §5.12 states the rules. The SDK sends the header only when `runs.start` is given an `idempotencyKey`; it never invents one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Credentials on the wire | Write-only. No response ever contains an API key secret (except the mint response, once), a model/connector/runtime credential, or a secret value. Response schemas have no field for them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Versioning              | `@indx-workspace/contracts` semver; `CONTRACTS_VERSION` is exported from the package root. Additive response fields are minor releases and removals/renames happen only in a major release; the strict SDK response decoders require coordinated releases (F-084). Every request carries `X-Agent-Workspace-Contracts: <MAJOR.MINOR.PATCH>` — the version the client was built against — and every `/api/**` answer carries the served range: `X-Agent-Workspace-Contracts` (the server's current version) and `X-Agent-Workspace-Contracts-Minimum` (the oldest it serves). The range is compared on `major.minor`. `apps/web/proxy.ts` judges the header first, before any authentication, authorisation or body parsing: outside the range answers `426 contracts_version_unsupported`, a header that is not a plain `MAJOR.MINOR.PATCH` answers `400 contracts_version_malformed`, both in the standard envelope with both versions in the message. A request without the header is always accepted and served at the current version — browser forms, links and the IdP's `form_post` callback cannot send it — so negotiation applies only to a client that declares a version; the SDK and `aw` always do (ADR-0078 D4). A `426` carries `Upgrade: agent-workspace-contracts/<major.minor>` (RFC 9110). Deprecation and served range (03 §3.3, ADR-0078 D7): an item is deprecated in a minor and removed only in the next major, no earlier than one minor after; the server serves its current minor and the previous minor of the same major, and at `X.0` the previous major's last minor, for that one minor. |
| Cancellation            | Every SDK method takes `{ signal }`; `timeoutMs` bounds headers only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Problem codes emitted by the server are stable identifiers for callers to branch on. The current
`ApiProblemSchema` validates `code` as a nonempty string and does not enforce an identifier pattern;
it also accepts whitespace-only input when decoding an external problem body (F-085).
| Bytes | Files download as `application/octet-stream` with `Content-Disposition: attachment`; uploads are raw bodies with the path in an `x-file-path`/`x-folder-path` header, percent-encoded and flagged by `x-resource-path-encoding: percent-utf8`. |

---

## 5. Resources

Each entry: the wire resource, the operations (route → SDK method → status), and notes. Status:
✅ implemented in `packages/sdk`; 📄 contract only; ⬜ specified, not built; **S-n** needs a server
change listed in §8.

### 5.1 Workspaces — `aw.workspaces`

`WorkspaceResource { id, slug, name, publicSharingEnabled, archivedAt|null, createdAt, updatedAt }`;
`WorkspaceMembershipView = WorkspaceResource + { role }`.

| Operation                       | Route                             | SDK                                          | Status |
| ------------------------------- | --------------------------------- | -------------------------------------------- | ------ |
| List my workspaces with my role | `GET /api/workspaces`             | `list()`                                     | ✅     |
| Read one                        | `GET /api/workspaces/:id`         | `get(id)`                                    | ✅     |
| Create (caller becomes Owner)   | `POST /api/workspaces`            | `create({ name, slug })`                     | ✅     |
| Rename / archive / restore      | `PATCH /api/workspaces/:id`       | `update(id, { name?, archived? })`           | ✅     |
| Switch the session's workspace  | `POST /api/auth/workspace`        | `select(idOrSlug)`                           | ✅     |
| Sharing policy read/write       | `GET/PATCH /api/sharing-policies` | `sharingPolicy.get()/set({ publicSharing })` | ✅     |

`SharingPolicy { publicSharing }` is the same fact as `WorkspaceResource.publicSharingEnabled`
(one column, two spellings). `PATCH` is Owner-only (`403 forbidden`), a non-boolean is
`400 invalid_policy`. The four `/api/workspaces` rows are **session auth only** (§3.2, ADR
W9-WS-119: an API-key principal is `403 api_key_not_permitted`); the sharing-policy routes serve
both principals, which is why they are the only `aw workspaces` commands the CLI has (§7.2).
For a named workspace route, an invalid UUID is answered as `404 workspace_not_found` before
membership lookup, concealing whether any workspace exists. This is an intentional exception to
the general malformed-ID 400 convention (F-095).

### 5.1.1 Tokens — `aw.tokens` (issue #236, SDK-04, S-1)

`MintTokenResponse { token, scope: TokenScope, expiresAt, warning }`. See §3.1.1 for the full
grammar, TTL bounds and revocation conditions.

| Operation                           | Route              | SDK                            | Status |
| ----------------------------------- | ------------------ | ------------------------------ | ------ |
| Mint a run- or session-scoped token | `POST /api/tokens` | `mint(scope, { ttlSeconds? })` | ✅     |

Owner/Admin/Builder, via an API key or a session; Viewer is `403 forbidden`. Backend use only —
`aw tokens mint` exists for a backend's own tooling; there is no browser-side command, because a
browser holds the _minted_ token, never the credential that mints one.

### 5.2 Principals: members, users, invitations, API keys — `aw.team`

`MembershipResource { id, principalId?, userId, email, name, role, createdAt }`
`UserResource { id, email, name, createdAt }`
`InvitationResource { id, email, role, invitedBy|null, expiresAt, acceptedAt|null, revokedAt|null, createdAt }`
`ApiKeyResource { id, name, role, keyPrefix, lastUsedAt|null, expiresAt|null, revokedAt|null, createdAt }`

| Operation                    | Route                              | SDK                                                                            | Status                               |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| List members                 | `GET /api/memberships`             | `members.list()`                                                               | ✅                                   |
| Add a member (existing user) | `POST /api/memberships`            | `members.add({ email, role })`                                                 | ✅                                   |
| Change role                  | `PATCH /api/memberships/:id`       | `members.setRole(id, role)`                                                    | ✅                                   |
| Remove a member              | `DELETE /api/memberships/:id`      | `members.remove(id)` (204; `409 membership_in_use`, `409 last_owner`)          | ✅                                   |
| List / create users          | `GET/POST /api/users`              | `users.list()`, `users.create({ email, name, role })` → `{ user, membership }` | ✅                                   |
| List invitations             | `GET /api/invitations`             | `invitations.list()`                                                           | ✅                                   |
| Invite (token shown once)    | `POST /api/invitations`            | `invitations.create({ email, role })` → `{ invitation, token, link, warning }` | ✅                                   |
| Resend (rotates token)       | `POST /api/invitations/:id/resend` | `invitations.resend(id)`                                                       | ✅                                   |
| Revoke                       | `DELETE /api/invitations/:id`      | `invitations.revoke(id)` (200 with the row)                                    | ✅                                   |
| Accept                       | `POST /api/invitations/:id/accept` | `invitations.accept(id, token)` → `{ workspaceId, membership }`                | ✅ (browser session only, see notes) |
| List API keys                | `GET /api/api-keys`                | `apiKeys.list()`                                                               | ✅                                   |
| Mint (secret shown once)     | `POST /api/api-keys`               | `apiKeys.create({ name, role, expiresAt? })` → `{ apiKey, key, warning }`      | ✅                                   |
| Revoke                       | `DELETE /api/api-keys/:id`         | `apiKeys.revoke(id)` (200 with the row, idempotent)                            | ✅                                   |
| Who am I                     | `GET /api/me`                      | `me()` → `{ principalId, kind, role, workspaceId, userId \| null, label }`     | ✅                                   |

Notes. Every route in this family answers problems in the standard `{ code, message }` envelope
(§4; `detail` is a deprecated duplicate until the next major release (ADR-0078 D7)). Every membership response renders the
required `principalId` of its backing workspace principal, including memberships created before
workspace principals were introduced.
`members.add` reads `email` and `role` only. The invitation routes refuse API-key callers
(`403 api_key_not_permitted`) and reject unknown body keys; `accept` is reachable only from the
browser that completed the OIDC pre-membership step (same-origin check, invitation-identity
cookie; `401 invitation_identity_required`, `404 invitation_not_valid`, `410 invitation_expired`,
`410 invitation_revoked`, `409 invitation_already_used`, `409 already_a_member`), so a Node
caller cannot use it. API keys: name ≤ 120, `expiresAt` absent or `null` means no expiry,
`409 name_taken`, `404 no_such_api_key`; the minted key is `ak_live_<22>_<43>`. Members and
users: email ≤ 320 and lower-cased, name ≤ 200, `403 forbidden_role_conferral`,
`409 email_taken`, `404 no_such_user`, `409 already_a_member`, `404 no_such_membership` (also for
a non-UUID id). `me()` is on the root client, not on `aw.team`: it answers for both credential
kinds and takes no id. `kind` is `membership | api-key`; `userId` is `null` for exactly an
API-key principal, and `label` is the member's name or the key's name. A revoked key and an
expired session are both `401 unauthenticated`, never a `200` with a stale principal, and no
credential material — key hash, secret, session id — is in the body.

### 5.3 Model connections and models — `aw.models`

```ts
ModelProvider = 'anthropic' | 'anthropic-compatible' | 'openai' | 'azure-openai' | 'openai-compatible'
ModelConnectionResource {
  id, name, provider,
  config: { baseUrl?, deployment?, apiVersion? },   // per-provider allowed/required fields
  hasCredential: boolean, ready: boolean,           // ready = credential + required config present
  createdAt, updatedAt
}
DiscoveredModel { connectionId, providerModelId, displayName,
  capabilities: { streaming, toolUse, thinking, promptCaching, structuredOutput, contextManagement, webSearch, tokenCounting } }
```

| Operation                       | Route                         | SDK                                                                                                              | Status |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| List connections                | `GET /api/model-connections`  | `connections.list()` (the list key is `models`)                                                                  | ✅     |
| Read / create / update / delete | `GET/POST/PATCH/DELETE …/:id` | `connections.get/create({ name, provider, apiKey, config? })/update(id, { name?, config?, apiKey? })/remove(id)` | ✅     |
| Rotate credential (write-only)  | `POST …/:id/credential`       | `connections.rotateCredential(id, apiKey)` (204)                                                                 | ✅     |
| Test                            | `POST …/:id/test`             | `connections.test(id)` → `{ ok, status, latencyMs, message }` (200, or 502 with the same body)                   | ✅     |
| Discover models                 | `GET /api/models`             | `discover()` → `{ models, unavailable? }`                                                                        | ✅     |

Provider config rules are part of the contract (`MODEL_PROVIDER_CONFIG_RULES`: `anthropic`/
`openai`: `baseUrl` optional; `openai-compatible`: `baseUrl` required; `azure-openai`: `baseUrl`,
`apiVersion`, `deployment` required). A `PATCH` that changes `config.baseUrl` on a connection with a
saved key must carry a new `apiKey`, or it is `409 credential_required_on_retarget` and nothing
changes: the saved key never follows the connection to a new destination. `remove` answers `200 { deleted: true, referencedBy: [{
agentId, agentName }] }` and does **not** refuse: the agents' `modelConnectionId` is cleared
(`ON DELETE SET NULL`, issue #126) and they are named so the caller can re-point them. A failed
probe travels as a `502` whose body is the outcome, not an error envelope (§4); the SDK resolves
`test` with `ok: false` in that case. `discover().unavailable` lists `{ connectionId,
connectionName, reason }` for connections that answered badly and is absent when empty;
connections that are not `ready` are skipped silently. The resource carries no `workspaceId`.
Problem codes: `400 invalid_model_connection_id`, `404 model_connection_not_found` (also on
`rotateCredential` when no credential exists to replace), `409 model_connection_name_conflict`,
`400 invalid_body`, `503 models_runtime_not_configured`. Model choice on an agent, project, or
run is always the pair `(modelConnectionId, model)`, never one without the other.

### 5.4 Runtime profiles, connections and drivers — `aw.runtimes`

```ts
RuntimeDriver = 'local' | 'sandbox-runtime' | 'docker' | 'kubernetes' | 'gke-agent-sandbox' | 'aca-sessions'
              | 'aws-agentcore' | 'aws-ecs' | 'cloud-run-sandbox' | 'cloud-run-service' | 'external'
              | 'vercel-sandbox'
RuntimeProfileResource {
  id, workspaceId, name, driver, runtimeConnectionId|null,
  cpu|null, memoryMb|null, diskMb|null,
  networkPolicy: 'none'|'restricted'|'open', allowedDomains|null,
  filesystem: 'read-only'|'read-write', persistPaths|null,
  timeoutSeconds|null, idleTimeoutSeconds|null, driverConfig|null,
  createdAt, updatedAt
}
RuntimeConnectionResource { id, name, driver, createdAt }        // endpoint and credential are write-only
RuntimeAvailability { driver, available: boolean, reason|null }   // what the host can actually run
```

| Operation                                       | Route                                        | SDK                                                                                | Status                        |
| ----------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| List / read / create / update / delete profiles | `/api/runtime-profiles[/:id]`                | `profiles.list/get/create/update/remove`                                           | ✅                            |
| List / create connections                       | `GET/POST /api/runtime-connections`          | `connections.list()`, `connections.create({ name, driver, endpoint, credential })` | ✅                            |
| Detect what the host can run                    | `GET /api/setup/runtime-detect`              | `detect()`                                                                         | ⬜ S-9 (move out of `/setup`) |
| Test a driver                                   | `POST /api/runtimes/test`                    | `test(driver, echo?)`                                                              | ⬜ S-4 (envelope)             |
| Switch an agent's runtime                       | `PATCH /api/agents/:id { runtimeProfileId }` | `agents.update(id, { runtimeProfileId })`                                          | ✅                            |

A profile is a **reference** from an agent, never a copy (spec §14.9); switching is an agent
update and is audited. The server is authoritative on what a driver can enforce
(`422 network_policy_not_enforceable`); a client-side hint waits for the capability table that
`detect` (S-9) would publish. Deleting a profile never conflicts: the agents' `runtimeProfileId`
is cleared (`ON DELETE SET NULL`), so the answer is `204` or `404`. A `PATCH` can change but not
clear a nullable field — `{ memoryMb: null }` is `400 invalid_body` (**S-19**). Bounds: `cpu` > 0,
`memoryMb`/`diskMb`/`timeoutSeconds`/`idleTimeoutSeconds` positive safe integers with no ceiling;
`driverConfig.image` must be a `sha256`-pinned reference on create. A connection's `name` is
returned in its stored, encoded form (`RUNTIME_CONNECTION__DOCKER__PRIMARY`). Problem codes:
`400 invalid_runtime_profile_id`, `404 runtime_profile_not_found`, `400 unknown_runtime_connection`,
`409 runtime_profile_name_conflict`, `409 runtime_connection_name_conflict`,
`503 runtimes_runtime_not_configured`.

### 5.5 Secrets — `aw.secrets`

`SecretResource { id, name, algorithm, masterKeyId, createdAt, updatedAt }` — the value never
returns.

| Operation | Route                     | SDK                       | Status |
| --------- | ------------------------- | ------------------------- | ------ |
| List      | `GET /api/secrets`        | `list()`                  | ✅     |
| Create    | `POST /api/secrets`       | `create({ name, value })` | ✅     |
| Replace   | `PUT /api/secrets/:id`    | `replace(id, value)`      | ✅     |
| Delete    | `DELETE /api/secrets/:id` | `remove(id)`              | ✅     |

Items are bare (§4). A name matches `^[A-Z][A-Z0-9_]{0,127}$`; a value is 1–65 536 code units;
`algorithm` is a free string on the wire. Reserved names (`MODEL_CONNECTION_*`, runtime-connection
conventions) are **not** refused today — the convention is a naming one until RF-204 replaces it
with typed foreign keys, and the contract does not expose it. Problem codes: `400 invalid_body`
(with per-field `details`; also `name` on `PUT`), `409 secret_name_conflict`,
`400 invalid_secret_id`, `404 secret_not_found`, `503 secrets_runtime_not_configured`. A delete is
Owner-only (`403` for every other role, whether or not the id exists) and is refused with
`409 secret_in_use` while a connector authenticates with the secret or a model connection owns it;
`details` names each referrer as `connector:<id>` or `model-connection:<id>` (ADR-0077,
`parseInUseReferrers`), and nothing is deleted. An id in another workspace is `404`, like one that
never existed.

### 5.6 Files — `aw.files`

`FileResource { id, path, kind: 'file'|'folder', sizeBytes|null, contentType|null, lastModified|null }`

| Operation                         | Route                                       | SDK                                                                                                                    | Status  |
| --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| List (optionally a subtree)       | `GET /api/files?path=`                      | `list({ path? })`                                                                                                      | ✅      |
| Upload a file                     | `POST /api/files` (raw body, `x-file-path`) | `upload(path, bytes                                                                                                    | Blob    | ReadableStream, { contentType? })` | ✅  |
| Create a folder                   | `POST /api/files` (`x-folder-path`)         | `createFolder(path)`                                                                                                   | ✅      |
| Download                          | `GET /api/files/:id`                        | `download(path)` → `{ kind: 'file', bytes, contentType, filename }` or `{ kind: 'folder', file }`                      | ✅      |
| Metadata                          | —                                           | `stat(path)`                                                                                                           | ⬜ S-11 |
| Rename / move (subtree)           | `PATCH /api/files/:id { newPath }`          | `move(path, newPath)` → `{ file }`, `{ status: 'ok', moved }` or `{ status: 'partial', moved, total, remaining? }`     | ✅      |
| Delete (folder needs `recursive`) | `DELETE /api/files/:id?recursive=true`      | `remove(path, { recursive? })` → `null` (204) or `{ status: 'ok' \| 'partial', deleted, remaining? }`                  | ✅      |
| Presigned upload                  | `POST /api/files/:id/upload-urls`           | `createUploadUrl(path, { sizeBytes, contentType?, ttlSeconds? })` → `{ url, method: 'PUT', headers, expiresAt, path }` | ✅      |
| Presigned download                | `POST /api/files/:id/download-urls`         | `createDownloadUrl(path, { ttlSeconds? })` → `{ url, method: 'GET', headers, expiresAt, path }`                        | ✅      |

**Presigned transfer.** The two `*-urls` routes sign a short-lived URL on the object store, so the
bytes of a browser upload or download never pass through the control plane. `ttlSeconds` is 60 to
900 (default 300) and is independent of the browser token's own lifetime. An upload URL signs the
exact `sizeBytes` on S3 and GCS, and the `contentType` when given (an Azure Blob SAS cannot carry a
length, so it does not enforce it); send the returned `headers` with the `PUT`.
A download URL serves the file as the same inert attachment `download` returns. A browser token of
`session` scope reaches `download-urls` only for paths under `.attachments/<sessionId>/` (any other
path, including another session's, is concealed as `404 file_not_found`) and is refused
`upload-urls` with `403 token_out_of_scope` on every store (§3.1.1; issue #1574): a visitor uploads
through `POST /api/sessions/:id/attachments`, whose attachment flag, name, rate and quota rules a
presigned `PUT` would skip. A `run` scope reaches neither route. An API key or a session is held to its ordinary §21 grant: Viewer has no files grant,
Builder is limited to files it owns, and the reserved prefixes stay refused (`400 reserved_path`).
The route performs no object-store I/O, so a minted URL does not prove the object exists
(`download-urls` answers `404 file_not_found` for a missing file or a folder). A store that cannot
sign (the local-filesystem and in-memory backends) answers `501 direct_transfer_unsupported`; use
`upload`. S3 (SigV4), GCS (V4) and Azure Blob (user-delegation SAS) sign natively. The browser's
`PUT` is cross-origin, so the bucket needs a CORS rule for the embedding origin.

Paths are workspace-relative, forward-slash, no `..`, no reserved prefixes (`400 reserved_path`).
A file is **addressed by `path`**; `FileResource.id` is opaque (the catalog's UUID when a catalog
is configured, otherwise the route id) and the route id is `fileRouteId(path)` (§4). Downloading
a path that names a folder answers `200 { file }` rather than bytes; the SDK tells the two apart
by `Content-Disposition`. Deleting a file, or nothing, is `204`; deleting a folder — even one
created empty — answers the subtree outcome (`409 folder_not_empty` without `recursive`,
`413 subtree_too_large` above 500 objects). An upload without `content-type` stores
`contentType: null`; the SDK buffers a `ReadableStream` into a `Blob` before sending, because
streaming request bodies are not portable. Uploads are bounded at 64 MiB
(`413 request_body_too_large`). A `partial` move or delete is a declared outcome, not an error,
until RF-304 makes storage operations durable. Problem codes: `400 invalid_path`,
`400 missing_file_path`, `400 unsupported_path_encoding`, `400 invalid_path_encoding`,
`404 file_not_found` (also for an unminted id), `409 name_conflict`, `409 self_descendant`,
`409 upload_in_progress`, `500 store_inconsistent`, `500 rename_inconsistent`,
`501 direct_transfer_unsupported`, `503 files_runtime_not_configured`.

### 5.7 Skills — `aw.skills`

```ts
SkillSummary { name, enabled, description|null, fileCount, createdAt, updatedAt, id? }
SkillDetail = SkillSummary + { source|null, instructions|null, allowedTools|null, files: [{ path, sizeBytes }] }
SkillFile { path, contentBase64 }
```

| Operation                 | Route                               | SDK                                                | Status |
| ------------------------- | ----------------------------------- | -------------------------------------------------- | ------ |
| List                      | `GET /api/skills`                   | `list()` (items are full `SkillDetail`s)           | ✅     |
| Import (SKILL.md + files) | `POST /api/skills`                  | `import({ name, files: SkillFile[] })`             | ✅     |
| Read                      | `GET /api/skills/:name`             | `get(name)`                                        | ✅     |
| Export                    | `GET /api/skills/:name?export=true` | `export(name)` → `{ name, files: SkillFile[] }`    | ✅     |
| Edit / enable / disable   | `PATCH /api/skills/:name`           | `update(name, { enabled?, files?, removeFiles? })` | ✅     |
| Publish revision          | `POST /api/skills/:name/revisions`  | `publish(name, { files })` → `SkillRevision`       | ✅     |
| Delete                    | `DELETE /api/skills/:name`          | `remove(name)`                                     | ✅     |

```ts
SkillRevision { number, fileCount, publishedAt }   // SkillDetail also carries revisions?: SkillRevision[], newest first
```

A skill is the Claude Agent SDK's native representation (a directory with `SKILL.md`
frontmatter). §6 keeps it provider-native on purpose: the SDK does not invent a portable skill
format. As rendered today the list carries full details (the route's catalog upsert reads
`source` from it), every body is wrapped in `{ skill }` — the export too — and an opaque `id?`
(the catalog row) rides along; a skill is addressed by `name` (1–64 chars,
`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`). `contentBase64` is standard padded base64; a file path
is at most 4096 UTF-8 bytes under the ADR-0044 segment grammar; a request body at most 16 MiB;
there is no per-file or file-count bound. `?export=true` is an exact string. An invalid name in
the path is `404 skill_not_found`, in an import body `400 invalid_name`. Problem codes:
`400 missing_name`, `invalid_name`, `missing_files`, `malformed_file_entry`, `inadmissible_path`,
`duplicate_path`, `missing_skill_md`, `malformed_content`, `invalid_path`, `empty_patch`,
`cannot_remove_skill_md`; `404 skill_not_found`; `409 skill_already_exists`, `colliding_paths`,
`skill_md_removal_rejected`, `skill_in_use`; `500 store_inconsistent`;
`503 skills_runtime_not_configured`. A delete removes the catalog row (in one transaction with the
assignment check) and then the skill's stored files and record; it is refused with
`409 skill_in_use` while any agent has the skill assigned, `details` naming each as `agent:<id>`
(ADR-0077). A Builder deletes only a skill it owns, an Admin any skill (ADR-0116); a Viewer has no skills grant. The
delete first writes a pending-delete marker that records the owner: until the delete finishes, no
list or read re-creates the catalog row or makes the reader its owner, and a retried `DELETE` —
by the owning Builder too — finishes an interrupted one (ADR-0077 D3).

A revision is an immutable, numbered (1, 2, 3 …) copy of a whole skill directory.
`POST /api/skills/:name/revisions` takes the same `{ files }` an import takes, replaces the skill's
current files with them and freezes them as revision _n_+1 (`201 { revision }`); `PATCH` keeps
editing only the current files, which are what `latest` means. The bytes are written once under
`skill-revisions/<name>/<n>/` and never rewritten, so a published revision cannot change under an
agent that pins it. An agent pins revisions in `skillRevisions` (skill id → number, on
`PUT /api/agents/:id/resources` and in a create's `assignments`; a pin must name an assigned skill);
a skill without a pin runs its current files. A pin naming a revision that does not exist is refused
(`422 agent_definition_references_missing`, `details` naming it `skill:<name>@<n>`; a malformed pin,
or one on a skill that is not assigned, is `400 invalid_assignments`). Publishing uses the skill's update grant (an Admin any skill, a
Builder one it owns) and deleting the skill deletes its revisions; `404 skill_not_found` for an
unknown skill.

### 5.8 Connectors (MCP servers) — `aw.connectors`

```ts
McpTransport = 'stdio' | 'http' | 'sse';  McpAuthType = 'none' | 'api-key' | 'bearer' | 'oauth'
ConnectorResource { id, workspaceId, name, transport, command|null, args|null, url|null, authType,
                    hasCredential, enabled, createdBy|null, ownerPrincipalId, createdAt, updatedAt }
TestConnectionOutcome = { ok: true, kind: 'ok', message, serverName|null, serverVersion|null, toolCount }
                      | { ok: false, kind: FailureKind, message }
```

| Operation                     | Route                                                                                           | SDK                                                | Status                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| List / read / create / delete | `/api/connectors[/:id]`                                                                         | `list/get/create({ name, transport, url            | command+args, authType?, credential? })/remove` | ✅  |
| Update fields                 | `PATCH /api/connectors/:id { name?, enabled?, url? \| command?/args?, authType?, credential? }` | `update(id, patch)`                                | ✅                                              |
| Rotate credential             | `PATCH /api/connectors/:id { credential }`                                                      | `rotateCredential(id, credential)`                 | ✅                                              |
| Test a saved connector        | `POST /api/connectors/:id/test-connection`                                                      | `test(id)` → `TestConnectionOutcome`               | ✅                                              |
| Test a draft (dry run)        | `POST /api/connectors { …, dryRun: true }`                                                      | `testDraft(input)` → `TestConnectionOutcome` (200) | ✅                                              |

`stdio` probes run only in a sandboxed runtime (ADR-0045); the control plane answers a declared
`{ ok: false, kind: 'stdio-probe-unavailable' }`, never a fake success. A failed probe is a `200`
with `ok: false` (17 `FailureKind`s, `TEST_CONNECTION_FAILURE_KINDS`), never a `502`. `PATCH` is a
field update (`ConnectorUpdateRequestSchema`): every field is optional and at least one is
required; any other key — `transport`, `ownerPrincipalId`, `workspaceId`, `createdBy` — is
`400 invalid_body`, so an update never moves the owner or changes the transport. `url` belongs to a
remote connector and `command`/`args` to a `stdio` one (`args: null` clears them). A body that is
exactly `{ credential }` rotates the saved value in place. `authType` from `none` to an
authenticated type requires a `credential`; to `none` drops the saved one. A patch that moves a
saved credential to a new destination — a new `url`, or a new `command` or `args` (the `stdio`
process receives the credential as `MCP_CREDENTIAL`) — must carry a new `credential` in the same
body, or it is `409 credential_required_on_retarget` and nothing changes: `connectors: MANAGE`
lets an Admin edit a member's connector, but secrets are Owner-only, so the saved value never
follows a retarget (ADR-0077 D5). The answer carries
`hasCredential`, never the value. `enabled: false` keeps the connector, and a run of an agent it is
assigned to, or of a session in a project it is associated with, fails to compose with the stable
code `connector_disabled`. Create rules:
`name` 1–200 code points, `url` must start with `http(s)://` and only with `http`/`sse`, `args`
only with `stdio` (no count bound), `authType` defaults to `none`, `credential` is required iff
`authType !== 'none'`; body ≤ 64 KiB. Problem codes: `400 invalid_body`,
`400 invalid_credential`, `404 connector_not_found` (also when a saved
credential secret dangles), `409 connector_name_conflict` (create or rename), `409 credential_not_configured`
(rotate on `authType: 'none'`), `409 credential_required_on_retarget` (a new destination without a
new credential), `503 connectors_runtime_not_configured`. Every saved-connector
item route resolves the row inside the authenticated workspace before the shared role decision. A
malformed, foreign, or nonexistent connector id therefore has the same concealing
`404 connector_not_found` response; a Builder may write and test only a connector they own.

### 5.9 Agents — `aw.agents`

```ts
AgentPermissions { readFiles, writeFiles, runCommands, unrestrictedNetwork }
AgentResource { id, workspaceId, name, instructions, modelConnectionId|null, model|null,
                runtimeProfileId|null, permissions, createdBy|null, ownerPrincipalId, createdAt, updatedAt }
AgentResourceAssignments { files: [{ fileId, access: 'read'|'read-write' }], skillIds, connectorIds }
AgentPolicy {
  provider: 'claude-agent-sdk',
  tools: { base: 'claude_code_preset' | GrantingToolRule[], autoApprove: GrantingToolRule[], deny: DenyingToolRule[],
           permissionMode, allowDangerouslySkipPermissions },
  skills: { mode: 'all' } | { mode: 'allowlist', names },
  limits: { maxTurns|null, maxBudgetUsd|null }
}
```

| Operation                              | Route                                                           | SDK                                                                         | Status                                  |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| List / read / create / update / delete | `/api/agents[/:id]`                                             | `list/get/create/update/remove`                                             | ✅                                      |
| Read / replace assignments             | `GET/PUT /api/agents/:id/resources`                             | `getResourceAssignments`, `replaceResourceAssignments`                      | ✅                                      |
| Read / replace policy                  | `GET/PUT /api/agents/:id/policy`                                | `getPolicy(id)`, `replacePolicy(id, policy)`                                | ✅                                      |
| Export / import a definition           | —                                                               | `export(id)` → `AgentDefinition`, `import(def)`                             | ✅ (composes 5.9 + 5.7 + 5.8; see §6.2) |
| Archive instead of delete              | `POST /api/agents/:id/archive                                   | restore`                                                                    | `archive(id)`, `restore(id)`            | ⬜ RF-201 |
| Viewer grants                          | `GET/PUT /api/agents/:id/grants`                                | `getGrants`, `replaceGrants`                                                | ✅                                      |
| Evaluate a version (201)               | `POST /api/agents/:id/evaluations`                              | `evaluations.create(id, { version, cases })`                                | ✅                                      |
| Promote / roll back                    | `POST /api/agents/:id/promote`, `POST /api/agents/:id/rollback` | `pointers.promote`, `pointers.rollback` (+ `checkPromote`, `checkRollback`) | ✅                                      |
| List run ratings                       | `GET /api/agents/:id/feedback`                                  | `feedback.list(id, { rating?, since?, runId? })`                            | ✅                                      |

`POST /api/agents/:id/evaluations` (issue #618) takes `{ version, cases }`, the cases of
`evals/<agent>.yaml` (`EvalCaseFileSchema`), and is a write on the agent (Admin any, Builder own,
Viewer `403`). The server runs each case as an ordinary run on a fresh session pinned to
`version` (#612), whatever `local` points at, checks
`contains`/`notContains`/`tool` against the answer, asks the agent's own model to grade a `judge`
rubric, and stores the score. It is synchronous: at most 20 cases, and the server stops waiting
after 225 s, failing a case still running with `deadline_exceeded`, so the `201` arrives within the
host timeout (240 s on Azure Container Apps, 300 s on Cloud Run). Problem codes:
`404 agent_version_not_found`, `400 invalid_body`, and a first case's run-start refusal. A case
abandoned at the deadline, still starting or running, is interrupted so it stops spending.
`aw eval [agent] [version]` reads `evals/<agent>.yaml`, posts it against `version` (default: the
one `local` points at), prints a table and exits 1 when any case fails.

`POST /api/agents/:id/promote` (issue #615) points `production` at the version `local` points at,
or at `{ version }`; `POST /api/agents/:id/rollback` points `{ environment }` (default `production`)
at the second entry of its pointer history. Both take `dryRun: true`, which decides and validates
the move and writes nothing, and answer `200 { environment, from, to, saved, bar }`. They are
pointer moves with the pointer RBAC (Admin any, Builder own, Viewer `403`), and each appends a row
to the pointer history in the move's transaction; `GET /api/agents/:id/versions` lists the last 10
moves as `moves`. Problem codes: `409 no_pointer` (promote, `local` points at nothing),
`409 nothing_to_roll_back`, `404 agent_version_not_found`, `400 invalid_agent_version`, and the
refusals `PUT /pointers` answers when the version no longer validates. When the deployment's
policy sets `promotion.minEvalScore` (issue #619), a promote and a `PUT /pointers` of `production`
also need the version's newest evaluation to pass at least that share of its cases:
`409 promotion_not_evaluated` (`[version:<n>, bar:<bar>]`) or `409 promotion_gate_failed`
(`[version:<n>, score:<score>, bar:<bar>, case:<name>…]`), and a dry run answers the same. `bar`
is that bar, or `null` (always on a rollback, which is never gated). `aw promote [agent] [version]`
and `aw rollback [agent]` move `production` and print the dry run's `production: <from> -> <to>`
until `--yes` is given; `aw versions [agent]` prints the pointers and the moves.

`GET /api/agents/:id/feedback` (issue #620) lists the newest 50 ratings of the agent's runs as
`{ items: [{ runId, rating, comment|null, input|null, answer, createdAt }] }`: `input` is the
prompt the run started with (`null` for a run recorded before prompts were stored) and `answer` is
its last assistant text. Optional query: `rating` (`up`|`down`), `since` (ISO 8601) and `runId`;
any other key is `400 invalid_query`. It is a read of the agent (every role), and a role whose
runs grant is `own` (Builder, Viewer) sees only the ratings of its own sessions' runs, as on
`GET /api/runs`. `aw feedback [agent] [--negative] [--since 7d]` prints it, and
`aw eval add-case <runId> [--yes]` appends a case made from one rated run to `evals/<agent>.yaml`.

`delete` today cascades through sessions and runs (RF-201); the SDK documents this and prefers
`archive` once it exists. `create` may carry `assignments` inline (the compound create the UI
uses); the SDK exposes it as `create(input, { assignments? })`.

### 5.10 Projects — `aw.projects`

```ts
ProjectResource { id, workspaceId, name, instructions|null, defaultAgentId|null,
                  defaultModelConnectionId|null, defaultModel|null, visibility: 'private'|'workspace'|'public',
                  createdBy|null, ownerPrincipalId, archivedAt|null, createdAt, updatedAt, fileIds, mcpServerIds }
```

| Operation                       | Route                               | SDK                                                              | Status                |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------- | --------------------- |
| List (`archived=active          | archived                            | all`) / read / create / update                                   | `/api/projects[/:id]` | `list/get/create/update` | ✅  |
| Archive / restore               | `POST …/:id/archive                 | restore`                                                         | `archive`, `restore`  | ✅                       |
| Start a session in the project  | `POST …/:id/sessions { agentId? }`  | `startSession(id, { agentId? })`                                 | ✅                    |
| Move a session into the project | `POST …/:id/sessions { sessionId }` | `adoptSession(id, sessionId)` → `{ projectId, sessionId }` (200) | ✅                    |

`adoptSession` is refused with `409 project_archived` (destination), `404 project_or_session_not_found`,
`409 project_session_has_runs`, and `403 forbidden` when the caller may not edit the session's
current project; a session already in another project is moved when the caller may edit both.

### 5.11 Sessions and transcripts — `aw.sessions`

```ts
SessionResource { id, workspaceId, agentId, userId|null, ownerPrincipalId, projectId|null,
                  claudeSessionId|null /* → providerSessionId, §6 */, title|null, status: 'active'|'archived',
                  resumable, createdAt, updatedAt }
TranscriptEntry: provider-native (one Claude Agent SDK transcript object; `unknown` to the contracts)
```

| Operation                             | Route                                                                  | SDK                                                                                             | Status |
| ------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| List (`status?`, `limit?`, `cursor?`) | `GET /api/sessions`                                                    | `list({ status?, limit?, cursor? })` → `{ sessions, projectKey, nextCursor }`; `listAll(query)` | ✅     |
| Read / rename / archive / restore     | `GET/PATCH /api/sessions/:id`                                          | `get`, `update(id, { title?, status? })`                                                        | ✅     |
| Read transcript                       | `GET /api/sessions/:providerSessionId/transcript?projectKey=&subpath=` | `transcript.read(providerSessionId, { projectKey?, subpath? })`                                 | ✅     |
| Append / delete transcript            | `POST/DELETE …/transcript`                                             | runtime-only by convention; **not exposed by the SDK**                                          | —      |
| List subkeys                          | `GET …/subkeys?projectKey=`                                            | `transcript.subkeys(providerSessionId, { projectKey? })`                                        | ✅     |

The transcript routes are keyed by the **provider's** session id (the platform id is accepted
too). `projectKey` — the workspace id, also returned by `list()` — is optional on every request:
an omitted one defaults to the caller's own workspace, for both a user and an API-key principal;
one that IS restated is still parsed and still compared against the caller's, so a disagreement
still answers `400 invalid_project_key` / `403 project_key_mismatch` rather than being stored
under it. The body is JSON, `{ entries: unknown[] }`, not JSONL. An API key that may access the session can read it;
append and delete are reachable over HTTP but the SDK does not expose them. `subpath` is at most
128 chars of `^[A-Za-z0-9][A-Za-z0-9_-]*(/…)*$` (`400 invalid_subpath`). Problem codes:
`503 session_api_not_configured`, `400 invalid_session_id`, `403 session_forbidden`,
`409 session_archived` (read only), `404 transcript_not_found`, `500 workspace_not_addressable`.

### 5.12 Runs and the event stream — `aw.runs`

```ts
RunStatus = 'queued'|'running'|'awaiting_approval'|'completed'|'failed'|'cancelled'
RunResource { id, workspaceId, agentId, projectId|null, initiatingUserId|null, sessionId, status,
              createdAt, startedAt|null, endedAt|null, durationMs|null, model|null, provider|null,
              modelConnectionId|null, usage { inputTokens, outputTokens, cacheReadInputTokens,
              cacheCreationInputTokens, totalTokens, toolCalls }, cost { amount, currency, priceTableVersion|null },
              error|null, accountingState: 'pending'|'complete'|'partial'|'failed'|'unavailable', accountingError|null }
StartRunRequest { prompt (≤100 000 chars, non-blank), sessionId?, modelConnectionId?+model? (together) }
// optional header: Idempotency-Key, 1–255 characters after trimming (S-6)
```

| Operation                           | Route                                                                                                                      | SDK                                                                                   | Status |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| Start (202)                         | `POST /api/agents/:id/runs` (+ `Idempotency-Key`)                                                                          | `start(agentId, { prompt, sessionId?, modelOverride?, fileScope?, idempotencyKey? })` | ✅     |
| Read                                | `GET /api/runs/:id`                                                                                                        | `get(id)`                                                                             | ✅     |
| List (filters, cursor)              | `GET /api/runs`                                                                                                            | `list(query)`                                                                         | ✅     |
| Stream, one connection              | `GET /api/runs/:id/events`                                                                                                 | `events(id, { after? })`                                                              | ✅     |
| Stream with resume                  | (same)                                                                                                                     | `follow(id, { maxReconnects?, reconnectDelayMs? })`                                   | ✅     |
| Reconnect backoff from `retry:`     | (same)                                                                                                                     | `follow(id, { maxReconnectDelayMs? })`                                                | ✅     |
| Wait for the settled record         | (same + `GET /api/runs/:id`)                                                                                               | `waitForOutcome(id)`                                                                  | ✅     |
| Interrupt                           | `POST /api/runs/:id/interrupt`                                                                                             | `interrupt(id)`                                                                       | ✅     |
| Revoke gateway tokens (Owner/Admin) | `POST /api/runs/:id/revoke-tokens` (`POST /api/runs/:id` kept, **deprecated**, until the next major release (ADR-0078 D7)) | `revokeTokens(id, { tokenId? })`                                                      | ✅     |
| Feedback (204)                      | `POST /api/runs/:id/feedback`                                                                                              | — (posted by the surface page)                                                        | ✅     |

Stream frames, classified by the SDK (`RunEventFrame`): `run-status` and `runtime` carry a
resume id; `run-failed`, `stream-reset`, `done` do not. A `runtime` frame's `name` is one of §6.3's
`agent.*` names and its `data` is that frame; `toAgentEvent` is the parser, and nothing else reads
`data`. A resume id is `<sequence>` or `<sequence>.<sub-index>`, the second form when one stored row
serves several frames (§6.3's legacy upgrade); ordering is `(sequence, sub-index)` and strictly
increasing, so `Last-Event-ID` can name any frame. Those two kinds also carry `at`, the time the
control plane recorded the event (an ISO-8601 instant, from the SSE `at:` field; absent from a
server that predates it). It is receive time at the control plane, not the engine's clock.
The SDK consumes `done` as generator completion; it is not yielded as a frame. The generator's
`RunStreamEnd` return value holds `lastEventId`, while SDK error classes do not expose that field.
`follow` uses a cumulative reconnect budget and retains its cursor after `stream-reset`; callers
rendering a transcript must clear their rendered state on that frame. The two reconnect delays are
bounds-checked (K-3, below); `maxReconnects` is not yet (point 21/22).

**Idempotent start (S-6, ADR-0151, issue #250).** `POST /api/agents/:id/runs` honours an
`Idempotency-Key` header, and `runs.start` sends it from `idempotencyKey`.

- **Same key, same request: the same run.** The answer is `202` with the run that key first started,
  whatever its status now: `queued`, `running`, `awaiting_approval`, or terminal, `cancelled`
  included. No second run is created and nothing is launched again.
- **Same key, different request: `409 run_idempotency_conflict`.** Send a new key.
- **The key** is trimmed. A blank key, or one over 255 characters, is `400 invalid_idempotency_key`.
  The key is scoped to the calling principal, so two callers may use the same key independently. It
  is never freed: a run that finished, paused or was cancelled keeps it.
- **"The same request"** is the agent id plus the parsed body, compared canonically: the SHA-256 of
  its JSON with every object's members sorted. A retry that reorders an object's keys (such as an
  `outputSchema` rebuilt by the client) is therefore the same request. Array order is part of what
  was asked.
- Two concurrent starts with one key create one run. The stored key is unique per principal, and
  the start that loses the race answers as a replay.

**Follow backoff (K-3, issue #250).** `follow` reconnects with a delay that
grows while reconnects keep failing:

- **Base.** The last `retry:` value the stream sent. Before the stream has sent one, the base is
  `reconnectDelayMs` (default 3000).
- **Growth.** For the _n_-th consecutive reconnect, the delay is
  `d = min(maxReconnectDelayMs, base × 2^(n−1))`. `maxReconnectDelayMs` is a new option, default
  30000, and a base above the cap is capped. A connection that delivers a new event resets _n_, as
  it already resets the `maxReconnects` budget.
- **Jitter.** The pause is uniform in `[d / 2, d]`, so followers dropped together do not reconnect
  together.
- **Precedence.** A `429` or `5xx` that carries `Retry-After` still sets the pause to exactly that
  value, uncapped and unjittered. The server's instruction wins over the client's schedule.
- `reconnectDelayMs` and `maxReconnectDelayMs` must be non-negative finite numbers with
  `reconnectDelayMs ≤ maxReconnectDelayMs`. Anything else throws a `TypeError` before the first
  request.

`interrupt` is authorised as §3.3's `run` verb — Admin any, Builder and Viewer own — the same
reading `POST /api/agents/:id/runs` already gets. It writes the run's terminal `cancelled` status
and revokes its gateway tokens whether or not the runtime itself can be reached (the security
boundary is the credential, not the child process); a follower observes the transition as a
`run-status` frame. The success answer comes only after that status and the revocation have
committed, so a caller never sees success for a run whose credential is still live. The runtime
itself then stops within about one cancellation-watch interval (2 s) plus the 5 s signal bound,
whichever replica served the interrupt: the replica holding the run's stream reads the committed
status and interrupts its runtime (ADR-0151-FU-1440 D1, issue #261). Problem codes: `409 run_not_interruptible` (already terminal),
`404 run_not_found`, `400 invalid_run_id`, `503 run_api_not_configured`. `revokeTokens` answers
identically on both paths; the deprecated `POST /api/runs/:id` is removed only in the next
major release, no earlier than one minor after this one (ADR-0078 D7).

Feedback (C19, issue #539) stores a `RunFeedbackRequest` — `{ rating: 'up'|'down', comment? }`, the
comment non-blank and at most 1000 characters, unknown keys refused — against the run and answers
`204`; every call is its own row. It is authorised as the same `run` verb as `interrupt`, and a
session-scoped browser token reaches it only for a run of its own session. Problem codes:
`400 invalid_body`, `400 invalid_run_id`, `404 run_not_found`, `403 token_out_of_scope`,
`503 run_api_not_configured`.

### 5.13 Shares — `aw.shares`

```ts
ShareResource { id, subjectType: 'agent'|'session'|'project'|'skill', subjectId, subjectLabel,
                visibility, mode: 'definition'|'runnable'|null, snapshot, include, budgetCapUsd|null, spentUsd,
                stopped, expiresAt|null, revokedAt|null, suspendedAt|null, createdAt, viewCount?, url? /* public only */ }
PublishShareCommand { subjectType, subjectId, subjectLabel /* until RF-103 */, visibility, mode?, include?, expiry?: '24 h'|'7 days'|'30 days'|'never', passphrase?, budgetCapUsd? }
```

| Operation                          | Route                    | SDK                | Status                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List (mine, or all as Admin/Owner) | `GET /api/shares`        | `list()`           | ✅                                                                                                                                                                                                                                                                             |
| Publish                            | `POST /api/shares`       | `publish(command)` | ⬜ RF-103 — built and tested, but the route still needs a client-authored `subjectLabel` and stores whatever `snapshot`/`transcript`/`definition` it is sent; the SDK sends the options and the label only, so a share it publishes has no content until the server authors it |
| Revoke                             | `DELETE /api/shares/:id` | `revoke(id)`       | ✅                                                                                                                                                                                                                                                                             |

Runnable public links remain compiled off; the SDK exposes `mode: 'runnable'` only as a typed
request the server refuses (`400 invalid_share`). `budgetCapUsd` and `spentUsd` are decimal
strings; `viewCount` is present on list items only; `url` (`/p/<token>`) only when public.
A Builder or Viewer cannot publish an agent or skill share today (the ownership lookup answers
"unknown" for those subjects, so the RBAC layer refuses with `403`). Problem codes:
`400 invalid_share` (any parse failure, public sharing disabled, runnable refused),
`404 share_not_found`, `503 shares_runtime_not_configured`.

### 5.14 Metrics and audit — `aw.observability`

```ts
RunTelemetry { runId, workspaceId, agentId, status: RunStatus, durationMs|null, costUsd: number|null }
AuditEvent  { id, workspaceId, actorUserId|null, actorPrincipalId|null, actorLabel, action: AuditAction, subjectId|null, subjectLabel, createdAt }
```

| Operation          | Route                                  | SDK                                                                                  | Status |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| Recent run metrics | `GET /api/metrics`                     | `metrics.recentRuns()`                                                               | ✅     |
| Audit log          | `GET /api/audit-events?limit=&cursor=` | `audit.list({ limit?, cursor? })` → `{ events, nextCursor }`; `audit.listAll(query)` | ✅     |

Metrics are `{ runs }` in last-observed order from a process-local projection (an LRU of 1 000,
not durable, not newest-first) and `costUsd` is a JSON number (§4). The audit log is `{ events, nextCursor }`
of the raw rows, newest first: there is no `subjectType`, no `details`, and the timestamp is
`createdAt`; `limit` is 1–500 (default 100) and anything else is `400 invalid_limit`, a `cursor`
that is not this list's `nextCursor` for the caller's workspace is `400 invalid_cursor`, both in the
standard envelope (§4), as are its `401 unauthenticated` and `503 rbac_runtime_not_configured`. The audit route goes
through `authorise` (`audit-events` permission, ADR-0075): only an Owner reads the trail, and every
other role answers `403 forbidden`.

### 5.15 Engines — `aw.engines` (issue #319, ENG-02c)

```ts
EngineCapabilities { mcp, skills, resume, fork, interrupt, streamingText, reasoning: boolean,
                     maxTurns: 'native'|'adapter', maxBudget: 'native'|'adapter'|'none',
                     wireProtocols: WireProtocol[] }  // non-empty
EngineDescriptor   { id: EngineId, displayName, version, capabilities, installed }
```

| Operation                       | Route              | SDK      | Status |
| ------------------------------- | ------------------ | -------- | ------ |
| The engines this deployment has | `GET /api/engines` | `list()` | ✅     |

An **engine** is the harness that turns an agent definition and a prompt into model calls, tool
calls and a stream of events — never the _model_ provider, which is `runs.provider` (§1.1,
[ADR-0065](../adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md)). The body is
`{ engines }` like every other list (§4); the SDK unwraps it, so `list()` answers the array. Today
that array is one element, `claude-agent-sdk`, with `wireProtocols: ['anthropic-messages']`.

Read-only, and there is no `GET /api/engines/:id`: the catalogue is short, every field travels in
the list, and an engine is installed by deploying an adapter rather than through the API. The row
is readable by every role and by an API key, because it is the list a caller's next decision is
taken against: `PUT /api/agents/:id/policy` refuses an `engine` this deployment does not register
with `400 unsupported_engine`. A deployment that registers a descriptor
`EngineDescriptorSchema` cannot express answers `500 engine_catalogue_invalid` rather than a
filtered list a caller would read as complete.

### 5.16 Platforms — `aw.platforms` (issue #968, ADR-0133)

```ts
PlatformDescriptor   { id: HostedPlatformId, displayName, docsUrl, capabilities }  // no optionsSchema
PlatformExportTarget { platform: HostedPlatformId, options?: Record<string, unknown> }
PlatformExport       { agentId, version, platform, files: { path, encoding: 'utf8'|'base64', content }[],
                       report: { path, verdict: 'native'|'mapped'|'dropped', code?, note? }[] }
```

| Operation                         | Route                                    | SDK                                                                            | Status |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| The platforms an agent exports to | `GET /api/platforms`                     | `list()`                                                                       | ✅     |
| Export one stored version         | `POST /api/agents/:id/platform-exports`  | `export(agentId, version, target)` → `PlatformExport`                          | ✅     |
| The same files as a tar           | `POST /api/agents/:id/platform-archives` | `exportArchive(agentId, version, target)` → `{ bytes, filename, contentType }` | ✅     |

A **platform** is a place an agent can be published to (ADR-0133). The export compiles one _stored_
version, never the draft, into the files that platform's tooling reads, plus a `PLATFORM_REPORT.md`
and the machine-readable `report`: every field the platform cannot carry is `dropped` with a code,
never silently lost. The version number travels in the body (`{ version, platform, options? }`)
because the route depth is `/api/agents/:id/<sub>` (§3). `POST` is a `write`, so a Viewer answers
`403 forbidden` and a Builder is limited to its own agents, exactly as for `versions`.

Only the root agent, its remote MCP connectors and its skills are resolved today. A connector the
platform cannot reach (stdio, OAuth, or absent from the workspace) and a skill with no `SKILL.md`
come back as `dropped` verdicts. A connector credential is never exported: the file carries the
secret reference `CONNECTOR_<NAME>`. Problem codes: `400 invalid_agent_id`,
`400 invalid_platform_export`, `400 platform_options_invalid`, `404 agent_not_found`,
`404 agent_version_not_found`, `413` for a body over 16 KiB, `422 agent_name_not_portable`,
`422 platform_model_unsupported`, `422 platform_limit_exceeded`, `422 platform_agent_not_found`,
`422 platform_export_too_large` (over 8 MiB), `503 agent_policy_not_configured`.

### 5.17 Webhooks — `aw.webhooks` (N-3, issue #250, ADR-SDK-18-N3-250)

```ts
WebhookEventType = 'run.completed'|'run.failed'|'run.cancelled'
WebhookEndpoint  { id, workspaceId, url, events: WebhookEventType[], createdAt }
CreateWebhookRequest  { url (absolute https, ≤2048 chars, no userinfo or fragment),
                        events? (non-empty, distinct; default all three) }
CreateWebhookResponse { webhook: WebhookEndpoint, secret: 'whsec_…' }   // the only time the secret is returned
WebhookEvent { id, type: WebhookEventType, createdAt, workspaceId,
               data: { run: { id, agentId, sessionId, status, endedAt, error, usage, cost, accountingState } } }
```

| Operation                      | Route                      | SDK                                                                  | Status |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------- | ------ |
| List                           | `GET /api/webhooks`        | `list()` → `{ webhooks }`                                            | ✅     |
| Create (201)                   | `POST /api/webhooks`       | `create({ url, events? })` → `{ webhook, secret }`                   | ✅     |
| Remove (204)                   | `DELETE /api/webhooks/:id` | `remove(id)`                                                         | ✅     |
| Verify a delivery (no request) | —                          | `verifyWebhookSignature({ secret, headers, body })` → `WebhookEvent` | ✅     |

A **webhook** is an endpoint the platform posts a run's outcome to when the run reaches a terminal
status. A workspace holds at most 10, so the list is unpaginated. There is no update: to change a
webhook, remove it and create another. The routes are Owner/Admin (§3.3) and belong to the `runs`
feature (ADR-0160).

- **Signature (Standard Webhooks v1).** Each delivery is a `POST` of the `WebhookEvent` JSON with
  three headers. `webhook-id` is the event `id`, the same on every retry. `webhook-timestamp` is the
  attempt time in Unix seconds, fresh on every attempt. `webhook-signature` is
  `v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>`, where `key` is the base64-decoded part
  of the secret after `whsec_`. The header may list several space-separated signatures, and one
  match suffices. Receivers compare in constant time over the raw body and refuse a timestamp more
  than 5 minutes from their clock. `verifyWebhookSignature` does exactly that with Web Crypto, in
  Node and at the edge, and returns the contract-checked event.
- **Events.** `run.completed`, `run.failed` and `run.cancelled`: one per (webhook, run), for the
  run's terminal transition only. `awaiting_approval` sends nothing. A paused run sends its event
  when the decision finishes it, and its continuation run sends its own. `usage` and `cost` are read
  at the attempt, after waiting up to 2 minutes for `accountingState` to leave `pending`.
  `accountingState` is always present, so a receiver knows whether the numbers are final.
- **Delivery and retry.** Deliveries are written in the same transaction as the run's stop, so a
  terminal run always has its deliveries. A worker that claims them from PostgreSQL sends them; no
  other service is involved. Any `2xx` within 10 seconds counts as delivered, and the event is never
  sent again. Anything else (another status, a timeout, a redirect, a network failure or an egress
  refusal) is retried after 30 s, 2 min, 10 min, 30 min, 2 h, 6 h and 12 h, each with ±20 % jitter.
  That is 8 attempts over about 21 hours, after which the delivery is given up. Delivery is
  at-least-once, so deduplicate on `webhook-id` (or `data.run.id`). Order across runs is not
  guaranteed.
- **Egress.** The platform's egress policy (`packages/core/src/net/egress-policy.ts`, W9-PROV-127)
  checks the URL at create and again on every attempt. It refuses private, loopback, link-local and
  metadata addresses unless the host is on `EGRESS_ALLOW_HOSTS`. It requires HTTPS outside a local
  posture, and it never follows redirects.

Problem codes: `400 invalid_body`, `400 invalid_webhook_url`, `400 webhook_url_refused`,
`400 invalid_webhook_id`, `404 webhook_not_found`, `409 webhook_limit_reached`,
`503 webhook_api_not_configured`. Not part of N-3: a console page, a deliveries list or redeliver
route, and secret rotation.

---

## 6. Runtime neutrality

The product is a control plane for agents, and which engine runs an agent is a choice behind one
port ([ADR-0065](../adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md)); spec §5
keeps the platform thin around it, with the Claude Agent SDK as the reference engine. Neutrality
therefore does not mean abstracting the engine away, and it does not mean pretending every engine
is the same. It means **a portable core every engine honours or refuses by name, plus an
engine-native arm for everything else, so a second engine is added without renaming the first.**

### 6.1 What is portable and what is provider-native

"Portable with refusal" is the rule of ADR-0065 D3 and D4: an engine honours the requirement
exactly, or the platform refuses the configuration with a typed error naming the missing
capability (`422 engine_capability_unsupported`). It is never silently dropped.

| Concept                  | Portable (workspace-owned)                                                                                                                                                                                   | Engine-native (the policy arm for `engine: 'claude-agent-sdk'`) |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Agent identity and prose | `name`, `instructions`, `permissions` (the four human checkboxes), owner                                                                                                                                     | —                                                               |
| Model                    | `(modelConnectionId, model)`                                                                                                                                                                                 | model id strings are the model provider's                       |
| Runtime placement        | runtime profile, driver, network/filesystem policy                                                                                                                                                           | —                                                               |
| Resources                | files, connectors (MCP is an open protocol), assignments, skills (a `SKILL.md` directory is the Agent Skills format, which pi, Mastra and the OpenAI `SandboxAgent` also read — portable with refusal, §5.7) | where a skill is materialised inside the sandbox                |
| Execution policy         | `limits` (`maxTurns`, `maxBudgetUsd`)                                                                                                                                                                        | `tools` (`claude_code_preset`, `permissionMode`, …)             |
| Session identity         | `Session.id`                                                                                                                                                                                                 | `providerSessionId` (today `claudeSessionId`)                   |
| Events                   | `run-status`, `run-failed`, `stream-reset`, `done`, and the closed `agent.*` frame set (§6.3)                                                                                                                | the engine-native message, capped, in every frame's `raw`       |
| Transcript               | the resource and its keys                                                                                                                                                                                    | the JSONL line format                                           |
| Usage and cost           | gateway-metered (`run_usage_records`) for every engine — ADR-0065 D6                                                                                                                                         | the engine's own self-reported usage, informational only        |

### 6.2 `AgentDefinition` — the portable export

```ts
AgentDefinition {                                   // file: agent.json, one agent per file
  apiVersion: 'agentworkspace.dev/v1',              // the file format's version, not a package's
  kind: 'AgentDefinition',
  agent: { name, instructions, permissions, model: string|null,
           modelConnectionName: string|null, runtimeProfileName: string|null },
  policy: AgentPolicy,                              // §5.9 verbatim: { engine, tools, skills, limits }
  policySource: 'stored' | 'compiled',              // default 'stored'; import PUTs only a stored one
  resources: { files: [{ path, access }], skills: [name], connectors: [name] }, // by name, not id
}
```

`aw.agents.export(id)` builds it from §5.9/§5.7/§5.8 and the model-connection, runtime-profile and
files reads; `aw.agents.import(def, { onMissing: 'fail' | 'skip' })` resolves every name inside the
target workspace, refuses ambiguity, and never carries credentials or skill bytes. It is a client
composition — no route answers it — so the SDK raises its refusals itself, in the one error
envelope (`AGENT_DEFINITION_PROBLEM_CODES`): `400 invalid_agent_definition`,
`400 unsupported_engine`, `409 agent_definition_reference_ambiguous`,
`422 agent_definition_references_missing`, and on export
`409 agent_definition_reference_unresolvable`; `details` is `<kind>:<name>` for missing and
ambiguous names, `<kind>:<source id>` for an unresolvable one, the engine id, or one entry per parse
issue. Nothing is written until every name resolves, and an agent whose policy the server then
refuses — or whose import is aborted — is removed again; if that removal fails too, the refusal
carries `agent:<id>` in `details` (`409 agent_definition_import_incomplete` for a failure that was
not a problem). A policy the source never stored (`GET …/policy` answers `source: 'compiled'`, an
additive field of `AgentPolicyResponseSchema`) is not `PUT`: it stays compiled in the destination.
Run grants are not carried (they name principals of one workspace). Bundling skill
directories into the file is deliberately absent: a skill moves by `skills.export`/`import`, and
a revision pin travels as `resources.skillRevisions` (skill name → revision number; absent means
latest, and a pin is dropped with its skill under `onMissing: 'skip'`). [ADR-0076](../adr/0076-the-agent-definition-is-a-versioned-name-keyed-file-with-no-secrets.md)
records the format. This is the unit a customer moves between workspaces or environments, the
per-resource file workspace-as-code (developer-platform Phase 2) builds on, and the same shape
share publication (§5.13) snapshots server-side after RF-103.

### 6.3 The neutral event vocabulary

Normalisation happens **once, in the runner, by the engine's adapter**
([ADR-0065](../adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md) D5), not in each
client. `packages/contracts/src/run-events.ts` defines a closed set of `agent.*` frames; the runner
emits them, the control plane serves them, and the UI, the SDK, `aw` and webhooks (#250) all read the
same thing. ✅

```ts
AGENT_FRAME_NAMES = ['agent.session', 'agent.message', 'agent.message.delta', 'agent.tool.call',
                     'agent.tool.result', 'agent.usage', 'agent.result', 'agent.native',
                     'agent.malformed']

AgentFrame =                                             // every arm also carries { engine, raw }
  | { frame: 'agent.session',       engineSessionId, model|null }
  | { frame: 'agent.message',       messageId|null, role: 'assistant'|'user', blocks }
  | { frame: 'agent.message.delta', messageId|null, block: 'text'|'reasoning', text }
  | { frame: 'agent.tool.call',     toolCallId, name, kind: AgentToolKind, input }
  | { frame: 'agent.tool.result',   toolCallId, status: 'completed'|'failed', output, isError }
  | { frame: 'agent.usage',         inputTokens, outputTokens, cacheReadInputTokens|null,
                                    cacheCreationInputTokens|null, reasoningTokens|null }
  | { frame: 'agent.result',        stopReason: AgentStopReason, turns|null, engineCostUsd|null }
  | { frame: 'agent.native',        type, payload }
  | { frame: 'agent.malformed',     reason }

AGENT_TOOL_KINDS   = ['read','edit','delete','move','search','execute','fetch','mcp','other']
AGENT_STOP_REASONS = ['end_turn','max_turns','max_budget','refusal','cancelled','error']
```

`blocks` is `({ type: 'text', text } | { type: 'reasoning', text })[]`. Tool use is **not** a block:
it is its own frame, so a consumer renders a call without walking a message's content.

The kinds and the stop reasons are the Agent Client Protocol's
([tool calls](https://agentclientprotocol.com/protocol/tool-calls),
[prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)), so ENG-11's generic ACP adapter
maps one-to-one instead of translating twice.

Five properties this vocabulary is designed around:

- **The set is closed.** An adapter that meets something it cannot express emits `agent.native` —
  the engine's own message, uninterpreted and never dropped — rather than inventing a name. So the
  set grows by an amendment to the contract, never by a runtime deciding to send something new, and
  a future engine message cannot collide with a control-frame name.
- **`agent.malformed` is not `agent.native`.** The first is "not well formed, reported by name", the
  second "well formed, no neutral meaning, forwarded". It keeps the guarantee the old `malformed`
  relayed name made (ADR-0015).
- **`raw` keeps the engine's words**, capped at `AGENT_FRAME_RAW_MAX_BYTES` (64 KiB). `raw` is the
  one field a tenant's agent controls the size of, so a payload over the cap is **truncated with a
  marker** (`AgentFrameRawTruncationSchema`) and never rejected: dropping the frame would lose the
  neutral fields, which are the part a consumer renders.
- **Every frame of a message carries its `raw`**, not only the first. The cost is stated: one
  engine message that fans out into _n_ frames is _n_ `run_events` rows each holding the capped
  message (up to _n_ × 64 KiB), `agent.native` carries the same value as `payload` and `raw`, and
  `DEFAULT_MAX_EVENTS_PER_RUN` now counts frames rather than engine messages, so a tool-heavy run
  reaches retention sooner. The alternative — `raw` on the first frame only — would make `raw` an
  escape hatch that works only sometimes: a frame is read on its own (a client that resumed inside a
  message, one that reads only `agent.result`, the result's accounting checked against its source),
  and a frame carries no link to the sibling that held the message. The cap bounds each copy.
- **`agent.usage` is informational.** Billing is gateway-metered in `run_usage_records`
  (ADR-0065 D6). A counter an engine does not report is `null`, never `0`.
- **`agent.result` is the engine's turn, `run.status` is the platform's run.** A turn that ended
  `end_turn` inside a run the platform then failed to record is not a completed run.

`packages/core`'s `toAgentFrames(event: ClassifiedSdkEvent): readonly AgentFrame[]` is the Claude
adapter's mapping — the one place the Claude vocabulary is read, moved into
`packages/engine-claude-agent-sdk` by ENG-04. `ClassifiedSdkEvent` is its input type and names
nothing on the wire. It never returns an empty list.

The SDK side is a **parser**: `toAgentEvent(frame: RunEventFrame): AgentEvent | null` validates
`frame.data` against `AgentFrameSchema` and answers the typed frame, `null` for the platform's own
frames, and a `ContractViolationError` for a payload that does not satisfy its contract. `AgentEvent`
_is_ the frame; there is no engine knowledge in `packages/sdk`, and a second engine adds none.
`assistantResponseFromAgentEvent` is the assistant-message arm the browser's run view calls.

**Legacy frames are upgraded on read.** `run_events` rows recorded before ENG-03 hold the old
relayed names (`RELAYED_EVENT_NAMES`) around a Claude Agent SDK message. The event-read path passes
each one through the same `classifySdkEvent` → `toAgentFrames` pair a live run goes through, so
replaying an old run yields the same `AgentEvent` sequence as a fresh run of the same messages.
There is **no data migration**: the mapping is a pure function of the stored message, so re-deriving
it on read cannot drift, while a one-time rewrite would freeze whatever the mapping looked like on
the day it ran — and the stored message is the engine's own words, which is what `raw` is for. One
row may map to several frames; they are served under the row's sequence with a `.<sub-index>` suffix
(§5.12), and a `Last-Event-ID` naming one of them re-reads the row and drops what the client already
has, so resume neither loses a frame nor repeats one.

### 6.4 Adding a provider (the contract a second engine must satisfy)

[ADR-0065](../adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md) is the normative
record: an engine is an extension point behind one port, the platform owns the port and refuses to
own an agent loop, a tool executor, a memory system or prompt templates, and a capability an
engine lacks is a typed refusal rather than an emulation. The work is tracked as eleven units on
[#299](https://github.com/indxjp/agent-workspace/issues/299), and those units — not the
four steps this section used to list — are the contract:

| Unit   | Issue | What it adds                                                                                                                                                       |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ENG-01 | #300  | ADR-0065 and this amendment. Documents and the Lean model only.                                                                                                    |
| ENG-02 | #301  | Engine identity on the wire and in storage: `policy.engine`, `sessions.engine`, `engine_session_id`, `runs.engine`, `GET /api/engines`, SDK and `aw`. Before #246. |
| ENG-03 | #302  | The neutral `agent.*` event stream, normalised in the runner; `AgentEvent` becomes a parser. Before #246.                                                          |
| ENG-04 | #303  | `packages/engine` (the port), the runner registry, the Claude Agent SDK extracted into `packages/engine-claude-agent-sdk`, and the conformance kit.                |
| ENG-05 | #304  | Gateway ingress for OpenAI Responses and Chat Completions, metered per protocol.                                                                                   |
| ENG-06 | #305  | The engine-scoped session state store that generalises `session_transcripts`.                                                                                      |
| ENG-07 | #306  | One runtime image per engine; drivers pick the image by engine.                                                                                                    |
| ENG-09 | #308  | The OpenAI Agents SDK as `packages/engine-openai-agents` — the second engine (§6.5). ✅                                                                            |
| ENG-08 | #307  | The pi coding agent as `packages/engine-pi` — the third engine (§6.6). ✅                                                                                          |
| ENG-10 | #309  | Mastra as `packages/engine-mastra` — the fourth engine (§6.7). ✅                                                                                                  |
| ENG-11 | #310  | The remaining engine: a generic ACP adapter.                                                                                                                       |

Nothing in §5 changes shape for a second engine; that is still the test of this section, and
ENG-09 passed it — the second engine added a policy arm and a registry row, and no resource shape.
ENG-08 passed it the same way for the third, and ENG-10 for the fourth.

### 6.5 The `openai-agents` arm

[ADR-0074](../adr/0074-the-openai-agents-sdk-runs-a-plain-agent-behind-the-port.md) records the
engine. Its policy arm carries two engine-native model settings, the switches it withholds, and no
tool grammar:

```ts
AgentPolicy (engine: 'openai-agents') {
  engine: 'openai-agents',
  skills: AgentSkillPolicy,                       // portable; see the refusal below
  limits: { maxTurns: number|null, maxBudgetUsd: number|null },
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',   // modelSettings.reasoning.effort
  parallelToolCalls?: boolean,                               // modelSettings.parallelToolCalls
  withheldPermissions?: AgentPermissionKey[],                // switches turned off whatever the checkbox says
}
```

**An engine switch carries the narrowing across** (ADR-0074 D12). When a `PUT
/api/agents/:id/policy` changes `engine`, the server runs the contracts'
`translatePolicyForEngineSwitch` against the stored arm and stores the translated policy, which the
`200` body shows. From `claude-agent-sdk`: a `tools.deny` of `Read`/`Glob`/`Grep` withholds
`readFiles`, of `Write`/`Edit`/`NotebookEdit` withholds `writeFiles`, of `Bash`/`BashOutput`/`KillShell`
withholds `runCommands` (a scoped rule withholds the whole switch); a `base` list missing a switch's
tools, `permissionMode: 'plan'` (writes and commands) and `permissionMode: 'dontAsk'` (whatever
`autoApprove` does not name) withhold those switches; a denial of a tool this engine lacks
(`WebFetch`, …) stays absent. A denial of an MCP tool, an MCP glob or a wildcard cannot be expressed
and is refused **`422 engine_switch_would_widen`**, `details` naming each rule; nothing is stored.
Back to `claude-agent-sdk`, each withheld switch's Claude tools are added to `tools.deny`. A `PUT` on
the same engine is a replacement and is not translated.

| Portable requirement  | On `openai-agents`                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions`         | `readFiles` → `read_file`, `list_files`, `search_files`; `writeFiles` → `apply_patch`; `runCommands` → `shell` (withheld while a read-only grant exists); `unrestrictedNetwork` → no tool of its own (remote HTTP/SSE connectors are allowed without it, as on Claude). All are SDK function tools backed by the adapter's own executors in the container. |
| File grants           | enforced by the adapter's Editor through `packages/engine`'s path-grant rule                                                                                                                                                                                                                                                                               |
| Connectors            | stdio, streamable HTTP, SSE; a tool whose policy asks for an approval is refused (no HITL)                                                                                                                                                                                                                                                                 |
| Skills                | refused — `skills: false`, `422 engine_capability_unsupported`                                                                                                                                                                                                                                                                                             |
| `limits.maxTurns`     | the SDK's native `maxTurns`; `agent.result { stopReason: 'max_turns' }`                                                                                                                                                                                                                                                                                    |
| `limits.maxBudgetUsd` | provisional `maxBudget: 'adapter'` — stops `max_budget`; an unpriced model is refused (#342)                                                                                                                                                                                                                                                               |
| Fork                  | refused — `fork: false`                                                                                                                                                                                                                                                                                                                                    |
| Model connection      | Responses (or Chat Completions, which no connection field selects yet) for OpenAI-family connections; Anthropic Messages through the SDK's AI SDK adapter for Anthropic-family ones; always the gateway, with the run token as `Authorization: Bearer`                                                                                                     |

Vendor-hosted tools are never compiled, and the SDK's tracing export is always off. Session items
are stored in the engine-scoped session store (ADR-0071), keyed by the platform session id.

### 6.6 The `pi` arm

[ADR-0081](../adr/0081-pi-runs-in-process-with-a-pinned-loader-behind-the-port.md) records the
engine: the pi coding agent (`@earendil-works/pi-coding-agent`, pinned at 1.1.0), run in process
and configured, never patched. Its policy arm carries one engine-native model setting, the switches
it withholds, and no tool grammar:

```ts
AgentPolicy (engine: 'pi') {
  engine: 'pi',
  skills: AgentSkillPolicy,                       // portable; placed at .pi/skills/<name>/
  limits: { maxTurns: number|null, maxBudgetUsd: number|null },
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high',
  withheldPermissions?: AgentPermissionKey[],     // switches turned off whatever the checkbox says
}
```

**An engine switch carries the narrowing across** exactly as for `openai-agents` (§6.5): from
`claude-agent-sdk`, the same denials, `permissionMode: 'plan'` and `permissionMode: 'dontAsk'`
become `withheldPermissions` (naming pi's tools in the translation), and an inexpressible denial is
refused `422 engine_switch_would_widen`; back to `claude-agent-sdk`, each withheld switch's Claude
tools are added to `tools.deny`. Between `openai-agents` and `pi`, `withheldPermissions` is carried
verbatim. `policyNarrowedPermissions` applies the `pi` arm's `withheldPermissions` as it does the
`openai-agents` arm's.

| Portable requirement  | On `pi`                                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions`         | `readFiles` → `read`; `writeFiles` → `write`, `edit`; `runCommands` → `bash` (withheld while a read-only grant exists; runs with the request's environment, not the runner's); `unrestrictedNetwork` → no tool. All are pi's own built-in tools, selected through pi's `tools` allowlist. |
| File grants           | enforced by the adapter's guard in pi-agent-core's `beforeToolCall`: a tool the plan does not offer, a read outside the workspace, and a write or edit into a read-only grant or `.pi` (including `..` and symbolic links) are blocked                                                    |
| Connectors            | refused — `mcp: false`, `422 engine_capability_unsupported` with `capability: 'mcp'`                                                                                                                                                                                                      |
| Skills                | the platform-placed skills under `.pi/skills/<name>/`, through a pinned resource loader                                                                                                                                                                                                   |
| `limits.maxTurns`     | `maxTurns: 'adapter'` — counted on `turn_end`, stopped with pi-agent-core's `terminate` hint; `agent.result { stopReason: 'max_turns' }`                                                                                                                                                  |
| `limits.maxBudgetUsd` | provisional `maxBudget: 'adapter'` — priced from the shared provisional table (`packages/engine/src/prices.ts`), stops `max_budget`; an unpriced model is refused (#342)                                                                                                                  |
| Fork                  | `fork: true` — the parent's stream is copied under a new header naming the parent                                                                                                                                                                                                         |
| Model connection      | Anthropic Messages only (an OpenAI-family connection is refused); always the gateway, with the run token as the model's `Authorization: Bearer` header and a public placeholder as pi's `x-api-key` — the gateway is unchanged                                                            |

The pinned resource loader gives pi only the platform-placed skills and the agent's instructions
(appended to pi's own system prompt); nothing is loaded from `~/.pi`, `~/.agents` or project
discovery (`AGENTS.md`, `.agents/skills`, `.pi/extensions`). `.pi` is the adapter's protected
configuration directory. pi's JSONL session tree is stored in the engine-scoped session store as one
stream per session, one entry per JSONL line keyed by the pi entry `id`; `engineSessionId` is the
platform session id.

### 6.7 The `mastra` arm

[ADR-0084](../adr/0084-mastra-runs-a-plain-agent-with-memory-over-the-platform-store.md) records the
engine: a plain Mastra `Agent` (`@mastra/core`, pinned at 1.71.0) over a `Workspace`, run in
process, with MCP through `@mastra/mcp` and memory through `@mastra/memory` over the platform's
store. Its policy arm carries one engine-native setting, the switches it withholds, and no tool
grammar and no memory option:

```ts
AgentPolicy (engine: 'mastra') {
  engine: 'mastra',
  skills: AgentSkillPolicy,                       // portable; placed at .mastra/skills/<name>/
  limits: { maxTurns: number|null, maxBudgetUsd: number|null },
  toolCallConcurrency?: number,                   // 1–16; Mastra's own default when absent
  withheldPermissions?: AgentPermissionKey[],     // switches turned off whatever the checkbox says
}
```

**An engine switch carries the narrowing across** exactly as for `openai-agents` and `pi`
(§6.5, §6.6), naming Mastra's workspace tools in the translation; between `openai-agents`, `pi` and
`mastra`, `withheldPermissions` is carried verbatim.

| Portable requirement  | On `mastra`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions`         | `readFiles` → `read_file`, `list_files`, `grep`, `file_stat`; `writeFiles` → `write_file`, `edit_file`, `mkdir`, `delete`; `runCommands` → `execute_command` and the process tools (withheld while a read-only grant exists; `LocalSandbox` runs with the request's environment, not the runner's); `unrestrictedNetwork` → no tool. All are Mastra's own workspace tools (`mastra_workspace_`-prefixed); every other workspace tool is disabled. |
| File grants           | enforced by wrapping the workspace's `LocalFilesystem`: a write, delete, copy, move or mkdir into a read-only grant or `.mastra`, through `~`, outside the workspace (including `..` and symbolic links) is refused                                                                                                                                                                                                                               |
| Connectors            | `MCPClient` servers (stdio with the request's environment only; HTTP confined to its host); their tools are `agent.tool.call {kind: 'mcp'}`; a tool whose policy asks for an approval is refused `422 engine_capability_unsupported`                                                                                                                                                                                                              |
| Skills                | the platform-placed skills under `.mastra/skills/<name>/`, as workspace skills (`skill`, `skill_search`, `skill_read`)                                                                                                                                                                                                                                                                                                                            |
| `limits.maxTurns`     | `maxTurns: 'native'` — Mastra's `maxSteps`; a run cut short ends `agent.result { stopReason: 'max_turns' }`                                                                                                                                                                                                                                                                                                                                       |
| `limits.maxBudgetUsd` | provisional `maxBudget: 'adapter'` — priced per step from the shared provisional table, stops `max_budget`; an unpriced model is refused (#342)                                                                                                                                                                                                                                                                                                   |
| Fork                  | refused — `fork: false`; a Mastra thread is continued, not branched                                                                                                                                                                                                                                                                                                                                                                               |
| Model connection      | Anthropic Messages, OpenAI Responses or Chat Completions — each connection in its own dialect, through an explicit AI SDK provider at the gateway with the run token as `Authorization: Bearer`; never a `"provider/model"` string                                                                                                                                                                                                                |

Memory is a Mastra thread whose id is the platform session id (`engineSessionId`) and whose
resource is the tenant namespace. It lives in the engine-scoped session store as one stream per
thread, one entry per thread or message record keyed `thread` / `message:<id>`; the sandbox holds no
database credential, and a request whose environment carries one is refused. Semantic recall,
working memory and title generation are off; Mastra's telemetry and every observability exporter
are off; no `Mastra` instance, server, `Harness` or wrapper of another engine is used.

---

## 7. CLI — `aw`

A thin, scriptable client over the SDK, in a new package `packages/aw` (binary `aw`), separate
from `packages/cli` (`agent-workspace`, the deployment generator) because the two have different
dependencies and audiences.

### 7.1 Configuration

| Source (highest first) | Keys                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flags                  | `--url`, `--api-key-stdin`, `--profile`, `--json`, `--quiet`, `--timeout`; a profile named with `--profile` is a flag, so its `url` and key rank here                                                                                                     |
| Environment            | `AGENT_WORKSPACE_URL`, `AGENT_WORKSPACE_API_KEY`                                                                                                                                                                                                          |
| Project file           | `agent-workspace.yaml` in the current directory, URL only: a v2 file names `http://127.0.0.1:<environments.local.port>` (3000 when it names no port), a lifted v1 file names nothing, a file the schema refuses is a usage error with its line and column |
| Default profile        | the implicit `default` entry of `~/.config/agent-workspace/profiles.json` `{ "<name>": { url, apiKeyRef } }` — the key itself in the env var named by `apiKeyRef` (an OS keychain reference is a follow-up), never in the file                            |

The URL and the key are resolved independently. The URL is `--url`, then the profile named by
`--profile`, then `AGENT_WORKSPACE_URL`, then the project file, then the `default` profile. The key
is stdin alone when `--api-key-stdin` is present; otherwise the named profile's key, then
`AGENT_WORKSPACE_API_KEY`, then the `default` profile's key — only when the resolved URL is that
profile's own URL, so it never travels to another `--url`. With no key from those (including a
blank stdin), the stored sign-in for the resolved URL is the credential. When the URL came from the
project file, only `--api-key-stdin` or the stored sign-in counts: `AGENT_WORKSPACE_API_KEY` and
profile keys were configured for another control plane and are never sent to the project's local
port
([ADR-0109](../adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md)
step 5, `resolveConfig` in `packages/aw/src/config.ts`).

A key is never accepted as a flag value (it would land in shell history); `--api-key-stdin`
reads it once.

With no key from any of those sources, the credential is the person's own sign-in (issue #242,
ADR-0083): `aw login` runs an OAuth 2.0 device authorization grant (RFC 8628) — `POST
/api/auth/cli-device` answers a signed device code and a user code, the person approves the code
at `/api/auth/cli-verify` in a browser where they are signed in, and `POST /api/auth/cli-token`
answers `authorization_pending`/`slow_down`/`access_denied`/`expired_token`/`invalid_grant`
until it issues a `awu_live_…` user token, once. The approval requires confirming that the code
shown is the one the terminal printed (RFC 8628 §5.4), and the start, poll and approval routes are
rate-limited per client (`429 rate_limited`). The token is admitted only on the person-facing
routes (`/api/me`, `/api/workspaces/**`, `/api/invitations/**`, `/api/sharing-policies/**` and
the two `/api/auth/cli-*` routes that end or move it). It lives twelve hours, is stored owner-only
(`0600`, in a `0700` directory) in `~/.config/agent-workspace/credentials.json` keyed by control
plane URL, and is never printed, logged or accepted as a flag. `aw logout` revokes it server-side (`DELETE
/api/auth/cli-token`); `aw workspaces select` moves it to another of the person's workspaces
(`POST /api/auth/cli-workspace`). A configured key always wins over the sign-in.

### 7.2 Command tree (mirrors §5 one-to-one)

```text
aw me
aw login|logout|whoami                                             # issue #242 (S-22): a person, through the device flow (ADR-0083)
aw workspaces list|get|create|update|select                        # a person only (after aw login); refused for an API key (§3.2)
aw workspaces sharing-policy get|set
aw team members list|add|set-role|remove
aw team users list|create
aw team invitations list|create|resend|revoke                      # a person only (after aw login); accept is browser-only (§5.2)
aw team api-keys list|create|revoke
aw tokens mint --scope run|session --id <id> [--ttl <seconds>]     # issue #236; no command for the workspace switch (session-only)
aw models connections list|get|create|update|remove|rotate-credential|test
aw models discover
aw runtimes profiles list|get|create|update|remove
aw runtimes connections list|create
aw runtimes detect|test <driver>                                   # S-9, S-4
aw secrets list|create|replace|remove
aw files list|upload [--direct]|mkdir|download|move|remove          # --direct: presigned PUT, bytes go to the object store
aw skills list|get|import <dir>|export <name> <dir>|update|enable|disable|remove
aw connectors list|get|create|update|remove|rotate-credential|test|test-draft
aw engines list                                                                    # issue #319; read-only, an engine is installed by deploying an adapter
aw agents list|get|create|update|remove|assignments get|set|policy get|set|export|import|archive|restore
aw agents create|update --engine <id>                                              # issue #319; sets policy.engine, refused before anything is written when the deployment does not register it (S-23)
aw projects list|get|create|update|archive|restore|start-session|adopt-session
aw sessions list|get|rename|archive|restore|transcript|subkeys
aw runs start <agent> --prompt|--prompt-file [--session] [--model <conn>:<model>] [--wait|--follow]
aw runs start … --idempotency-key <key>                            # S-6 (#250): sends the SDK's idempotencyKey; a blank key is a usage error
aw runs get|list|events|follow|wait|interrupt
aw webhooks list|create --webhook-url <url> [--event <type>]…|remove <id>   # N-3 (#250): create prints the secret once; --url stays the control plane's
aw shares list|publish|revoke                                       # publish: RF-103
aw metrics recent-runs
aw audit list
```

A command exists only for a ✅ row of §5 that the CLI's own credential can reach; the annotated
ones are absent from the binary until their server change lands (no "not implemented" stubs).
The CLI holds an API key or, after `aw login`, a person's short-lived user token (§7.1, issue #242,
ADR-0083); the rows a key is refused on run with the user token.

### 7.3 Behaviour

- Output: a table by default. `aw runs start` prints the run resource, omitting the HTTP start
  envelope's `events` path. `--json` prints that command result; `--jsonl` prints stream items.
  `follow` prints `AgentEvent`s, while `--raw` prints frames and takes precedence over `--json`.
  `--quiet` suppresses notices, including the start notice when waiting or following.
- Exit codes: `0` success; `1` `ApiProblemError` (code printed on stderr as `error: <code>: <message>`;
  a `426 contracts_version_unsupported` prints both contracts versions and the `npm install` that
  fixes it);
  `2` usage; `3` `ContractViolationError`; `4` `TransportError`; `130` interrupted — and
  `aw runs follow --interrupt-on-cancel` also stops the run itself on the way out. A resolved
  `runs wait` result currently exits 0 even when the run status is `failed` or `cancelled`; that
  status is part of the printed record.
- Inputs for create/update come from `--file <json>` or `-` (stdin), validated by the contracts
  before sending; field flags exist only for the handful of scalar fields (`--name`, `--role`).
  `--prompt-file -` reads a run prompt from stdin; combining it with another stdin-consuming
  option is a usage error, although the current message does not name that flag explicitly.
- A command takes the global flags and the flags its usage line names, nothing else: any other
  flag exits `2` with that usage line (`aw runs list --all` is refused, not answered with one page).
- No interactive prompts unless a TTY and no `--json`; never prompts for a credential in CI.
- `aw --version` prints `aw <version> (contracts <version>)` and touches neither the configuration
  nor the network.

---

## 8. Server changes this specification requires

Ordered by how much SDK surface they unblock. None is required for §5's ✅ rows.

| ID   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Unblocks                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-4  | `POST /api/runtimes/test` uses the standard envelope (today `{ error: '<code>', message }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | runtime testing without a special case                                                                                                                               |
| S-9  | Move `GET /api/setup/runtime-detect` to `GET /api/runtimes/detect` (keep the old path during a release)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | runtime discovery outside setup                                                                                                                                      |
| S-11 | `HEAD`/`?metadata=true` on `GET /api/files/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `files.stat`                                                                                                                                                         |
| S-19 | `PATCH /api/runtime-profiles/:id` accepts `null` for the nullable sizing fields and `runtimeConnectionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | clearing a profile field                                                                                                                                             |
| S-24 | `agent.message.delta` on a Claude run: enabling the Claude Agent SDK's `includePartialMessages` and mapping its `stream_event` messages onto the delta frame (today they reach `agent.native`)                                                                                                                                                                                                                                                                                                                                                                                            | assistant text arriving as deltas rather than whole messages on the reference engine                                                                                 |
| S-23 | A policy request shape that carries an `engine` the _contracts_ do not publish, so a client can ask a deployment for an engine it has not shipped a contract arm for and be refused by the server                                                                                                                                                                                                                                                                                                                                                                                         | `aw agents create\|update --engine <unpublished id>` reaching `400 unsupported_engine` from the route instead of the CLI's own pre-flight against `GET /api/engines` |

Also required, and already owned by the refactoring programme: RF-101 ✅ (principals), RF-103
(server-owned share snapshots), RF-201 (agent archive),
RF-202/203 (offboarding, invitation acceptance), RF-204 (typed credential ownership), RF-301
(run leases; its idempotency key landed as S-6, §5.12), RF-304 (durable storage operations).

---

## 9. How the specification is proven

A row of §5 moves from ⬜ to ✅ only when all four hold:

1. **Contract** — the schema exists in `@indx-workspace/contracts` with valid, invalid,
   unknown-key, missing-field and bound cases tested.
2. **Conformance** — `apps/web/server/sdk-conformance.test.ts` proves the server's real
   serializer (or parser, for requests) satisfies the schema.
3. **Client** — the `@indx-workspace/sdk` method exists, is tested against a recording `fetch`
   double for the success path, each documented problem code, a contract violation and an abort.
4. **Consumption** — at least one caller in `apps/web` (or the CLI) uses the method instead of a
   private parser, so the contract has a consumer.

The whole surface is complete when every route in `apps/web/app/api/**` (except §1's
exclusions) appears in §5 as ✅, `tests/route-inventory.test.ts`'s declared routes equal the set
this document lists, and the CLI's command tree covers every SDK method.
