/**
 * `runs.parent_run_id` against a real PostgreSQL (ADR-0104 acceptance decisions 1, 5 and 7; issue
 * #1516): a child run names a lead run of its own workspace, never another workspace's run and
 * never itself, and every run recorded without a parent is a root.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs-parent.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

interface Tenant {
  readonly workspaceId: string;
  readonly sessionId: string;
}

async function violationOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return [...postgresViolations(error)].map((violation) => violation.constraint);
  }
  throw new Error('expected the statement to be refused');
}

describe.skipIf(!hasDatabase)('runs.parent_run_id (ADR-0104 acceptance)', () => {
  let isolated: IsolatedTestDatabase;
  let mine: Tenant;
  let theirs: Tenant;

  async function seedTenant(): Promise<Tenant> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const { db } = isolated;
    await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Runs' });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Lead',
      instructions: '',
      ownerPrincipalId: principalId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    return { workspaceId, sessionId };
  }

  async function insertRun(owner: Tenant, parentRunId: string | null = null): Promise<string> {
    const rows = await isolated.db
      .insert(runs)
      .values({ workspaceId: owner.workspaceId, sessionId: owner.sessionId, parentRunId })
      .returning({ id: runs.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('run insert returned no row');
    return id;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_runs_parent');
    mine = await seedTenant();
    theirs = await seedTenant();
  }, 180_000);

  afterAll(async () => isolated.close());

  it('records a run without a parent as a root', async () => {
    const id = await insertRun(mine);
    const rows = await isolated.db
      .select({ parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, id));
    expect(rows).toEqual([{ parentRunId: null }]);
  });

  it('accepts a child of a run of the same workspace', async () => {
    const lead = await insertRun(mine);
    const child = await insertRun(mine, lead);
    const rows = await isolated.db
      .select({ parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, child));
    expect(rows).toEqual([{ parentRunId: lead }]);
  });

  it("refuses a parent that is another workspace's run", async () => {
    const foreign = await insertRun(theirs);
    await expect(violationOf(insertRun(mine, foreign))).resolves.toContain(
      'runs_parent_workspace_fk',
    );
  });

  it('refuses a run that names itself as its parent', async () => {
    const id = await insertRun(mine);
    await expect(
      violationOf(isolated.db.update(runs).set({ parentRunId: id }).where(eq(runs.id, id))),
    ).resolves.toContain('runs_parent_not_self');
  });

  it("lists a run's children oldest first through the repository, in its own workspace only", async () => {
    const lead = await insertRun(mine);
    const first = await insertRun(mine, lead);
    const second = await insertRun(mine, lead);
    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const provider = createDatabaseRunRepositoryProvider(isolated.db);
    const myScope = await scopes.forWorkspaceId(mine.workspaceId);
    const theirScope = await scopes.forWorkspaceId(theirs.workspaceId);
    if (myScope === null || theirScope === null) throw new Error('the seeded workspaces vanished');
    const children = await provider.forScope(myScope).listChildren(lead, 16);
    expect(children.map((child) => child.id).sort()).toEqual([first, second].sort());
    expect(children.every((child) => child.parentRunId === lead)).toBe(true);
    const ordered = children.map((child) => child.createdAt.getTime());
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    await expect(provider.forScope(myScope).listChildren(lead, 1)).resolves.toHaveLength(1);
    await expect(provider.forScope(theirScope).listChildren(lead, 16)).resolves.toEqual([]);
    await expect(provider.forScope(myScope).listChildren('not-a-uuid', 16)).resolves.toEqual([]);
    const root = await provider.forScope(myScope).get(lead);
    expect(root?.parentRunId).toBeNull();
  });
});

describe.skipIf(!hasDatabase)(
  'creating a child run through the repository (ADR-0104, #1517)',
  () => {
    let isolated: IsolatedTestDatabase;
    let workspaceId = '';
    let template: typeof sessions.$inferSelect | undefined;

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_runs_parent_create');
      const workspace = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      const { db } = isolated;
      await db.insert(workspaces).values({ id: workspace, slug: workspace, name: 'Children' });
      await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId: workspace, userId, role: 'owner' });
        await tx
          .insert(workspacePrincipals)
          .values({ id: principalId, workspaceId: workspace, kind: 'membership', membershipId });
      });
      await db.insert(agents).values({
        id: agentId,
        workspaceId: workspace,
        name: 'Member',
        instructions: '',
        ownerPrincipalId: principalId,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      const [row] = await db
        .insert(sessions)
        .values({ workspaceId: workspace, userId, ownerPrincipalId: principalId, agentId })
        .returning();
      template = row;
      workspaceId = workspace;
    }, 180_000);

    afterAll(async () => isolated.close());

    /** A fresh session of the seeded agent, so each child is the only run of its session. */
    async function newSession(): Promise<string> {
      if (template === undefined) throw new Error('the seeded session vanished');
      const [row] = await isolated.db
        .insert(sessions)
        .values({
          workspaceId: template.workspaceId,
          userId: template.userId,
          ownerPrincipalId: template.ownerPrincipalId,
          agentId: template.agentId,
        })
        .returning({ id: sessions.id });
      if (row === undefined) throw new Error('session insert returned no row');
      return row.id;
    }

    it('writes parent_run_id, and refuses the child over maxChildren with child-limit', async () => {
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('the seeded workspace vanished');
      const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
      const lead = await repository.create({
        id: crypto.randomUUID(),
        sessionId: await newSession(),
        engine: 'claude-agent-sdk',
      });
      if (lead.kind !== 'created') throw new Error(lead.kind);
      expect(lead.run.parentRunId).toBeNull();
      expect((await repository.markRunning(lead.run.id)).kind).toBe('moved');
      const parent = { runId: lead.run.id, maxChildren: 2 };
      for (let index = 0; index < 2; index += 1) {
        const child = await repository.create({
          id: crypto.randomUUID(),
          sessionId: await newSession(),
          engine: 'claude-agent-sdk',
          parent,
        });
        expect(child).toMatchObject({ kind: 'created', run: { parentRunId: lead.run.id } });
      }
      const over = await repository.create({
        id: crypto.randomUUID(),
        sessionId: await newSession(),
        engine: 'claude-agent-sdk',
        parent,
      });
      expect(over).toEqual({ kind: 'child-limit', runId: lead.run.id });
      await expect(repository.listChildren(lead.run.id, 16)).resolves.toHaveLength(2);
    });

    /** A root run that is `running`, as a lead whose member calls start children is. */
    async function runningRoot() {
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('the seeded workspace vanished');
      const repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
      const lead = await repository.create({
        id: crypto.randomUUID(),
        sessionId: await newSession(),
        engine: 'claude-agent-sdk',
      });
      if (lead.kind !== 'created') throw new Error(lead.kind);
      expect((await repository.markRunning(lead.run.id)).kind).toBe('moved');
      return { repository, leadId: lead.run.id };
    }

    it('refuses a child of a root that is no longer running with parent-stopped', async () => {
      const { repository, leadId } = await runningRoot();
      expect((await repository.finish(leadId, 'cancelled', null)).kind).toBe('moved');
      const refused = await repository.create({
        id: crypto.randomUUID(),
        sessionId: await newSession(),
        engine: 'claude-agent-sdk',
        parent: { runId: leadId, maxChildren: 16 },
      });
      expect(refused).toEqual({ kind: 'parent-stopped', runId: leadId });
      await expect(repository.listChildren(leadId, 16)).resolves.toEqual([]);
    });

    it('counts a continuation of a child against the 16 children of its root', async () => {
      const { repository, leadId } = await runningRoot();
      const parent = { runId: leadId, maxChildren: 16 };
      const sessionIds: string[] = [];
      const childIds: string[] = [];
      for (let index = 0; index < 16; index += 1) {
        const sessionId = await newSession();
        const child = await repository.create({
          id: crypto.randomUUID(),
          sessionId,
          engine: 'claude-agent-sdk',
          parent,
        });
        if (child.kind !== 'created') throw new Error(child.kind);
        sessionIds.push(sessionId);
        childIds.push(child.run.id);
      }
      const pausedId = childIds[0];
      const pausedSession = sessionIds[0];
      if (pausedId === undefined || pausedSession === undefined) throw new Error('no child');
      expect((await repository.markRunning(pausedId)).kind).toBe('moved');
      const call = { toolName: 'send_email', canonicalCall: '{"to":"a@example.test"}' } as const;
      expect((await repository.awaitApproval(pausedId, call)).kind).toBe('moved');
      const continuation = await repository.create({
        id: crypto.randomUUID(),
        sessionId: pausedSession,
        engine: 'claude-agent-sdk',
        decides: { runId: pausedId },
        approvedToolCalls: [call],
      });
      expect(continuation).toEqual({ kind: 'child-limit', runId: leadId });
      await expect(repository.get(pausedId)).resolves.toMatchObject({
        status: 'awaiting_approval',
      });
      await expect(repository.listChildren(leadId, 200)).resolves.toHaveLength(16);
    });

    it('lets a continuation of a child under the limit stay in its root tree', async () => {
      const { repository, leadId } = await runningRoot();
      const sessionId = await newSession();
      const child = await repository.create({
        id: crypto.randomUUID(),
        sessionId,
        engine: 'claude-agent-sdk',
        parent: { runId: leadId, maxChildren: 16 },
      });
      if (child.kind !== 'created') throw new Error(child.kind);
      expect((await repository.markRunning(child.run.id)).kind).toBe('moved');
      const call = { toolName: 'send_email', canonicalCall: '{"to":"a@example.test"}' } as const;
      expect((await repository.awaitApproval(child.run.id, call)).kind).toBe('moved');
      const continuation = await repository.create({
        id: crypto.randomUUID(),
        sessionId,
        engine: 'claude-agent-sdk',
        decides: { runId: child.run.id },
        approvedToolCalls: [call],
      });
      expect(continuation).toMatchObject({ kind: 'created', run: { parentRunId: leadId } });
    });
  },
);
