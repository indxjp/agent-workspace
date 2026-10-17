/**
 * Migration 0036 — connector kinds and the run tool snapshot (issue #527, S2-02b, ADR-0113 C16),
 * against a real PostgreSQL.
 *
 * The shape is `./engine-migration.test.ts`'s: migrate a database to the state before 0036, write
 * the MCP connectors and the run a live deployment already holds with raw SQL (the drizzle table
 * objects describe today's schema), apply 0036, and read what happened to them. A static check of
 * the migration's statements runs everywhere: 0036 must stay additive apart from the one
 * `transport DROP NOT NULL` and the four checks it re-guards.
 */
import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

const CONNECTOR_KINDS_MIGRATION = '0036_add_connector_kinds_and_the_run_tool_snapshot';

/** The four checks 0036 drops and re-adds, guarded by `kind <> 'mcp'`. */
const REGUARDED_CHECKS = [
  'mcp_servers_args_are_stdio_only',
  'mcp_servers_credential_required',
  'mcp_servers_remote_has_url',
  'mcp_servers_stdio_has_command',
];

/** The migration's SQL statements, comment lines removed. */
async function migrationStatements(): Promise<readonly string[]> {
  const source = await readFile(
    path.join(resolveMigrationsDir(), `${CONNECTOR_KINDS_MIGRATION}.sql`),
    'utf8',
  );
  return source
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.replace(/^(?:\s*--[^\n]*(?:\n|$))*/u, '').trim())
    .filter((statement) => statement.length > 0);
}

describe('0036 statement shape', () => {
  it('drops no column and no table', async () => {
    for (const statement of await migrationStatements()) {
      expect(statement).not.toMatch(/\bdrop\s+(?:column|table)\b/iu);
    }
  });

  it('alters exactly one column: transport DROP NOT NULL', async () => {
    const alters = (await migrationStatements()).filter((statement) =>
      /\balter\s+column\b/iu.test(statement),
    );
    expect(alters).toEqual(['ALTER TABLE "mcp_servers" ALTER COLUMN "transport" DROP NOT NULL;']);
  });

  it('drops only the four re-guarded checks, and re-adds each one guarded by kind', async () => {
    const statements = await migrationStatements();
    const dropped = statements
      .map((statement) => /\bdrop\s+constraint\s+"([^"]+)"/iu.exec(statement)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
    expect(dropped).toEqual(REGUARDED_CHECKS);
    for (const name of REGUARDED_CHECKS) {
      const added = statements.filter((statement) =>
        statement.includes(`ADD CONSTRAINT "${name}" CHECK ("mcp_servers"."kind" <> 'mcp' or (`),
      );
      expect(added, name).toHaveLength(1);
    }
  });

  it('adds every column before any constraint, and no constraint NOT VALID', async () => {
    const statements = await migrationStatements();
    const lastColumn = statements.findLastIndex((statement) =>
      /\badd\s+column\b/iu.test(statement),
    );
    const firstConstraint = statements.findIndex((statement) =>
      /\badd\s+constraint\b/iu.test(statement),
    );
    expect(lastColumn).toBeGreaterThanOrEqual(0);
    expect(firstConstraint).toBeGreaterThan(lastColumn);
    for (const statement of statements) expect(statement).not.toMatch(/\bnot\s+valid\b/iu);
  });
});

describe.skipIf(!hasDatabase)('0036 against MCP connectors and runs that already exist', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string | undefined;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const stdioId = crypto.randomUUID();
  const httpId = crypto.randomUUID();
  const sseId = crypto.randomUUID();

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-connector-kinds-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));
    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter((entry) => entry.tag < CONNECTOR_KINDS_MIGRATION);
    expect(entries.length).toBeLessThan(journal.entries.length);
    await writeFile(
      path.join(priorMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    const target = priorMigrationsDir;
    await Promise.all(
      entries.map((entry) =>
        cp(path.join(migrationsDir, `${entry.tag}.sql`), path.join(target, `${entry.tag}.sql`)),
      ),
    );

    isolated = await createIsolatedTestDatabase('aw_connector_kinds', databaseUrl, target);
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: 'connector-kinds',
      name: 'Connector Kinds',
    });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    // Raw SQL: before 0036 there is no `kind` or `tool_config` column to name.
    await isolated.db.execute(sql`
      insert into mcp_servers (id, workspace_id, name, transport, command, args, url, owner_principal_id)
      values
        (${stdioId}, ${workspaceId}, 'Filesystem', 'stdio', 'npx', '["-y", "server"]'::jsonb, null, ${principalId}),
        (${httpId}, ${workspaceId}, 'GitHub', 'http', null, null, 'https://mcp.example.test/mcp', ${principalId}),
        (${sseId}, ${workspaceId}, 'Events', 'sse', null, null, 'https://mcp.example.test/sse', ${principalId})
    `);
    await isolated.db.execute(sql`
      insert into agents (id, workspace_id, name, instructions, created_by, owner_principal_id, permissions)
      values (${agentId}, ${workspaceId}, 'Historic', '', ${userId}, ${principalId},
              '{"readFiles":true,"writeFiles":false,"runCommands":false,"unrestrictedNetwork":false}'::jsonb)
    `);
    await isolated.db.execute(sql`
      insert into sessions (id, workspace_id, user_id, owner_principal_id, agent_id)
      values (${sessionId}, ${workspaceId}, ${userId}, ${principalId}, ${agentId})
    `);
    await isolated.db.execute(sql`
      insert into runs (id, workspace_id, session_id) values (${runId}, ${workspaceId}, ${sessionId})
    `);

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  it('makes every existing connector kind mcp with no tool_config', async () => {
    const rows = await isolated.db.execute<{ id: string; kind: string; has_config: boolean }>(sql`
      select id, kind, tool_config is not null as has_config
      from mcp_servers where workspace_id = ${workspaceId} order by id
    `);
    expect(rows.rows).toEqual(
      [stdioId, httpId, sseId].sort().map((id) => ({ id, kind: 'mcp', has_config: false })),
    );
  });

  it('reads the existing connectors back through the repository, unchanged', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scope);
    const listed = await repo.list();
    expect(new Map(listed.map((row) => [row.id, row.transport]))).toEqual(
      new Map([
        [stdioId, 'stdio'],
        [httpId, 'http'],
        [sseId, 'sse'],
      ]),
    );
    expect(listed.find((row) => row.id === stdioId)).toMatchObject({
      command: 'npx',
      args: ['-y', 'server'],
      url: null,
      authType: 'none',
    });
    await expect(repo.listToolConnectors()).resolves.toEqual([]);
  });

  it('gives an existing run the empty tool set', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const run = await createDatabaseRunRepositoryProvider(isolated.db).forScope(scope).get(runId);
    expect(run?.toolConnectorIds).toEqual([]);
  });

  it('still accepts an insert from a previous revision, which names no kind', async () => {
    await isolated.db.execute(sql`
      insert into mcp_servers (workspace_id, name, transport, url, owner_principal_id)
      values (${workspaceId}, 'Old revision', 'http', 'https://mcp.example.test/old', ${principalId})
    `);
    const rows = await isolated.db.execute<{ kind: string }>(sql`
      select kind from mcp_servers where workspace_id = ${workspaceId} and name = 'Old revision'
    `);
    expect(rows.rows).toEqual([{ kind: 'mcp' }]);
  });
});
