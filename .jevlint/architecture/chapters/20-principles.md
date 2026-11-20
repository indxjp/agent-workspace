---
title: Design principles
evidence: [AGENTS.md, ENGINEERING_GUIDELINES.md, docs/architecture.md:398-448, docs/adr/0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md, packages/core/src/db/repositories/scope.ts:105-120, apps/runner/src/engines.ts:60-65, packages/core/src/storage/index.ts:69-75, tests/architecture-rules.test.ts:541-586]
---

### 1. The wire contracts are at the bottom and depend on nothing

`packages/contracts` holds every `/api/**` schema, problem code and closed vocabulary, and imports
only `zod`. The SDK, the browser screens, `aw`, the CLI, portal apps and the server all import the
same schemas, and the SDK validates every response against them (ADR-0052).

- **Why:** customers integrate from outside the repository, and a browser that reads a response
  differently from how the server renders it is a bug nobody sees.
- **Cost:** a wire change is a contracts change, a regenerated API report and a lock-step release
  of nine packages (commit `4517e8bcf` moved all nine from 0.6.12 to 0.6.13 together).
- **Kept by:** the `contracts` component's empty `depends_on`, `wire-packages-stay-framework-free`,
  and dependency-cruiser's `contracts-depend-on-nothing-in-the-workspace`.

### 2. Only persistence talks to PostgreSQL and buckets, and a repository takes a tenant, not a caller

All database and object access is in `packages/core`. A repository's only request input is
`WorkspaceScope`, a value minted from a lookup and deliberately without the actor or role
(`scope.ts:105-120`). Inside the web server only a domain's `store.ts` should import `core/db`.

- **Why:** tenant isolation is the first design priority in `ENGINEERING_GUIDELINES.md`;
  authorisation (RBAC) and tenant selection (scope) stay in different places with different reasons
  to change.
- **Cost:** an extra store layer per domain, and 31 files that still name persistence outside a
  store (`domain-does-not-import-persistence` ceiling in `tests/architecture-rules.test.ts`).
- **Kept by:** `only-persistence-and-app-kit-use-drizzle`, the three bucket `only` rules, the
  checklist item `only-stores-name-persistence`, and the repository's baseline ceilings.

### 3. Decisions are pure; effects come in as arguments

A domain's `core/` folder imports only itself, the contracts and zod, and reads no clock, random
value, environment, file or network (`AGENTS.md`, hexagonal rule 2). Outside cores, server code
takes time from a `Clock` and ids from an `IdGenerator`.

- **Why:** pure rules can be tested exhaustively and checked against the Lean model in `formal/`
  (ADR-0062).
- **Cost:** constructors grow `clock` and `ids` parameters (commit `bd1d76148` threaded them through
  the Builder's shell and transport), and a ceiling of direct clock calls (`pnpm clock:check`) still
  has to be worked down.
- **Kept by:** the checklist item `domain-core-is-pure`, dependency-cruiser's `domain-core-is-pure`
  and the ESLint globals ban.

### 4. One composition root, and a domain that can be off says so

`apps/web/server/composition/register.ts` reads the environment once, builds every domain and
installs one `ApplicationContext`. A route reads it per request and answers its domain's named 503
when the domain is `disabled` or `unavailable`; there is no in-memory fallback.

- **Why:** a half-composed process must never serve, and a missing runner or bucket must be visible
  to the caller.
- **Cost:** `application-context.ts` imports a type from every domain, so the server's components
  form one cycle in the component graph (`no-component-cycles` reports it), and process-global state
  needs `defineSlot` because Next.js builds instrumentation and routes as separate module graphs.
- **Kept by:** the checklist items `one-context-install` and `environment-read-at-entry`.

### 5. Engines, drivers and storage backends are plug-ins loaded only when chosen

The runner names engine adapters in one file and loads them with dynamic `import()`
(`engines.ts:60-65`); each runtime driver is its own exports subpath; `openObjectStore` imports only
the backend the storage URL names (`packages/core/src/storage/index.ts:69-75`).

- **Why:** a local install must not load cloud SDKs, a run image must stay small, and a new engine
  must not touch the control plane (ADR-0065).
- **Cost:** each adapter carries a conformance kit, and the single-file rules need their own tests
  (`tests/no-sdk-import.test.ts`).
- **Kept by:** `engine-sdks-stay-in-their-adapters`, `only-runtime-drivers-call-kubernetes`, the
  runner's checklist item `runner-reaches-adapters-through-engines-ts` and `one-sdk-file-per-engine`.

### 6. Known violations are a baseline that can only shrink

Rules that the code does not yet meet are not loosened; their current violations are listed in
`.dependency-cruiser-known-violations.json` and `eslint-suppressions.json`, and
`tests/architecture-rules.test.ts` holds a ceiling per rule.

- **Why:** a rule with exceptions that grow is not a rule.
- **Cost:** the code carries visible debt for a long time, and every fix must also lower a ceiling.
- **Kept by:** the ceilings test and CI's lint-baseline check. This SSOT follows the same idea: the
  imports against the context direction are left out of `depends_on` and reported, not allowed.
