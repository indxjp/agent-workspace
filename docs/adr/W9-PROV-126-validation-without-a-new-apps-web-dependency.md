# W9-PROV-126 — Provider-discriminated config validation is hand-written, not the `zod` package, in `apps/web`

Status: accepted
Date: 2026-09-11
Decided by: W9-PROV-126 (implementer)
Scope: `apps/web/server/models/contract.ts`

## Context

This task's card says: _"A provider-discriminated Zod schema in `apps/web/server/models/
contract.ts`."_ `apps/web/package.json` does not depend on `zod` today — it is a dependency of
`packages/core` only (`packages/core/package.json`) — and no file under `apps/web/` imports it.
pnpm's default (strict, non-hoisting) linking means `import { z } from 'zod'` inside `apps/web`
would not resolve at either typecheck or runtime unless `apps/web/package.json` gained a direct
`zod` dependency.

`apps/web/package.json` is not in this task's `Owns:` globs (`apps/web/server/models/**`,
`apps/web/app/api/model-connections/**`, `packages/core/src/db/repositories/model-connections*.ts`,
`apps/web/instrumentation-node.ts`, `tests/route-declarations/W9-PROV-126.ts`,
`docs/adr/W9-PROV-126-*.md`, `docs/adr/README.md`), and it is not listed as a "genuinely
impossible otherwise" case the way `W2-CP-02-envelope-encryption-and-its-own-connection.md`
decision 4 was (a one-line `exports` addition with no other route to a capability the task could
not build at all). Here the capability — provider-discriminated validation with field-level
errors — does not require the `zod` package specifically; `packages/core/src/db/schema/model-
connections.ts`'s own `ModelConnectionConfig` Zod schema already validates the column's shape at
the database boundary as a second line of defense, and it lives in a file this task does not own
either.

## Decision

**`apps/web/server/models/contract.ts` implements the provider-discriminated schema as plain
TypeScript — a `Record<ModelProviderId, { allowed, required }>` table plus one validating
function — rather than adding a direct `zod` dependency to `apps/web/package.json`.**

The result satisfies the same behavioural contract a `z.discriminatedUnion` would: unknown `config`
keys rejected, each provider's disallowed fields rejected by name, each provider's missing required
fields named individually in one `400`, and a `config.baseUrl` run through W9-PROV-127's egress
policy at save time. `contract.test.ts` asserts the exact per-provider field sets issue #126's
Minimum implementation states (Anthropic/OpenAI: optional `baseUrl` only; OpenAI-compatible:
`baseUrl` required; Azure: `baseUrl` + `apiVersion` + `deployment` all required), which is the
acceptance criterion — _"Invalid provider-specific configs are rejected before persistence with
field-level errors"_ — not a citation of which validation library produced the rejection.

## Alternatives considered

- **Add `zod` to `apps/web/package.json`.** Rejected: a `package.json` + `pnpm-lock.yaml` edit
  outside this task's declared `Owns:` globs, for a dependency this task can avoid needing at all —
  unlike `W2-CP-02`'s one-line `exports` addition, there is a design that needs no edit to the file
  in the first place.
- **Move the discriminated schema into `packages/core` (which already depends on `zod`) and export
  it from `@agent-workspace/core/db`.** Rejected: `packages/core/src/db/schema/model-connections.ts`
  and `packages/core/src/db/index.ts`'s re-export surface are not in this task's `Owns:` globs
  either, and `packages/core/src/db/repositories/index.ts` (the barrel that would need the new
  export) is this wave's shared file, assigned to W9-AUTH-118 — the same constraint
  `docs/adr/W9-PROV-126-atomicity-within-owns-globs.md` documents for the transaction question.

## Consequences

- No dependency or lockfile change ships with this task.
- The provider/field table in `contract.ts` and the `ModelConnectionConfig` Zod schema in
  `packages/core/src/db/schema/model-connections.ts` state the three field names in two places, in
  two different validation styles. They are not at risk of silently drifting apart in a way that
  weakens either: the core schema is already looser (it allows any subset of the three fields,
  `.strict()` only on unknown keys) and continues to be the last line of defense against a config
  shape this layer's own bug might let through — it does not need to also enforce which fields a
  given provider requires, which is a product rule this layer owns.
