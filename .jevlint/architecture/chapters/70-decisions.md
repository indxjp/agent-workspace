---
title: Decisions
evidence: [docs/adr/0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md, docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md, docs/adr/0153-object-storage-one-key-layout-catalog-first-writes-references-not-bytes.md, docs/adr/0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md, docs/adr/0151-a-stopped-run-holds-no-lease-and-run-start-is-idempotent.md, apps/web/server/contexts.json, commit:65dde8faf, commit:21932f40f, commit:754f81e5d, commit:a75871d09]
---

### The SDK is contracts-first and the application is its first consumer (ADR-0052)

- **Context:** `/api/**` contracts lived as hand-written parsers inside server domains, so nothing
  outside the repository could validate against them.
- **Decision:** `contracts` publishes Zod schemas and depends on `zod` alone; `sdk` depends only on
  `contracts`. A domain enters the SDK only after a conformance test proves the server's real
  serializers satisfy the schema, and `apps/web/contracts` re-exports rather than copies.
- **Consequences:** browser screens reach the server only through the SDK; a wire change is a
  versioned, reported change.
- **Alternatives:** generating the client from OpenAPI (no document existed, and it would lack the
  stream follower); publishing `apps/web/contracts` directly (breaks "packages never import apps");
  moving every domain at once (would freeze open defects into a public surface).

### An agent's engine is an extension point behind one port (ADR-0065)

- **Context:** every agent ran on the Claude Agent SDK, imported from one runner file; the Owner
  decided on 2026-09-26 to accept other engines.
- **Decision:** the platform owns the `AgentEngine` port in `packages/engine`; each engine is a
  `packages/engine-<id>` adapter with one SDK file, reached by the runner only through
  `apps/runner/src/engines.ts`. "Provider" keeps meaning the model provider; the harness is the
  "engine".
- **Consequences:** four adapters exist (Claude Agent SDK, OpenAI Agents, Mastra, pi); the control
  plane knows engines only by id.
- **Alternatives:** keeping the Claude SDK as the only runtime, which the earlier spec required and
  this ADR reversed.

### Object storage: one key layout, catalog-first writes, references not bytes (ADR-0153)

- **Context:** three object roots, path-as-key renames, rows written after objects under an
  in-process lock, and granted files base64-encoded into the `/run` body.
- **Decision:** one object store and key layout with immutable object ids, row-first saves, a
  streaming `ObjectStore` port in `packages/core/src/storage`, and runs that receive references and
  one streamed archive.
- **Consequences:** a rename touches one row; a crash leaves only rows the cleanup job can see.
- **Alternatives:** a new `packages/storage`, path-as-key, object-first writes, and a
  maintenance-window migration were all rejected.

### The local runtime is one bundled package that aw dev forks (ADR-0109)

- **Context:** `aw dev` must run control plane, gateway and runner in one process from a generated
  project, but the server was not installable.
- **Decision:** `@indx-workspace/embedded` bundles them over embedded PostgreSQL; nothing imports it.
- **Consequences:** `embedded` is the only component allowed to depend on almost everything.
- **Alternatives:** bundling the server into `aw` or the CLI, an all-in-one container image,
  downloading the runtime on first run, and publishing core, gateway, runner and web separately.

### The server is split into bounded contexts with public entries (refactoring plan part 04)

- **Context:** `apps/web/server` grew to dozens of domain folders importing each other freely.
- **Decision:** `contexts.json` groups the folders into contexts listed upstream first, a shared
  kernel and the composition root; dependency-cruiser builds one direction rule and one entry rule
  per context from the data (commits `21932f40f` for identity, `65dde8faf` for execution).
- **Consequences:** the existing contrary imports became baselines that can only shrink; moving a
  folder between contexts is a one-line data change.
- **Alternatives:** not recorded in the commits or the architecture document; splitting the server
  into packages is not discussed there.

### RBAC's rules are pure and live in rbac/core (commit 754f81e5d)

- **Context:** roles, scopes, the permission table and the decision were mixed with path
  classification and I/O.
- **Decision:** move them into `apps/web/server/rbac/core/` under both purity checks; `rbac/decide.ts`
  classifies the path and passes the verdict in.
- **Consequences:** the authorisation rules can be tested and checked against the formal model
  without a server. Alternatives are not recorded.

### Run start is idempotent and a stopped run holds no lease (ADR-0151)

- **Decision:** ratify `awaiting_approval` as a stopped, lease-free status and keep `waiting` and
  `suspended` out; a start replay with the same key and request hash returns the original run.
- **Alternatives:** the ADR's other options, including persisting a live waiting state, which it
  rejects because it creates recovery obligations with no producer.

### A public share link is shown once and stored only as a hash (commit a75871d09)

- **Decision:** `POST /api/shares` returns the token once; the server keeps its SHA-256, migrated
  expand-only (migration 0105) with a trigger for rolling updates.
- **Consequences:** a lost link cannot be shown again; `aw shares list` has no URL column.
  Alternatives are not recorded.
