# ADR-0052 — The SDK is contracts-first, and the application is its first consumer

Status: accepted
Date: 2026-09-21
Decided by: the Owner
Scope: `packages/contracts`, `packages/sdk`, and how `apps/web` adopts them

## Context

Customers will increasingly bring their own frontends and backends and need to integrate with the
control plane. The functionality they need already exists as `/api/**` routes, but its contracts
live as hand-written parsers and serializers inside `apps/web/server/<domain>`, four Zod files in
`apps/web/contracts`, and an SSE consumer inside a browser component. Nothing outside the
repository can validate against them, and nothing inside it proves that the browser's reading of a
response and the server's rendering of it are the same shape.

Migrating every domain in one change would be both exhausting and risky: the refactoring programme
(`docs/architecture/refactoring/`) already has open items that will change several of these
surfaces (RF-102, RF-103, RF-202/203, RF-204, RF-304), and a client that froze them now would
freeze the defects too.

Two words collide here. "SDK" in this repository has meant `@anthropic-ai/claude-agent-sdk`, which
spec §42 confines to one file. This decision adds a second meaning and names it explicitly.

## Decision

1. **Two packages, one direction.** `@agent-workspace/contracts` publishes the wire contracts as
   Zod schemas and derived types and depends on `zod` alone. `@agent-workspace/sdk` is a typed,
   isomorphic client that depends on `contracts` and nothing else in the workspace.
   `dependency-cruiser` enforces both edges.
2. **Contracts before client, client before adoption.** A domain enters the SDK in that order and
   only after `apps/web/server/sdk-conformance.test.ts` proves the application's real serializers
   satisfy the schema. The test is the migration's definition of done, one domain per change.
3. **The application re-exports; it does not copy.** `apps/web/contracts/*.ts` re-export the
   package's schemas under the names the application already imports, so browser and server code
   move without a flag day and no second copy of a contract exists. `components/run/live.ts`
   re-exports the SDK's SSE parser the same way.
4. **The wire does not change to suit the SDK.** Envelopes, statuses and problem codes are
   published as they are; irregularities are the client's problem to hide, and normalising them is
   a versioned-API decision, not this one.
5. **Not published yet.** Both packages stay `"private": true` (ADR W0-INF-01). They are shaped so
   that flipping `private` and adding `files` is the whole publishing change, and that change waits
   on an owner-controlled npm scope and release provenance.

## Consequences

- `apps/web` gains two workspace dependencies whose runtime entry points live in `dist/`, so the
  Dockerfile's `deps` stage copies their manifests, `quality.yml` builds them before the web
  suites, and `scripts/test-with-services.mjs` builds `@agent-workspace/sdk...` beside `core`.
- The reserved event names, the run enums and the prompt/list bounds now exist in a third place
  (the contracts) and are gated to the server's copies by the conformance test, exactly as the
  server's own restatements are gated to `packages/core`.
- A response that gains a field is a `.strict()` failure for an older client. Additive response
  fields are therefore minor releases of both packages made together, and a customer pins the
  contracts version to the control-plane release they deploy against. This is deliberate: a
  client that silently accepts fields it does not know is one that cannot tell drift from data.
- "SDK" is ambiguous in prose from now on. `docs/sdk/README.md` fixes the two meanings; new text
  says "Claude Agent SDK" or "Agent Workspace SDK".

## Alternatives considered

- **Generate the client from OpenAPI.** Rejected for now: no OpenAPI document exists, the Zod
  schemas would have to be written anyway to produce one, and a generated client would not carry
  the stream follower or the three-way failure classification. An OpenAPI document can be
  generated from the schemas for reference documentation.
- **Publish `apps/web/contracts` directly.** Rejected: an application directory cannot be a
  package another member imports without breaking the `packages/* never import apps/*` rule, and
  it holds server-to-component capability props that are not wire contracts.
- **Move every domain now.** Rejected for the reasons in the context: the open RF items would be
  frozen into a public surface.
