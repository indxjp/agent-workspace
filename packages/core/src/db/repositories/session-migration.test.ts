import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

describe.skipIf(!hasDatabase)('0019 session identity backfill', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const usedSessionId = crypto.randomUUID();
  const unusedSessionId = crypto.randomUUID();

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-0019-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));

    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter(
      (entry) => entry.tag < '0019_repair_legacy_run_accounting',
    );
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
      'aw_session_backfill',
      databaseUrl,
      priorMigrationsDir,
    );
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: 'session-backfill',
      name: 'Session Backfill',
    });
    await isolated.db.insert(users).values({
      id: userId,
      email: 'session-backfill@example.test',
      name: 'Session Backfill',
    });
    await isolated.db.insert(memberships).values({ workspaceId, userId, role: 'owner' });
    await isolated.db.execute(sql`
      insert into agents (id, workspace_id, name, instructions, created_by, permissions)
      values (
        ${agentId},
        ${workspaceId},
        'Backfill agent',
        '',
        ${userId},
        ${JSON.stringify({
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        })}::jsonb
      )
    `);
    await isolated.db.execute(sql`
      insert into sessions (id, workspace_id, user_id, agent_id)
      values
        (${usedSessionId}, ${workspaceId}, ${userId}, ${agentId}),
        (${unusedSessionId}, ${workspaceId}, ${userId}, ${agentId})
    `);
    // Raw SQL, not `db.insert(runs)`: this database is migrated only as far as 0018, while the
    // drizzle table object describes today's schema. A typed insert names every current column and
    // fails on the ones a later migration adds (`engine`, `engine_version` — ADR-0065).
    await isolated.db.execute(sql`
      insert into runs (id, workspace_id, session_id)
      values (${crypto.randomUUID()}, ${workspaceId}, ${usedSessionId})
    `);

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  it('restores resume identity only for an existing session that already has a run', async () => {
    const rows = await isolated.db
      .select({ id: sessions.id, engineSessionId: sessions.engineSessionId })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));

    expect(rows).toEqual(
      expect.arrayContaining([
        { id: usedSessionId, engineSessionId: usedSessionId },
        { id: unusedSessionId, engineSessionId: null },
      ]),
    );
  });
});
