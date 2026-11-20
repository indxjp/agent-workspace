/**
 * **The second half of the same property: a query that reaches the database with no scope at all
 * does not compile against the package's public surface.**
 *
 * Verification round 1 of W2-DB-02 found the first half holding and this half absent.
 * `packages/core/src/db/index.ts` re-exported the connection factory and every schema table beside
 * the scope-bound repositories, so a real Next.js route handler could write
 * `createDatabase(createPool(readDatabaseConfig(process.env)))` and then select or delete every
 * tenant's rows, with `tsc` and `eslint` both exiting 0 and no test objecting. A gate on the
 * repository *constructor* proves nothing while the repository *layer* is optional.
 *
 * The fixture below is the verifier's own reproduction, one statement per line, imported from
 * `@agent-workspace/core/db` exactly as a route handler would import it — which is why it lives
 * under `apps/web/node_modules`, the only place in the tree from which that specifier resolves.
 * Its tags are read the same way the block above reads them: `FORBIDDEN` lines must each carry a
 * diagnostic, `PERMITTED` and `DECLARED` lines must carry none, and a diagnostic anywhere else
 * fails the test rather than being ignored.
 */
import path from 'node:path';

import { defineFixtureGate, repoRoot } from './scope-forgery.fixture-gate.test-support.js';

const fixtureSource = [
  "import { openDatabaseRoot } from '@agent-workspace/core/db';",
  "import * as db from '@agent-workspace/core/db';",
  "import { createDatabase, createPool } from '@agent-workspace/core/db/unscoped';",
  '',
  "const body = JSON.parse('{}') as { workspaceId: string; agentId: string };",
  '',
  '// The verification round 1 reproduction: the three-call expression that produced a handle, a',
  '// table object, and the five queries that forgot the tenant. One per line.',
  'export const open = () => db.createDatabase(db.createPool(db.readDatabaseConfig(process.env))); // FORBIDDEN the three-call expression the verifier used to obtain a handle',
  'export const handle = db.createDatabase; // FORBIDDEN the connection factory is not on the public surface',
  'export const pool = db.createPool; // FORBIDDEN nor is the pool factory',
  'export const config = db.readDatabaseConfig; // FORBIDDEN nor is the environment reader',
  'export const table = db.agents; // FORBIDDEN no schema table is on the public surface',
  'export const everyAgentEverywhere = async () => open().select().from(db.agents); // FORBIDDEN a select with no where clause at all',
  'export const anyWorkspaceIWant = async () => open().query.agents.findMany({ where: (r, { eq }) => eq(r.workspaceId, body.workspaceId) }); // FORBIDDEN a workspace id off a request body',
  'export const anyAgentById = async () => open().query.agents.findFirst({ where: (r, { eq }) => eq(r.id, body.agentId) }); // FORBIDDEN a cross-tenant read by row id',
  'export const deleteEverything = async () => open().delete(db.agents); // FORBIDDEN a cross-tenant WRITE',
  "export const viaDeepPath = async () => import('@agent-workspace/core/db/client'); // FORBIDDEN the exports map admits no deep path into the layer",
  '',
  '// Verification round 2. `runSeed` was on this surface: it takes a caller-supplied workspace',
  '// slug and email, resolves the workspace by slug with `onConflictDoNothing`, and inserts an',
  '// `owner` membership row into whatever tenant that slug already names — a cross-tenant write',
  '// with no WorkspaceScope in it. `runMigrations` was beside it. Neither is a handle and neither',
  '// is a table, which is why the lines above did not cover them.',
  'export const seedAnyTenant = async () => db.runSeed(undefined, { workspaceSlug: body.workspaceId, workspaceName: "x", adminEmail: "attacker@example.com", adminName: "x" }); // FORBIDDEN a cross-tenant membership WRITE off a request body',
  'export const seedEntryPoint = db.runSeed; // FORBIDDEN the seed entry point is not on the public surface',
  'export const seedOptions = db.readSeedOptions; // FORBIDDEN nor is its environment reader',
  'export const migrateEntryPoint = db.runMigrations; // FORBIDDEN nor is the migration entry point, which opens a connection of its own',
  '',
  '// The escape this task declares rather than closes. Asserted to compile clean, so the',
  '// declaration on the PR cannot go stale without this test going red.',
  "export const viaEscapeSubpath = createDatabase(createPool({ url: 'postgres://h/d', maxConnections: 1 })); // DECLARED @agent-workspace/core/db/unscoped compiles anywhere; it throws at import outside a test process, and database-reachability.test.ts fails by name on any non-test importer",
  '',
  '// The one way that is meant to work.',
  'export const root = async () => openDatabaseRoot(process.env); // PERMITTED the whole of the public surface, and it returns scope-bound providers and no handle',
].join('\n');

defineFixtureGate({
  title: 'the public database surface hands out no way to reach PostgreSQL (compile-time)',
  fixtureDir: path.join(repoRoot, 'apps', 'web', 'node_modules', '.w2db02-surface-negative'),
  fixtureName: 'surface.ts',
  fixtureSource,
  // `apps/web/package.json` declares no `type`, so a fixture below it would be read as
  // CommonJS and `verbatimModuleSyntax` would reject every `import` statement in it. Saying so
  // here is one line; discovering it is a compile error on every line of the fixture.
  extraFiles: { 'package.json': '{ "type": "module" }\n' },
  testTitles: {
    inventory:
      'has forgeries to reject, a legitimate entry point to admit and a declared escape to record',
    forbidden: 'rejects the unscoped query on fixture line %i',
    permitted: 'admits the public entry point on line %i',
  },
  permittedMessage: (line, rawOutput) =>
    `tsc rejected the legitimate line ${String(line)}:\n${rawOutput}`,
});
