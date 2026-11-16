import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { expect, it } from 'vitest';

import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import type { ProjectFixture } from './projects.fixture.test-support.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import type { IsolatedTestDatabase } from './testing.js';

interface AdvisoryWait {
  /** Stop once more than this many advisory locks are waiting. */
  readonly above: number;
  readonly deadline: number;
  readonly timeout: string;
  /** Checked first on every poll; when it holds, the wait answers `true` instead. */
  readonly settledFirst?: () => Promise<boolean>;
}

/**
 * Poll `pg_locks` every 20ms until more than `above` advisory locks are waiting (answering
 * `false`) or `settledFirst` holds (answering `true`), failing with `timeout` past `deadline`.
 */
async function waitForAdvisoryWaiters(blocker: pg.Client, wait: AdvisoryWait): Promise<boolean> {
  for (;;) {
    if (wait.settledFirst !== undefined && (await wait.settledFirst())) return true;
    const waiting = await blocker.query<{ count: number }>(
      "select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted",
    );
    if ((waiting.rows[0]?.count ?? 0) > wait.above) return false;
    if (Date.now() > wait.deadline) throw new Error(wait.timeout);
    await delay(20);
  }
}

async function runExists(isolated: IsolatedTestDatabase, runId: string): Promise<boolean> {
  const existing = await isolated.db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
  return existing.length > 0;
}

/**
 * Hold an unrelated lock in an UPDATE trigger after the move has checked for runs. This exposes
 * the gap where the old implementation admitted a run before committing the move.
 */
async function installMoveHold(isolated: IsolatedTestDatabase): Promise<void> {
  await isolated.db.execute(sql`
      create function hold_project_move() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(42021, 1);
        return new;
      end;
      $$
    `);
  await isolated.db.execute(sql`
      create trigger hold_project_move_trigger before update of project_id on sessions
      for each row execute function hold_project_move()
    `);
}

/** A session move and a run creation on the same session serialise: the run waits for the move. */
export function registerMoveRaceCases(fixture: ProjectFixture) {
  it('does not move a session after a concurrent run creation has entered', async () => {
    const { isolated, repository, createProject, seedSession } = fixture;
    const source = await createProject('move-race-source');
    const destination = await createProject('move-race-destination');
    const sessionId = await seedSession(source.id);
    const runId = crypto.randomUUID();
    const runRepository = createDatabaseRunRepositoryProvider(isolated.db).forScope(
      await fixture.scopeFor(fixture.workspaceId),
    );

    await installMoveHold(isolated);
    const blocker = new pg.Client({ connectionString: isolated.url });
    await blocker.connect();
    try {
      await blocker.query('select pg_advisory_lock(42021, 1)');
      const moving = repository.moveSession(destination.id, sessionId);
      const deadline = Date.now() + 10_000;
      await waitForAdvisoryWaiters(blocker, {
        above: 0,
        deadline,
        timeout: 'session move did not reach the update trigger',
      });

      const creating = runRepository.create({ id: runId, sessionId, engine: 'claude-agent-sdk' });
      const runCreatedBeforeMove = await waitForAdvisoryWaiters(blocker, {
        above: 1,
        deadline,
        timeout: 'run creation did not settle or wait for move',
        settledFirst: () => runExists(isolated, runId),
      });
      await blocker.query('select pg_advisory_unlock(42021, 1)');
      expect(await moving).toEqual({ kind: 'moved' });
      expect((await creating).kind).toBe('created');
      const session = (
        await isolated.db
          .select({ projectId: sessions.projectId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0];
      expect(runCreatedBeforeMove).toBe(false);
      expect(session?.projectId).toBe(destination.id);
    } finally {
      await blocker.query('select pg_advisory_unlock(42021, 1)');
      await blocker.end();
    }
  });
}
