# ADR-FORMAL-P1-connector-is-the-only-name — "Connector" is the concept's only name

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/{mcp-servers,agent-mcp-servers,project-mcp-servers}.ts`, `packages/contracts/src/projects.ts`, a migration

## Context

One concept has three names: connector (wire, SDK, CLI, `IdKind.connector`), MCP server
(`mcp_servers`, `agent_mcp_servers.mcp_server_id`, `project_mcp_servers`) and `mcpServerIds` on the
project wire next to `connectorIds` on the agent wire (catalog finding 9;
`docs/sdk/04-api-specification.md` §5.8 is headed "Connectors (MCP servers)"). The glossary
(`docs/formal/concepts.md`) keeps "connector" and lists the others as aliases.

## Decision

Rename the tables to `connectors`, `agent_connectors` and `project_connectors`, the columns
`mcp_server_id` to `connector_id`, and the project wire field `mcpServerIds` to `connectorIds` (with
the old field accepted for one deprecation window). Constraint names follow the tables.
`AgentWorkspace.Er.Target.tableName` and the column renames in `AgentWorkspace.Er.Target.schema`
state the target; `table_names_diverge_exactly_at` names the three tables.

## Alternatives considered

- **Keep the storage names and document the alias.** No migration, but every reader of the schema,
  the ER diagram and the audit log keeps translating.
- **Rename only the wire.** Leaves the two vocabularies split at the storage boundary.

## Consequences

- A rename-only migration (no data change); the refinement map is a column rename
  (`AgentWorkspace.Er.Refinement.mapRow`), and `refinement_keeps_every_row_in_its_workspace` holds.
- The wire change is a contract change and goes through the SDK deprecation policy.
