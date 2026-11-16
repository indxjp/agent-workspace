import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agents } from '../schema/agents.js';
import {
  READ_ONLY,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
import { createDatabaseSessionRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
export function registerSessionVersionCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const {
    workspaceA,
    workspaceB,
    userB,
    principalA,
    principalB,
    seedAgent,
    version,
    violationsOf,
  } = fixture;

  it('finds a version by id in its own workspace only', async () => {
    const agentId = await seedAgent('by-id');
    const v1 = await version(agentId);
    await expect(fixture.repoA.findById(v1.id)).resolves.toEqual(v1);
    await expect(fixture.repoB.findById(v1.id)).resolves.toBeNull();
    await expect(fixture.repoA.findById(crypto.randomUUID())).resolves.toBeNull();
  });

  describe('sessions.agent_version_id (#612)', () => {
    const sessionsOf = async (workspaceId: string) => {
      const scope = await createDatabaseWorkspaceScopeResolver(fixture.isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('workspace fixture did not resolve');
      return createDatabaseSessionRepositoryProvider(fixture.isolated.db).forScope(scope);
    };

    it('pins the version on insert and keeps it when the session is ensured again', async () => {
      const agentId = await seedAgent('pinned');
      const v1 = await version(agentId);
      const v2 = await version(agentId);
      const sessionsA = await sessionsOf(workspaceA);
      const id = crypto.randomUUID();
      const input = { id, agentId, ownerPrincipalId: principalA };

      await expect(sessionsA.ensure({ ...input, agentVersionId: v1.id })).resolves.toMatchObject({
        kind: 'created',
        session: { id, agentVersionId: v1.id },
      });
      await expect(sessionsA.ensure({ ...input, agentVersionId: v2.id })).resolves.toMatchObject({
        kind: 'existing',
        session: { id, agentVersionId: v1.id },
      });
      await expect(sessionsA.get(id)).resolves.toMatchObject({ agentVersionId: v1.id });
    });

    it('stores NULL for a legacy session', async () => {
      const agentId = await seedAgent('legacy');
      const sessionsA = await sessionsOf(workspaceA);
      const outcome = await sessionsA.ensure({
        id: crypto.randomUUID(),
        agentId,
        ownerPrincipalId: principalA,
      });
      expect(outcome).toMatchObject({ kind: 'created', session: { agentVersionId: null } });
    });

    it("refuses another agent's or another workspace's version (sessions_agent_version_fk)", async () => {
      const agentId = await seedAgent('pin-owner');
      const other = await seedAgent('pin-borrower');
      const v1 = await version(other);
      const sessionsA = await sessionsOf(workspaceA);
      const borrowed = await violationsOf(
        sessionsA.ensure({
          id: crypto.randomUUID(),
          agentId,
          ownerPrincipalId: principalA,
          agentVersionId: v1.id,
        }),
      );
      expect(borrowed).toEqual([{ code: '23503', constraint: 'sessions_agent_version_fk' }]);

      const agentB = crypto.randomUUID();
      await fixture.isolated.db.insert(agents).values({
        id: agentB,
        workspaceId: workspaceB,
        name: 'pin-tenant',
        instructions: '',
        permissions: READ_ONLY,
        ownerPrincipalId: principalB,
        createdBy: userB,
      });
      const sessionsB = await sessionsOf(workspaceB);
      const crossTenant = await violationsOf(
        sessionsB.ensure({
          id: crypto.randomUUID(),
          agentId: agentB,
          ownerPrincipalId: principalB,
          agentVersionId: v1.id,
        }),
      );
      expect(crossTenant).toEqual([{ code: '23503', constraint: 'sessions_agent_version_fk' }]);
    });

    it('deleting the agent removes its versions and its pinned sessions together', async () => {
      const agentId = await seedAgent('pin-cascade');
      const v1 = await version(agentId);
      const sessionsA = await sessionsOf(workspaceA);
      const id = crypto.randomUUID();
      await sessionsA.ensure({ id, agentId, ownerPrincipalId: principalA, agentVersionId: v1.id });

      await fixture.isolated.db.delete(agents).where(eq(agents.id, agentId));

      await expect(sessionsA.get(id)).resolves.toBeNull();
      await expect(fixture.repoA.findById(v1.id)).resolves.toBeNull();
    });
  });
}
