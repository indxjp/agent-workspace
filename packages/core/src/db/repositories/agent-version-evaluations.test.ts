import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentVersionEvaluations } from '../schema/agent-version-evaluations.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentVersionEvaluationRepositoryProvider } from './agent-version-evaluations.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('AgentVersionEvaluationRepository (issue #618)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_version_evaluations');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Evaluations' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Evaluated agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db.insert(agentVersions).values({
      id: versionId,
      workspaceId,
      agentId,
      number: 1,
      summary: 'first',
      via: 'api',
      body: {},
      createdByPrincipalId: principalId,
    });
  }, 180_000);

  afterAll(async () => isolated.close());

  async function evaluationsFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db).forScope(scope);
  }

  const input = {
    versionId,
    passed: 9,
    total: 10,
    casesSnapshot: [{ name: 'a', input: 'hi', expect: { tool: 't' } }],
    results: [{ name: 'a', passed: true, runId: null, failures: [] }],
    createdByPrincipalId: principalId,
  };

  it('stores the counts, the score and both snapshots', async () => {
    const evaluations = await evaluationsFor(workspaceId);
    const recorded = await evaluations.record(input);
    const [row] = await isolated.db
      .select()
      .from(agentVersionEvaluations)
      .where(eq(agentVersionEvaluations.id, recorded.id));
    expect(row).toMatchObject({
      workspaceId,
      versionId,
      score: '0.9000',
      passed: 9,
      total: 10,
      casesSnapshot: input.casesSnapshot,
      results: input.results,
      createdByPrincipalId: principalId,
      createdAt: recorded.createdAt,
    });
  });

  it('refuses a version of another workspace (tenant-paired FK)', async () => {
    const evaluations = await evaluationsFor(otherWorkspaceId);
    await expect(evaluations.record(input)).rejects.toThrow();
  });

  it('refuses counts that do not describe a score', async () => {
    const insert = (passed: number, total: number) =>
      isolated.db.execute(
        sql`insert into agent_version_evaluations
              (workspace_id, version_id, score, passed, total, cases_snapshot, results,
               created_by_principal_id)
            values (${workspaceId}, ${versionId}, 0, ${passed}, ${total}, '[]', '[]',
                    ${principalId})`,
      );
    await expect(insert(0, 0)).rejects.toThrow();
    await expect(insert(-1, 1)).rejects.toThrow();
    await expect(insert(2, 1)).rejects.toThrow();
  });

  it('reads the newest evaluation of exactly this version (issue #619)', async () => {
    const evaluations = await evaluationsFor(workspaceId);
    const otherVersionId = crypto.randomUUID();
    await isolated.db.insert(agentVersions).values({
      id: otherVersionId,
      workspaceId,
      agentId,
      number: 2,
      summary: 'second',
      via: 'api',
      body: {},
      createdByPrincipalId: principalId,
    });
    expect(await evaluations.latest(otherVersionId)).toBeNull();

    const failing = [{ name: 'a', passed: false, runId: null, failures: ['tool: t'] }];
    await evaluations.record({ ...input, passed: 3, total: 4, results: failing });
    const newest = await evaluations.record({ ...input, passed: 4, total: 4 });
    await evaluations.record({ ...input, versionId: otherVersionId, passed: 0, total: 1 });
    expect(await evaluations.latest(versionId)).toEqual({
      score: '1.0000',
      passed: 4,
      total: 4,
      results: input.results,
      createdAt: newest.createdAt,
    });
    expect(await evaluations.latest(otherVersionId)).toMatchObject({ passed: 0, total: 1 });
  });

  it("reads none for another workspace's version id (issue #619)", async () => {
    const evaluations = await evaluationsFor(otherWorkspaceId);
    expect(await evaluations.latest(versionId)).toBeNull();
  });

  describe('evaluation runs (issue #799)', () => {
    const cases = [
      { name: 'a', input: 'hi', expect: { tool: 't' } },
      { name: 'b', input: 'hi', expect: { tool: 't' } },
    ];
    const start = async (workspace = workspaceId) =>
      (await evaluationsFor(workspace)).start({
        versionId,
        total: 2,
        casesSnapshot: cases,
        createdByPrincipalId: principalId,
      });

    it('stores a running run that the promotion gate does not read', async () => {
      const evaluations = await evaluationsFor(workspaceId);
      const before = await evaluations.latest(versionId);
      const started = await start();
      expect(await evaluations.find(started.id)).toMatchObject({
        id: started.id,
        agentId,
        versionId,
        version: 1,
        status: 'running',
        score: '0.0000',
        passed: 0,
        total: 2,
        casesSnapshot: cases,
        results: [],
      });
      expect(await evaluations.latest(versionId)).toEqual(before);
    });

    it('reads an old-style row as completed', async () => {
      const evaluations = await evaluationsFor(workspaceId);
      const recorded = await evaluations.record(input);
      expect(await evaluations.find(recorded.id)).toMatchObject({ status: 'completed' });
    });

    it('does not find another workspace evaluation', async () => {
      const started = await start();
      expect(await (await evaluationsFor(otherWorkspaceId)).find(started.id)).toBeNull();
    });

    it('gives the lease to one claim until it expires or is released', async () => {
      const evaluations = await evaluationsFor(workspaceId);
      const started = await start();
      expect(await evaluations.claim(started.id, 60_000)).toMatchObject({ id: started.id });
      expect(await evaluations.claim(started.id, 60_000)).toBeNull();
      await evaluations.progress(started.id, {
        results: [{ name: 'a', passed: true, runId: null, failures: [] }],
        passed: 1,
        completed: false,
        release: true,
      });
      expect(await evaluations.claim(started.id, 1)).toMatchObject({ passed: 1, score: '0.5000' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await evaluations.claim(started.id, 60_000)).not.toBeNull();
    });

    it('does not let another workspace claim a run', async () => {
      const started = await start();
      expect(await (await evaluationsFor(otherWorkspaceId)).claim(started.id, 1000)).toBeNull();
    });

    it('completes a run once and then gates on it', async () => {
      const evaluations = await evaluationsFor(workspaceId);
      const started = await start();
      await evaluations.claim(started.id, 60_000);
      const results = [
        { name: 'a', passed: true, runId: null, failures: [] },
        { name: 'b', passed: true, runId: null, failures: [] },
      ];
      await evaluations.progress(started.id, {
        results,
        passed: 2,
        completed: true,
        release: true,
      });
      expect(await evaluations.find(started.id)).toMatchObject({
        status: 'completed',
        score: '1.0000',
        passed: 2,
        results,
      });
      expect(await evaluations.claim(started.id, 1000)).toBeNull();
      expect(await evaluations.latest(versionId)).toMatchObject({ score: '1.0000', passed: 2 });
      await evaluations.progress(started.id, {
        results: [],
        passed: 0,
        completed: false,
        release: true,
      });
      expect(await evaluations.find(started.id)).toMatchObject({ passed: 2 });
    });

    it('refuses a status that is neither running nor completed', async () => {
      await expect(
        isolated.db.execute(
          sql`insert into agent_version_evaluations
                (workspace_id, version_id, score, passed, total, cases_snapshot, results,
                 created_by_principal_id, status)
              values (${workspaceId}, ${versionId}, 0, 0, 1, '[]', '[]', ${principalId}, 'queued')`,
        ),
      ).rejects.toThrow();
    });
  });

  it('goes with its version', async () => {
    await isolated.db.delete(agentVersions).where(eq(agentVersions.id, versionId));
    const rows = await isolated.db
      .select()
      .from(agentVersionEvaluations)
      .where(eq(agentVersionEvaluations.versionId, versionId));
    expect(rows).toEqual([]);
  });
});
