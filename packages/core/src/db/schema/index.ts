/**
 * The schema barrel — the single module `drizzle-kit` reads and the single module the
 * application imports tables from.
 *
 * One file per table, named after the table, and every one of them re-exported here. That is
 * the convention Wave 2's schema task copies; adding a table means adding a file and one line
 * below, never editing an existing table's file.
 *
 * This module must stay free of anything that opens a connection or reads the environment —
 * `drizzle-kit generate` executes it, and a schema file that needs a live database to be
 * parsed cannot be diffed offline. The connection lives in `../client.ts`.
 *
 * The tables here are spec §27's, minus the ones whose wave has not run. `runtime_profiles` is
 * Wave 3's — landed by W3-CP-06 — and `projects`, `project_files`, `project_mcp_servers`, `shares`
 * and `share_views` are Wave 5's (the Wave 2 plan, "What Wave 2 does not close"). An empty
 * schema file for a table nobody writes yet is code volume with no reader.
 *
 * `tenancy.test.ts` derives the table inventory from `migrations/` and from this directory
 * rather than from a list in a test, so a file added here without a line below — or a table
 * defined here without a migration — fails rather than passing quietly.
 */
export * from './agent-files.js';
export * from './agent-grants.js';
export * from './agent-mcp-servers.js';
export * from './agent-skills.js';
export * from './agent-storage-grants.js';
export * from './agent-version-storage-grants.js';
export * from './agent-pointer-moves.js';
export * from './agent-version-pointers.js';
export * from './agent-versions.js';
export * from './agents.js';
export * from './api-keys.js';
export * from './audit-events.js';
export * from './browser-tokens.js';
export * from './cli-sessions.js';
export * from './columns.js';
export * from './endpoint-client-agents.js';
export * from './endpoint-client-api-keys.js';
export * from './endpoint-clients.js';
export * from './file-texts.js';
export * from './files.js';
export * from './invitations.js';
export * from './mcp-servers.js';
export * from './memberships.js';
export * from './oauth-tokens.js';
export * from './model-connections.js';
export * from './one-of.js';
export * from './project-files.js';
export * from './project-mcp-servers.js';
export * from './projects.js';
export * from './runs.js';
export * from './run-events.js';
export * from './run-feedback.js';
export * from './builder-tool-calls.js';
export * from './agent-version-evaluations.js';
export * from './run-usage-records.js';
export * from './run-tokens.js';
export * from './runtime-profiles.js';
export * from './runtime-verifications.js';
export * from './secrets.js';
export * from './session-messages.js';
export * from './session-state-blobs.js';
export * from './session-state-entries.js';
export * from './session-state-streams.js';
export * from './session-transcripts.js';
export * from './sessions.js';
export * from './storage-connections.js';
export * from './storage-migration-runs.js';
export * from './share-views.js';
export * from './share-run-charges.js';
export * from './shares.js';
export * from './skill-revisions.js';
export * from './skills.js';
export * from './surface-session-keys.js';
export * from './trigger-deliveries.js';
export * from './triggers.js';
export * from './user-identities.js';
export * from './users.js';
export * from './workspaces.js';
export * from './workspace-principals.js';
