import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createDatabaseSessionStateRepositoryProvider } from './session-state.js';
import { createDatabaseSessionTranscriptRepositoryProvider } from './session-transcripts.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

const FIRST_MIGRATION_OF_THIS_UNIT = '0026_create_the_engine_scoped_session_state_store';

/**
 * A Claude session created **before** ENG-06's migrations resumes after them with its full history.
 *
 * The database is migrated only as far as 0025, a transcript is written through the repository that
 * release actually used, and then 0026 and 0027 are applied. What the new store then holds must be
 * the same entries, in the same order, under the same idempotency keys — which is the T4 refinement
 * `formal/AgentWorkspace/Theorems/Refinement/SessionStateMigration.lean` states and this suite
 * replays against the real schema.
 *
 * Two details of the old shape are deliberately exercised rather than assumed, because both are
 * places a fold can go wrong:
 *
 *   * a **redelivered** entry, which `session_messages` stored as a second row with the same
 *     `position`. Only the latest delivery may survive, and it must keep its original place.
 *   * an entry with **no** `uuid`, which has no idempotency key and must arrive with `entry_key`
 *     NULL rather than with one invented for it.
 */
describe.skipIf(!hasDatabase)('0026/0027 session-state migration', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const subpath = 'subagents/agent-1';

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-0026-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));

    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter((entry) => entry.tag < FIRST_MIGRATION_OF_THIS_UNIT);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(journal.entries.length);
    await writeFile(
      path.join(priorMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    await Promise.all(
      entries.map((entry) =>
        cp(
          path.join(migrationsDir, `${entry.tag}.sql`),
          path.join(priorMigrationsDir, `${entry.tag}.sql`),
        ),
      ),
    );

    isolated = await createIsolatedTestDatabase(
      'aw_session_state_migration',
      databaseUrl,
      priorMigrationsDir,
    );
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Pre-migration workspace' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Pre-migration owner' });
    await isolated.db.insert(memberships).values({ workspaceId, userId, role: 'owner' });
    // Raw SQL, not a typed insert: this database is migrated only as far as 0025, while the drizzle
    // table objects describe today's schema. The same reasoning `session-migration.test.ts` records.
    await isolated.db.execute(sql`
      insert into agents (id, workspace_id, name, instructions, created_by, permissions)
      values (
        ${agentId}, ${workspaceId}, 'Pre-migration agent', '', ${userId},
        ${JSON.stringify({
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        })}::jsonb
      )
    `);
    await isolated.db.execute(sql`
      insert into sessions (id, workspace_id, user_id, agent_id, engine_session_id, engine)
      values (${sessionId}, ${workspaceId}, ${userId}, ${agentId}, ${sessionId}, 'claude-agent-sdk')
    `);

    // Written through the repository the pre-ENG-06 release used, so the rows are the rows that
    // release would have produced rather than rows this test composed to suit the assertion.
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    const transcripts = createDatabaseSessionTranscriptRepositoryProvider(isolated.db).forScope(
      scope,
    );
    const main = { projectKey: workspaceId, sessionId };
    await transcripts.append(main, [
      { type: 'user', uuid: 'u-1', text: 'first' },
      { type: 'assistant', uuid: 'u-2', text: 'second' },
      { type: 'summary' },
    ]);
    await transcripts.append(main, [{ type: 'user', uuid: 'u-1', text: 'redelivered' }]);
    await transcripts.append({ ...main, subpath }, [{ type: 'user', uuid: 's-1' }]);

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 300_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  async function stateStore() {
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseSessionStateRepositoryProvider(isolated.db).forScope(scope);
  }

  it('carries every entry across, in order, with its idempotency key', async () => {
    const store = await stateStore();
    await expect(
      store.list({ sessionId, engine: 'claude-agent-sdk', streamKey: `${workspaceId}/` }, {}),
    ).resolves.toEqual([
      // The redelivery won, and it kept the first delivery's place. The old table recorded that as
      // "latest sequence within the first position"; the new one holds one row per key.
      { sequence: 1, entryKey: 'u-1', entry: { type: 'user', uuid: 'u-1', text: 'redelivered' } },
      { sequence: 2, entryKey: 'u-2', entry: { type: 'assistant', uuid: 'u-2', text: 'second' } },
      // No `uuid`, so no key was invented for it.
      { sequence: 3, entryKey: null, entry: { type: 'summary' } },
    ]);
  });

  it('carries a subagent transcript across as its own stream', async () => {
    const store = await stateStore();
    await expect(
      store.list(
        { sessionId, engine: 'claude-agent-sdk', streamKey: `${workspaceId}/${subpath}` },
        {},
      ),
    ).resolves.toEqual([{ sequence: 1, entryKey: 's-1', entry: { type: 'user', uuid: 's-1' } }]);
    const streams = await store.listStreams(sessionId);
    expect(streams.map((stream) => stream.streamKey).sort()).toEqual([
      `${workspaceId}/`,
      `${workspaceId}/${subpath}`,
    ]);
  });

  it('leaves the pre-migration tables in place, because 0026 and 0027 are additive', async () => {
    // The contract half of the expand/contract is a later unit's (ADR-0071). A release that predates
    // these migrations keeps reading and writing `session_transcripts`/`session_messages`, which is
    // what makes this a migration a running deployment can apply.
    const rows = await isolated.db.execute<{ count: string }>(
      sql`select count(*)::text as count from session_messages`,
    );
    expect(Number(rows.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });

  it('is re-runnable: applying the migration set again inserts nothing twice', async () => {
    await runMigrations({ url: isolated.url, maxConnections: 4 }, resolveMigrationsDir());
    const store = await stateStore();
    await expect(
      store.list({ sessionId, engine: 'claude-agent-sdk', streamKey: `${workspaceId}/` }, {}),
    ).resolves.toHaveLength(3);
  });
});
