/**
 * `@agent-workspace/core/db/unscoped` — the one declared way to reach PostgreSQL without a
 * `WorkspaceScope`, for the suites that must set a fixture up before a repository can be asked
 * anything about it.
 *
 * ## Why this module exists at all
 *
 * A conformance suite for a repository has to insert the rows the repository reads — workspaces,
 * users, memberships, an agent — and it has to insert them *outside* the layer under test, or the
 * test would be asserting that a function agrees with itself. That needs a raw handle and the
 * table objects. Outside the database layer's own directory, the suites are the only readers of
 * either, and `database-reachability.test.ts` is what keeps that true.
 *
 * So the raw half of the database layer lives behind this subpath instead of on
 * `@agent-workspace/core/db`, where verification round 1 found it and used it to read and delete
 * every tenant's rows from a Next.js route handler with `tsc` and `eslint` both silent.
 *
 * ## This is a DECLARED escape, and here is exactly what it does and does not close
 *
 * * It is **not** closed by the type system. `import { agents, createDatabase } from
 *   '@agent-workspace/core/db/unscoped'` compiles. TypeScript has no visibility rule that admits
 *   one importer and refuses another, and this repository's `tsconfig.json` and `eslint.config.mjs`
 *   belong to W0-INF-01 rather than to this task.
 * * It **is** closed at run time, by {@link assertTestProcess} below, which runs when this module
 *   is loaded and throws in any process that has not identified itself as a test runner. A route
 *   handler that imports this fails at import, loudly, in `next dev` and in production alike.
 * * It **is** closed in CI, by `database-reachability.test.ts`, which lists the tracked tree with
 *   no pathspec, parses every path it classifies as a module, hands each import specifier to
 *   `ts.resolveModuleName` under the compiler options of a **union** of contexts — every tracked
 *   TypeScript project whose `ts.createProgram` **program** contains the importing file (the
 *   program, not `parsed.fileNames`: it is the root names plus everything they import), the
 *   repository root `tsconfig.json`, and every tracked project whose configuration file sits at or
 *   above the importing file — compares the resolved real paths against the layer's
 *   directories, and asserts
 *   that the edges its classifier refuses are an empty list. An import of this
 *   subpath by a file that is not a `*.test.ts` is one of the refused arms. The layer's
 *   directories are read out of `packages/core/package.json`'s `./db` export rather than written
 *   down there, so the build output under `dist/` is classified alongside the source.
 *
 * Two independent refusals rather than one, because each has a hole the other covers: the run-time
 * guard cannot see a file nobody executed, and the tracked-tree gate cannot see a file nobody
 * committed.
 */
import {
  connect,
  createDatabase,
  createPool,
  parseDatabaseUrl,
  parseMaxConnections,
  readDatabaseConfig,
} from '../client.js';
import type { Database, DatabaseConfig } from '../client.js';

/**
 * Refuse to be loaded outside a test process.
 *
 * A **positive** assertion, as ADR-0015 requires: this module loads because the process said it is
 * a test runner, never because nothing said it was not. `VITEST` is set in every Vitest worker and
 * `NODE_ENV` is `test` in a Vitest run that did not already set it; a Next.js server sets
 * `development` or `production` and satisfies neither.
 *
 * It throws rather than warning. A warning on the path that reads other tenants' rows is a
 * warning nobody reads until the incident.
 */
function assertTestProcess(): void {
  const vitest = process.env['VITEST'];
  if (vitest === 'true' || vitest === '1') return;
  if (process.env['NODE_ENV'] === 'test') return;
  throw new Error(
    '@agent-workspace/core/db/unscoped reaches PostgreSQL without a WorkspaceScope and is loadable ' +
      'only from a test process (VITEST set, or NODE_ENV=test). This process is ' +
      `NODE_ENV=${JSON.stringify(process.env['NODE_ENV'])}. Application code obtains a database ` +
      'through openDatabaseRoot() from @agent-workspace/core/db, which hands out scope-bound ' +
      'repositories and no queryable handle.',
  );
}

assertTestProcess();

export { assertTestProcess };

/** The raw Drizzle handle. Every query issued through it is unscoped by definition. */
export type { Database, DatabaseConfig };

export {
  connect,
  createDatabase,
  createPool,
  parseDatabaseUrl,
  parseMaxConnections,
  readDatabaseConfig,
};

/** Every table object in `packages/core/src/db/schema/**`, for fixture construction. */
export * from '../schema/index.js';

/** The db-taking factories. Each needs a raw handle, so each belongs on this side of the line. */
export { createDatabaseAgentGrantRepositoryProvider } from './agent-grants.js';
export { createDatabaseAgentRepositoryProvider } from './agents.js';
export { createDatabaseAgentVersionRepositoryProvider } from './agent-versions.js';
export { createDatabaseAgentResourceRepositoryProvider } from './agent-resources.js';
export { createDatabaseAuditEventRepositoryProvider } from './audit-events.js';
export {
  createDatabaseBrowserTokenRepositoryProvider,
  findActiveBrowserTokenByHash,
} from './browser-tokens.js';
export { createDatabaseOAuthTokenRepositoryProvider } from './oauth-tokens.js';
export { createDatabaseFileTextRepositoryProvider } from './file-texts.js';
export { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
export { createDatabaseModelConnectionRepositoryProvider } from './model-connections.js';
export { createDatabaseProjectFileRepositoryProvider } from './project-files.js';
export { createDatabaseProjectMcpServerRepositoryProvider } from './project-mcp-servers.js';
export { createDatabaseProjectRepositoryProvider } from './projects.js';
export { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
export { createInMemoryCatalog } from './memory-catalog.js';
export { createInMemorySessionStateBlobs } from './memory-session-state-blobs.js';
export { createDatabaseStorageConnectionRepositoryProvider } from './storage-connections.js';
export { createInMemoryStorageConnectionRepositoryProvider } from './memory-storage-connections.js';
export {
  createDatabaseStorageMigrationRunRepository,
  createInMemoryStorageMigrationRuns,
} from './storage-migration-runs.js';
export {
  createDatabaseShareRepositoryProvider,
  createDatabaseShareViewRepositoryProvider,
} from './shares.js';
export {
  createDatabaseRunRepositoryProvider,
  createDatabaseRunEventRepositoryProvider,
  createDatabaseSessionRepositoryProvider,
  findRunWorkspace,
  isWorkspaceMember,
} from './runs.js';
export { createDatabaseRunTokenRepositoryProvider } from './run-tokens.js';
export { createDatabaseRunFeedbackRepositoryProvider } from './run-feedback.js';
export { createDatabaseBuilderToolCallRepositoryProvider } from './builder-tool-calls.js';
export { createDatabaseEndpointClientRepositoryProvider } from './endpoint-clients.js';
export { createDatabaseAgentVersionEvaluationRepositoryProvider } from './agent-version-evaluations.js';
export { createDatabaseSessionStateRepositoryProvider } from './session-state.js';
export { createDatabaseSessionTranscriptRepositoryProvider } from './session-transcripts.js';
export { createDatabaseRuntimeVerificationRepositoryProvider } from './runtime-verifications.js';
export { createDatabaseSurfaceSessionKeyRepositoryProvider } from './surface-session-keys.js';
export { createDatabaseTriggerRepositoryProvider } from './triggers.js';
export { createDatabaseWebhookRepositoryProvider } from './webhooks.js';
// Added by W3-CP-06, outside this task's `Owns` cell — declared on its PR. `scope-forgery.test.ts`
// derives every `forScope`-shaped factory `repositories/index.ts` exports and fails unless it is
// also reachable here, so `createDatabaseRuntimeProfileRepositoryProvider` has nowhere else to go.
export { createDatabaseRuntimeProfileRepositoryProvider } from './runtime-profiles.js';
export { createDatabaseWorkspaceFeatureRepositoryProvider } from './workspace-features.js';
export { createDatabaseWorkspaceScopeResolver } from './scope.js';
export {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from './testing.js';
