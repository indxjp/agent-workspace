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
import { installTestRunApi } from '../application-context-fixtures';
import { interruptRunFor, readRun } from '../runs/api';
import type {
  AgentRef,
  LaunchContext,
  RunApiEnvironment,
  RunPrincipal,
  SessionRef,
} from '../runs/environment';
import { createRepositoryRunStore } from '../runs/repository-store';
import type { RunStore } from '../runs/store';
import { serveMemberTools, type MemberToolsEnvironment } from './member-tools';
import type { AgentTeamVersionRecord } from './runtime';

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

/** The declared test-only escape to the raw handle and the tables (see `store.test.ts`). */
type CoreDb = typeof import('@agent-workspace/core/db/unscoped');

/** The cost each run settles with: the lead's, then each member's, in the smallest unit summed. */
const COSTS = { lead: '0.125000', writer: '0.250000', critic: '0.062500' } as const;

describe.skipIf(!hasDatabase)('an agent team run over PostgreSQL', () => {
  let core: CoreDb;
  let isolated: Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;

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

  interface Seeded {
    readonly workspaceId: string;
    readonly person: RunPrincipal;
    readonly agents: Readonly<Record<'lead' | 'writer' | 'critic', string>>;
    readonly version: AgentTeamVersionRecord;
  }

  /** A workspace, its owner, three agents with a version each, and a team of them. */
  async function seed(): Promise<Seeded> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(core.workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Team' });
    await isolated.db
      .insert(core.users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Ada' });
    await isolated.db
      .insert(core.memberships)
      .values({ id: membershipId, workspaceId, userId, role: 'owner' });
    const principal = (await isolated.db.select().from(core.workspacePrincipals)).find(
      (candidate) => candidate.membershipId === membershipId,
    );
    if (principal === undefined) throw new Error('the membership trigger created no principal');
    const pins: Record<string, { agentId: string; agentVersionId: string }> = {};
    for (const name of ['lead', 'writer', 'critic'] as const) {
      const agentId = crypto.randomUUID();
      const agentVersionId = crypto.randomUUID();
      await isolated.db.insert(core.agents).values({
        id: agentId,
        workspaceId,
        name,
        instructions: '',
        modelConnectionId: null,
        model: null,
        createdBy: userId,
        ownerPrincipalId: principal.id,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await isolated.db.insert(core.agentVersions).values({
        id: agentVersionId,
        workspaceId,
        agentId,
        number: 1,
        summary: 'first',
        via: 'api',
        body: {},
        createdByPrincipalId: principal.id,
      });
      pins[name] = { agentId, agentVersionId };
    }
    const scope = await core
      .createDatabaseWorkspaceScopeResolver(isolated.db)
      .forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('the seeded workspace did not resolve');
    const lead = pins['lead'];
    const writer = pins['writer'];
    const critic = pins['critic'];
    if (lead === undefined || writer === undefined || critic === undefined)
      throw new Error('unseeded');
    const created = await core
      .createDatabaseAgentTeamRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({
        name: 'Launch',
        ownerPrincipalId: principal.id,
        createdBy: userId,
        version: { lead, members: [writer, critic] },
      });
    if (created.kind !== 'created' || created.team.latestVersion === null)
      throw new Error(created.kind);
    return {
      workspaceId,
      person: {
        principalId: principal.id,
        ownerPrincipalId: principal.id,
        userId,
        workspaceId,
        role: 'owner',
        scope: null,
        via: 'session',
        kind: 'membership',
      },
      agents: { lead: lead.agentId, writer: writer.agentId, critic: critic.agentId },
      version: created.team.latestVersion,
    };
  }

  function runStore(): RunStore {
    return createRepositoryRunStore({
      repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
      events: core.createDatabaseRunEventRepositoryProvider(isolated.db),
      scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
      findRunWorkspace: (id: string): Promise<string | null> =>
        core.findRunWorkspace(isolated.db, id),
    });
  }

  /** Settle a run as the runtime and the ledger would: priced, with its cost, then `completed`. */
  async function settle(store: RunStore, runId: string, cost: string, text: string): Promise<void> {
    await isolated.db
      .update(core.runs)
      .set({ costUsd: cost, accountingState: 'complete', priceTableVersion: '2026-11' })
      .where(eq(core.runs.id, runId));
    await store.finish(runId, 'completed', null, true, { text, structured: null });
  }

  /**
   * The run routes over the real store and session rows, with a runtime double: `play` runs the
   * agent of each launched run. The member endpoint is served in-process with the lead's identity.
   */
  function environment(
    seeded: Seeded,
    store: RunStore,
    play: (
      context: LaunchContext,
      members: (name: string, prompt: string) => Promise<unknown>,
    ) => Promise<void>,
  ) {
    const scopes = core.createDatabaseWorkspaceScopeResolver(isolated.db);
    const sessions = core.createDatabaseSessionRepositoryProvider(isolated.db);
    const settled: Promise<void>[] = [];
    const env: RunApiEnvironment = {
      authenticate: () => Promise.resolve(seeded.person),
      findAgent: (principal, agentId): Promise<AgentRef | null> =>
        Promise.resolve({
          id: agentId,
          workspaceId: principal.workspaceId,
          engine: 'claude-agent-sdk',
        }),
      openSession: async (
        principal,
        agent,
        requested,
        agentVersionId,
      ): Promise<SessionRef | null> => {
        if (requested !== null) return { id: requested, agentId: agent.id, engine: null };
        const id = crypto.randomUUID();
        await isolated.db.insert(core.sessions).values({
          id,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          agentId: agent.id,
          ownerPrincipalId: principal.ownerPrincipalId,
          agentVersionId: agentVersionId ?? null,
        });
        const scope = await scopes.forWorkspaceId(principal.workspaceId);
        if (scope === null || (await sessions.forScope(scope).get(id)) === null) return null;
        return { id, agentId: agent.id, engine: null };
      },
      ownsRun: () => Promise.resolve(true),
      store,
      launch: (context) => {
        const members = async (name: string, prompt: string) => {
          const response = await serveMemberTools(
            memberCall(context.run.id, name, prompt),
            context.run.id,
            memberEnv,
          );
          return ((await response.json()) as { result: unknown }).result;
        };
        settled.push(
          (async () => {
            await store.markRunning(context.run.id);
            await play(context, members);
          })(),
        );
      },
      interruptRun: async (_principal, run) => {
        await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
      },
    };
    const memberEnv: MemberToolsEnvironment = {
      verifyCaller: (authorization) => {
        const runId = /^Bearer lead:(.+)$/u.exec(authorization ?? '')?.[1];
        return Promise.resolve(
          runId === undefined
            ? null
            : {
                runId,
                workspaceId: seeded.workspaceId,
                expiresAtMs: Date.now() + 60_000,
                person: seeded.person,
              },
        );
      },
      runs: env,
      teamVersion: async (workspaceId, versionId) => {
        const scope = await scopes.forWorkspaceId(workspaceId);
        return scope === null
          ? null
          : core
              .createDatabaseAgentTeamRepositoryProvider(isolated.db)
              .forScope(scope)
              .getVersion(versionId);
      },
      mayRunAgent: () => Promise.resolve(true),
      pollIntervalMs: 5,
    };
    installTestRunApi(env);
    return { env, settled };
  }

  function memberCall(leadRunId: string, name: string, prompt: string): Request {
    return new Request(`http://web.test/api/runs/${leadRunId}/members/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer lead:${leadRunId}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: { prompt } },
      }),
    });
  }

  /** Start the team's lead as `POST /api/agent-teams/:id/runs` does: the lead, its version, the team version. */
  async function startLead(seeded: Seeded, env: RunApiEnvironment) {
    const { startRunOnSession } = await import('../runs/service');
    const started = await startRunOnSession(
      env,
      seeded.person,
      { id: seeded.agents.lead, workspaceId: seeded.workspaceId, engine: 'claude-agent-sdk' },
      {
        prompt: 'Write and review the launch note.',
        sessionId: null,
        modelOverride: null,
        agentVersionId: seeded.version.lead.agentVersionId,
        agentTeamVersionId: seeded.version.id,
      },
    );
    if (started.kind !== 'started') throw new Error(started.code);
    return started.run;
  }

  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the condition was never met');
  }

  it('gives a lead that calls two members one root, two children and the summed treeCost', async () => {
    const seeded = await seed();
    const store = runStore();
    const answers: unknown[] = [];
    const { env, settled } = environment(seeded, store, async (context, members) => {
      if (context.agent.id === seeded.agents.lead) {
        answers.push(await members('writer', 'Draft the note.'));
        answers.push(await members('critic', 'Review the draft.'));
        await settle(store, context.run.id, COSTS.lead, 'the reviewed note');
        return;
      }
      const writer = context.agent.id === seeded.agents.writer;
      await settle(
        store,
        context.run.id,
        writer ? COSTS.writer : COSTS.critic,
        writer ? 'a draft' : 'a review',
      );
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
    const seeded = await seed();
    const store = runStore();
    const lead: { pending?: Promise<unknown> } = {};
    const { env } = environment(seeded, store, async (context, members) => {
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
