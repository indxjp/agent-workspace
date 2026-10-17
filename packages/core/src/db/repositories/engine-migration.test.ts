/**
 * Migrations 0024 and 0025 — ADR-0065's rename, against a real PostgreSQL.
 *
 * The shape is `./session-migration.test.ts`'s: migrate a database to the state that existed
 * *before* the change, write the rows a live deployment would already hold, then apply the rest of
 * the migration set and read what happened to them. That is the only way to test a data migration;
 * a fresh database has nothing to migrate and would pass a migration that did nothing at all.
 *
 * Pre-migration rows are written with raw SQL on purpose. The drizzle table objects describe
 * today's schema, so a typed insert would name `engine_session_id` against a database whose column
 * is still `claude_session_id`, and the seed would fail before the migration could be tested.
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
import { workspaces } from '../schema/workspaces.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

/** The first migration this suite is about; everything strictly before it is the "before" state. */
const FIRST_ENGINE_MIGRATION = '0024_curly_molten_man';

/** The hand-written data migration: the policy rewrite and the session backfill. */
const DATA_MIGRATION = '0025_name_the_engine_in_stored_rows';

/** The stored policy shape as it existed before the rename: discriminated by `provider`. */
const LEGACY_POLICY = {
  provider: 'claude-agent-sdk',
  tools: {
    base: 'claude_code_preset',
    autoApprove: [],
    deny: ['Bash'],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  skills: { mode: 'allowlist', names: ['triage'] },
  limits: { maxTurns: 20, maxBudgetUsd: null },
};

/** Strips the leading `--` comment lines and whitespace a migration chunk opens with. */
const withoutLeadingComments = (statement: string): string =>
  statement.replace(/^(?:\s*--[^\n]*(?:\n|$))*/, '').trim();

/** What a split migration chunk does, judged by its first line of actual SQL. */
const statementKind = (statement: string): 'update' | 'validate' | 'other' => {
  const body = withoutLeadingComments(statement);
  if (/^update\b/i.test(body)) return 'update';
  if (/^alter\s+table\s+\S+\s+validate\s+constraint\b/i.test(body)) return 'validate';
  return 'other';
};

/**
 * 0024's two `NOT VALID` clauses are hand edits: drizzle-kit generates the constraints without them,
 * so a regeneration would silently drop them. This needs no database, so it runs everywhere.
 */
describe('0024 engine CHECK constraints', () => {
  it('keeps both hand-edited NOT VALID clauses', async () => {
    const source = await readFile(
      path.join(resolveMigrationsDir(), `${FIRST_ENGINE_MIGRATION}.sql`),
      'utf8',
    );
    expect(source).toMatch(/ADD CONSTRAINT "runs_engine_valid" CHECK \([^;]*\) NOT VALID;/);
    expect(source).toMatch(/ADD CONSTRAINT "sessions_engine_valid" CHECK \([^;]*\) NOT VALID;/);
  });
});

describe.skipIf(!hasDatabase)('0024/0025 engine identity rename and backfill', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  /** An agent with a stored policy, and one whose `policy` column is still NULL. */
  const policiedAgentId = crypto.randomUUID();
  const unpoliciedAgentId = crypto.randomUUID();
  /** A session that already reported an identity, and one that never started a run. */
  const identifiedSessionId = crypto.randomUUID();
  const anonymousSessionId = crypto.randomUUID();
  const reportedSessionId = crypto.randomUUID();
  const historicRunId = crypto.randomUUID();

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-engine-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));

    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter((entry) => entry.tag < FIRST_ENGINE_MIGRATION);
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
      'aw_engine_rename',
      databaseUrl,
      priorMigrationsDir,
    );
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: 'engine-rename',
      name: 'Engine Rename',
    });
    await isolated.db.insert(users).values({
      id: userId,
      email: 'engine-rename@example.test',
      name: 'Engine Rename',
    });
    await isolated.db.insert(memberships).values({ workspaceId, userId, role: 'owner' });

    const permissions = JSON.stringify({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    await isolated.db.execute(sql`
      insert into agents (id, workspace_id, name, instructions, created_by, permissions, policy)
      values
        (${policiedAgentId}, ${workspaceId}, 'Policied', '', ${userId},
         ${permissions}::jsonb, ${JSON.stringify(LEGACY_POLICY)}::jsonb),
        (${unpoliciedAgentId}, ${workspaceId}, 'Unpolicied', '', ${userId},
         ${permissions}::jsonb, null)
    `);
    // The column is still `claude_session_id` here: that is the whole point of the seed.
    await isolated.db.execute(sql`
      insert into sessions (id, workspace_id, user_id, agent_id, claude_session_id)
      values
        (${identifiedSessionId}, ${workspaceId}, ${userId}, ${policiedAgentId}, ${reportedSessionId}),
        (${anonymousSessionId}, ${workspaceId}, ${userId}, ${policiedAgentId}, null)
    `);
    await isolated.db.execute(sql`
      insert into runs (id, workspace_id, session_id)
      values (${historicRunId}, ${workspaceId}, ${identifiedSessionId})
    `);

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  /** The columns `sessions` and `runs` actually have, after every migration has run. */
  const columnsOf = async (table: string): Promise<readonly string[]> => {
    const rows = await isolated.db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = ${table}
      order by column_name
    `);
    return rows.rows.map((row) => row.column_name);
  };

  it('renames claude_session_id to engine_session_id, carrying the value across', async () => {
    const rows = await isolated.db.execute<{ id: string; engine_session_id: string | null }>(sql`
      select id, engine_session_id from sessions where workspace_id = ${workspaceId} order by id
    `);
    expect(new Map(rows.rows.map((row) => [row.id, row.engine_session_id]))).toEqual(
      new Map([
        [identifiedSessionId, reportedSessionId],
        [anonymousSessionId, null],
      ]),
    );
  });

  /**
   * The regression test the rename needs: this assertion fails on the old schema. Without it, a
   * migration that added `engine_session_id` as a *new* column — leaving `claude_session_id`
   * populated beside it — would pass every other test in this file while silently splitting the
   * resume identity across two columns.
   */
  it('leaves no claude_session_id column behind', async () => {
    const columns = await columnsOf('sessions');
    expect(columns).toContain('engine_session_id');
    expect(columns).not.toContain('claude_session_id');
    await expect(
      isolated.db.execute(sql`select claude_session_id from sessions limit 1`),
    ).rejects.toThrow();
  });

  it('keeps the resume lookup unique per workspace under the new name', async () => {
    const indexes = await isolated.db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes where schemaname = 'public' and tablename = 'sessions'
    `);
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('sessions_workspace_engine_session_key');
    expect(names).not.toContain('sessions_workspace_claude_session_key');
    // And it still refuses a second session in this workspace claiming the same engine identity.
    await expect(
      isolated.db.execute(sql`
        insert into sessions (id, workspace_id, user_id, agent_id, engine_session_id, engine)
        values (${crypto.randomUUID()}, ${workspaceId}, ${userId}, ${policiedAgentId},
                ${reportedSessionId}, 'claude-agent-sdk')
      `),
    ).rejects.toThrow();
  });

  it('backfills sessions.engine for every session that already has an identity, and only those', async () => {
    const rows = await isolated.db.execute<{ id: string; engine: string | null }>(sql`
      select id, engine from sessions where workspace_id = ${workspaceId} order by id
    `);
    expect(new Map(rows.rows.map((row) => [row.id, row.engine]))).toEqual(
      new Map([
        [identifiedSessionId, 'claude-agent-sdk'],
        // Nothing has pinned this one: NULL is the honest answer, not a guessed engine.
        [anonymousSessionId, null],
      ]),
    );
  });

  it('leaves the release invariant holding: an identified session always names its engine', async () => {
    // The exact query #317's acceptance criteria state.
    const rows = await isolated.db.execute<{ count: number }>(sql`
      select count(*)::int as count from sessions
      where engine is null and engine_session_id is not null
    `);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('rewrites the policy discriminant from provider to engine, in place', async () => {
    const rows = await isolated.db.execute<{ id: string; policy: unknown }>(sql`
      select id, policy from agents where workspace_id = ${workspaceId} order by id
    `);
    const byId = new Map(rows.rows.map((row) => [row.id, row.policy]));

    const rewritten = byId.get(policiedAgentId) as Record<string, unknown>;
    expect(rewritten['engine']).toBe('claude-agent-sdk');
    expect('provider' in rewritten).toBe(false);
    // Nothing but the discriminant moved: the rest of the document is carried across untouched.
    const restOfLegacy = Object.fromEntries(
      Object.entries(LEGACY_POLICY).filter(([key]) => key !== 'provider'),
    );
    const restOfRewritten = Object.fromEntries(
      Object.entries(rewritten).filter(([key]) => key !== 'engine'),
    );
    expect(restOfRewritten).toEqual(restOfLegacy);

    // A NULL column means "compile from the permission checkboxes" and must stay NULL.
    expect(byId.get(unpoliciedAgentId)).toBeNull();
  });

  it('adds runs.engine and runs.engine_version without backfilling a historic run', async () => {
    expect(await columnsOf('runs')).toEqual(expect.arrayContaining(['engine', 'engine_version']));
    const rows = await isolated.db.execute<{
      engine: string | null;
      engine_version: string | null;
    }>(sql`select engine, engine_version from runs where id = ${historicRunId}`);
    // Deliberately NULL: nothing ever observed this run's engine, and `'claude-agent-sdk'` here
    // would be a guess indistinguishable from a measurement (the `accounting_state` lesson, #134).
    expect(rows.rows[0]).toEqual({ engine: null, engine_version: null });
  });

  /**
   * 0024 adds both CHECKs `NOT VALID` so it scans nothing under the table lock; 0025 validates
   * them. A constraint left unvalidated would still refuse new rows but would never have checked
   * the existing ones, so this is what proves the pair ends with both constraints fully in force.
   */
  it('ends with both engine CHECK constraints validated', async () => {
    const rows = await isolated.db.execute<{ conname: string; convalidated: boolean }>(sql`
      select conname, convalidated from pg_constraint
      where conname in ('runs_engine_valid', 'sessions_engine_valid')
      order by conname
    `);
    expect(rows.rows).toEqual([
      { conname: 'runs_engine_valid', convalidated: true },
      { conname: 'sessions_engine_valid', convalidated: true },
    ]);
  });

  /**
   * Re-applies the real data migration file, statement by statement, to the already migrated
   * database. The SQL is read from `migrations/`, never restated here, so an edit to the file that
   * breaks re-runnability fails this test.
   */
  it('is idempotent: re-applying the real data migration changes nothing', async () => {
    const snapshot = async (): Promise<unknown> => ({
      agents: (
        await isolated.db.execute(
          sql`select id, policy from agents where workspace_id = ${workspaceId} order by id`,
        )
      ).rows,
      sessions: (
        await isolated.db.execute(sql`
          select id, engine_session_id, engine from sessions
          where workspace_id = ${workspaceId} order by id
        `)
      ).rows,
    });
    const before = await snapshot();
    const statements = (
      await readFile(path.join(resolveMigrationsDir(), `${DATA_MIGRATION}.sql`), 'utf8')
    )
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    // Two UPDATEs (the policy rewrite and the session backfill), then the two VALIDATE CONSTRAINT
    // statements the migration ends with. VALIDATE is as idempotent as the UPDATEs: re-validating an
    // already-validated constraint is a no-op (ADR-0069), so re-applying all four is the real test.
    // Most chunks open with `--` comment lines, so classify on the first line of actual SQL.
    expect(statements.map(statementKind)).toEqual(['update', 'update', 'validate', 'validate']);
    for (const statement of statements) await isolated.db.execute(sql.raw(statement));
    expect(await snapshot()).toEqual(before);
  });
});
