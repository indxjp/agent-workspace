/**
 * A team run over a real PostgreSQL (ADR-0104 acceptance decisions 5 to 8, issue #1517).
 *
 * The run store, the team repository and the run tree are the production ones; the runtime is an
 * in-process double that plays the lead and its members as a runner would: the lead's engine calls
 * `agent__writer` and `agent__critic` on the member endpoint, each child run settles with a priced
 * cost, and the lead settles last. It proves, against the schema, one root with two children whose
 * `parent_run_id` is the root, `GET /api/runs/<root>` answering `children.length === 2` and
 * `treeCost` equal to the sum of the three `cost_usd`, and that interrupting the root leaves no
 * child `queued` or `running`.
 *
 * This is the issue's acceptance test, as a PostgreSQL integration test rather than in
 * `apps/web/server/runs/acceptance/`, which is a Docker and nginx probe outside `pnpm test`. Runs
 * whenever `TEST_DATABASE_URL` names a database (`pnpm test` provides one, through Docker or the
 * embedded-postgres fallback); skipped, by name, otherwise.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunDetailResponseSchema } from '@indx-workspace/contracts/runs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../application-context';
import { interruptRunFor, readRun } from '../runs/api';
import {
  COSTS,
  environment,
  runStore,
  seed,
  settle,
  startLead,
  waitFor,
  type CoreDb,
  type IsolatedDatabase,
  type TeamRunHarness,
} from './team-run.integration.test-support';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';
if (!hasDatabase) {
  console.warn(
    '[agent-teams/team-run.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'agent-team run tree was NOT proved against PostgreSQL.',
  );
}

/** `apps/web/server/agent-teams/<this file>` → the repository root, five levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

describe.skipIf(!hasDatabase)('an agent team run over PostgreSQL', () => {
  let core: CoreDb;
  let isolated: IsolatedDatabase;
  const harness = (): TeamRunHarness => ({ core, isolated });

  beforeAll(async () => {
    const dist = path.join(
      repoRoot,
      'packages',
      'core',
      'dist',
      'db',
      'repositories',
      'unscoped.js',
    );
    if (!existsSync(dist)) {
      throw new Error(
        `${dist} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` first.`,
      );
    }
    core = await import('@agent-workspace/core/db/unscoped');
    isolated = await core.createIsolatedTestDatabase('aw_agent_team_runs');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('gives a lead that calls two members one root, two children and the summed treeCost', async () => {
    const seeded = await seed(harness());
    const store = runStore(harness());
    const answers: unknown[] = [];
    const { env, settled } = environment(harness(), seeded, store, async (context, members) => {
      if (context.agent.id === seeded.agents.lead) {
        answers.push(await members('writer', 'Draft the note.'));
        answers.push(await members('critic', 'Review the draft.'));
        await settle(harness(), store, context.run.id, {
          cost: COSTS.lead,
          text: 'the reviewed note',
        });
        return;
      }
      const writer = context.agent.id === seeded.agents.writer;
      await settle(harness(), store, context.run.id, {
        cost: writer ? COSTS.writer : COSTS.critic,
        text: writer ? 'a draft' : 'a review',
      });
    });
    const root = await startLead(seeded, env);
    await waitFor(async () => (await store.get(root.id))?.status === 'completed');
    await Promise.all(settled);

    expect(answers).toEqual([
      { content: [{ type: 'text', text: 'a draft' }], isError: false },
      { content: [{ type: 'text', text: 'a review' }], isError: false },
    ]);
    const rows = await isolated.db
      .select({ id: core.runs.id, parentRunId: core.runs.parentRunId, costUsd: core.runs.costUsd })
      .from(core.runs)
      .where(eq(core.runs.workspaceId, seeded.workspaceId));
    expect(rows.filter((row) => row.parentRunId === null).map((row) => row.id)).toEqual([root.id]);
    const childRows = rows.filter((row) => row.parentRunId === root.id);
    expect(childRows).toHaveLength(2);

    const response = await readRun(new Request(`http://web.test/api/runs/${root.id}`), root.id);
    expect(response.status).toBe(200);
    const { run } = RunDetailResponseSchema.parse(await response.json());
    const children = run.children ?? [];
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.agentId).sort()).toEqual(
      [seeded.agents.writer, seeded.agents.critic].sort(),
    );
    const sum = rows.reduce((total, row) => total + Math.round(Number(row.costUsd) * 1_000_000), 0);
    expect(Math.round(Number(run.treeCost?.amount) * 1_000_000)).toBe(sum);
    expect(run.treeCost?.amount).toBe('0.437500');
  });

  it('leaves no child queued or running once the root is interrupted', async () => {
    const seeded = await seed(harness());
    const store = runStore(harness());
    const lead: { pending?: Promise<unknown> } = {};
    const { env } = environment(harness(), seeded, store, async (context, members) => {
      // The lead hands work to the writer and waits; the writer never finishes on its own.
      if (context.agent.id === seeded.agents.lead)
        lead.pending = members('writer', 'Draft forever.');
      return Promise.resolve();
    });
    const root = await startLead(seeded, env);
    await waitFor(async () => {
      const [child] = await store.listChildren(seeded.workspaceId, root.id, 16);
      return child?.status === 'running';
    });
    const current = await store.get(root.id);
    if (current === null) throw new Error('the root vanished');
    expect(await interruptRunFor(env, seeded.person, current)).toBe('stopped');

    const children = await store.listChildren(seeded.workspaceId, root.id, 16);
    expect(children).toHaveLength(1);
    expect(
      children.filter((child) => child.status === 'queued' || child.status === 'running'),
    ).toEqual([]);
    expect((await store.get(root.id))?.status).toBe('cancelled');
    // The member call the lead was waiting on answers with the cancellation, as a tool error.
    const answer = (await lead.pending) as { isError: boolean; content: { text: string }[] };
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toContain('team_member_cancelled');
  });
});
