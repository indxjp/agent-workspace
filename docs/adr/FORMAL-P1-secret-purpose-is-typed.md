# ADR-FORMAL-P1-secret-purpose-is-typed — A secret's purpose is typed, not a naming convention

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/{secrets,model-connections,runtime-profiles}.ts`, `apps/web/server/models/store.ts`, `apps/web/server/runtimes/connections.ts`

## Context

A secrets row is a plain secret, a model connection's credential or a runtime connection, and only
its name says which (`MODEL_CONNECTION_<ID>`, `RUNTIME_CONNECTION__<DRIVER>__<LABEL>`).
`runtime_profiles.runtime_connection_id` can name any secret of the workspace (configuration
finding 3; `docs/sdk/04-api-specification.md` §5.5: "_the convention is a naming one until RF-204
replaces it with typed foreign keys_"), and a model connection's credential has no key at all
(configuration finding 8). `diverges_at_an_untyped_runtime_connection` exhibits a profile naming a
plain secret.

## Decision

- Add `model_connections.credential_secret_id`, tenant-paired `(credential_secret_id,
workspace_id) → secrets (id, workspace_id) ON DELETE RESTRICT`, as `mcp_servers` already does.
- Require every runtime connection a profile names to be a runtime connection
  (`AgentWorkspace.Er.Current.Configuration.runtimeConnectionsTyped`, a state invariant of the
  target); the durable form is RF-204's typed table or a `purpose` column in the secrets key.

## Alternatives considered

- **A `runtime_connections` table.** The cleanest end state (RF-204); larger, and it changes the
  secrets listing.
- **Check the purpose in the profile repository only.** Fixes the route, not another writer.

## Consequences

- The migration sets `credential_secret_id` from the name convention
  (`AgentWorkspace.Er.Refinement.credentialOf`); orphan reconciliation by prefix becomes a key.
- Resolves configuration findings 3, 5 and 8 together.
