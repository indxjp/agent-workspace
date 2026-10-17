# ADR-0136 — The engine catalogue is the one place an engine is described

Status: accepted
Date: 2026-10-11
Decided by: issue #946 (R1), the decided plan in its implementation-plan comment
Scope: `packages/contracts/src/engine-catalogue.ts`, `packages/contracts/src/engines.ts`, `packages/contracts/src/agents.ts`, `packages/contracts/src/agents/permissions.ts`, `apps/web/server/engines/registry.ts`, `apps/web/server/compose/run-request.ts`, `packages/engine-*/src/engine.ts`

## Context

ADR-0065 makes an agent's engine an extension point behind one port, and ADR-0070 and ADR-0072 say
that nothing outside an adapter names an engine's tools or configuration. In practice the facts about
one engine were restated in many places: a capability descriptor in the control plane's registry and
again in each adapter, the engine-native settings arm of the agent policy, the tool names an engine
withholds, the MCP tool-name form compose checks against, and the session-stream key scheme. Adding
an engine meant finding every restatement; nothing failed when one was missed, and two copies could
disagree without a test noticing.

## Decision

- **One catalogue.** `ENGINE_CATALOGUE` in `@indx-workspace/contracts` is keyed by `EngineId` and
  holds, per engine: `displayName`, `capabilities`, `settings` (a zod raw shape, every key optional,
  in wire key order), `narrowing` (`tool-rules` or `withheld-permissions`), `permissionTools`, the
  `mcpToolName` form and the `sessionStreamKey` scheme. Code that needs one of these reads the
  catalogue; it does not branch on an engine id.
- **The SDK version stays out.** A release pin is deployment data, not a contract fact, so
  `ENGINE_VERSIONS` stays in `apps/web/server/engines/registry.ts`.
- **Leaf layout.** `agents/permissions.ts` (the permission keys) feeds `engine-catalogue.ts`, which
  feeds `agents.ts`. No cycle exists at runtime. `engines.ts` and `agents.ts` re-export catalogue
  symbols by name, never with `export *`, so the formal specification's `file#symbol` citations stay
  valid.
- **The policy arms stay an explicit list.** `AgentPolicySchema` is still a discriminated union over
  an explicit array of arms built from the catalogue, so the union's key order is the wire order and
  the generated JSON schema does not change. A compile-time guard (`SameSet` in `AgentPolicy`) fails
  the build when an `EngineId` has no arm or an arm has no `EngineId`.
- **Behaviour-neutral.** No wire shape, `openapi.json`, generated schema, migration or error code
  changes. Goldens captured before the change pin the policy JSON schemas and the engine settings
  schema.

### Adding an engine

1. Add the id to `ENGINE_IDS` in `packages/contracts/src/engines.ts`.
2. Add its entry to `ENGINE_CATALOGUE`. The `Record<EngineId, …>` type refuses a missing entry.
3. Register its arm in the three arm lists: contracts (`AgentPolicySchema`), the SDK
   (`EngineSettingsSchema`) and core (`AgentStoredPolicy`). The three exhaustiveness guards turn a
   missed registration into a compile error.
4. Generate the migration with `pnpm --filter @agent-workspace/core db:generate`; the `*_engine_valid`
   check constraints are rendered from `ENGINE_IDS`.
5. Add the adapter package `packages/engine-<id>` and have it read its capabilities from the
   catalogue.
6. Add a row in `apps/runner/src/engines.ts` and the runtime image.

### Amendments

- **ADR-0065**: the "descriptor" the control plane offers is built from the catalogue plus the pinned
  SDK version, not written by hand.
- **ADR-0070**, Consequences: an adapter's capability set is the catalogue's `capabilities`, so the
  adapter and the control plane cannot disagree.
- **ADR-0072**: the engine-native tool names an engine withholds are the catalogue's
  `permissionTools`; the engine-native arm of the policy is the catalogue's `settings`.

- **Arms name their engine by position.** Each of the three arm lists (and `ENGINE_VERSIONS` in the
  registry) destructures `ENGINE_IDS` once and passes the names to the arm builders, so production
  code holds no engine-id literal. Every arm is still a function of its own id, so a reordered list
  mislabels a variable but never builds a wrong arm; the goldens catch a reorder. `ENGINE_VERSIONS`
  is the exception: its values are constants, so a reorder would give an engine another engine's SDK
  version, and `apps/web/server/engines/handlers.test.ts`, which pins each descriptor's version,
  catches it.
- **`toStoredPolicy` is an identity.** The stored arms are built from the same catalogue settings and
  every stored array is `readonly`, so a contracts `AgentPolicy` is assignable to core's
  `AgentStoredPolicy` as it is. The function stays so its callers do not change.

### Landed

The catalogue, the contracts arms and guard, the registry, compose, the session stream key, the four
adapters' capability sets and the engine-id check-constraint test landed first. This change adds the
core stored arms and the SDK settings arms with their guards, the stored-policy identity, and the
literal-free arm registrations. The adapters' wire-protocol constants and run-policy schemas, and the
runner's adapter table, are not yet checked against the catalogue.
