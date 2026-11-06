import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agents } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { bodyWith, type createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
export function registerConstraintsCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const {
    workspaceA,
    workspaceB,
    principalA,
    principalB,
    seedAgent,
    version,
    materialise,
    auditBy,
    snapshot,
    violationsOf,
  } = fixture;

  it('refuses a pointer that names another workspace (agent_version_pointers_agent_workspace_fk)', async () => {
    const agentId = await seedAgent('cross-workspace');
    const v1 = await version(agentId);
    const violations = await violationsOf(
      fixture.isolated.db
        .insert(agentVersionPointers)
        .values({ workspaceId: workspaceB, agentId, environment: 'local', versionId: v1.id }),
    );
    expect(violations).toContainEqual({
      code: '23503',
      constraint: 'agent_version_pointers_agent_workspace_fk',
    });
  });

  it('refuses a pointer to another agent’s version (agent_version_pointers_version_fk)', async () => {
    const owner = await seedAgent('version-owner');
    const other = await seedAgent('version-borrower');
    const v1 = await version(owner);
    const violations = await violationsOf(
      fixture.isolated.db.insert(agentVersionPointers).values({
        workspaceId: workspaceA,
        agentId: other,
        environment: 'local',
        versionId: v1.id,
      }),
    );
    expect(violations).toEqual([
      { code: '23503', constraint: 'agent_version_pointers_version_fk' },
    ]);
  });

  it("stores and lists a version with via 'builder' (#1847)", async () => {
    const agentId = await seedAgent('builder-via');
    const outcome = await fixture.repoA.create(agentId, {
      summary: 'saved by the Builder',
      via: 'builder',
      body: bodyWith(),
      createdByPrincipalId: principalA,
    });
    expect(outcome.kind).toBe('created');
    const listed = await fixture.repoA.list(agentId);
    expect(listed?.versions.map((row) => row.via)).toEqual(['builder']);
    await expect(fixture.repoA.find(agentId, 1)).resolves.toMatchObject({
      number: 1,
      via: 'builder',
    });
  });

  it('numbers two concurrent versions 1 and 2', async () => {
    const agentId = await seedAgent('concurrent');
    const [first, second] = await Promise.all([version(agentId), version(agentId)]);
    expect([first.number, second.number].sort()).toEqual([1, 2]);
    const listed = await fixture.repoA.list(agentId);
    expect(listed?.versions.map((row) => row.number)).toEqual([1, 2]);
    await expect(fixture.repoA.find(agentId, 2)).resolves.toMatchObject({ number: 2, via: 'api' });
    await expect(fixture.repoA.find(agentId, 3)).resolves.toBeNull();
  });

  it('answers not-found for another workspace’s agent, and unknown-principal for a stranger', async () => {
    const agentId = await seedAgent('scoped');
    await expect(
      fixture.repoB.create(agentId, {
        summary: 'x',
        via: 'ui',
        body: bodyWith(),
        createdByPrincipalId: principalB,
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(fixture.repoB.list(agentId)).resolves.toBeNull();
    await expect(
      fixture.repoA.create(agentId, {
        summary: 'x',
        via: 'ui',
        body: bodyWith(),
        createdByPrincipalId: principalB,
      }),
    ).resolves.toEqual({ kind: 'unknown-principal' });
  });

  it.each(['local', 'production'] as const)(
    'refuses a %s move of an archived agent from the locked row and writes nothing (#1987)',
    async (environment) => {
      const agentId = await seedAgent(`archived-${environment}`);
      await version(agentId);
      await fixture.isolated.db
        .update(agents)
        .set({ archivedAt: new Date('2026-01-02T03:04:05.000Z') })
        .where(eq(agents.id, agentId));
      const before = await snapshot(agentId);
      const auditsBefore = await fixture.isolated.db.$count(
        auditEvents,
        and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, agentId)),
      );

      await expect(
        fixture.repoA.applyAndPoint(agentId, {
          reason: 'set',
          audit: auditBy(),
          environment,
          number: 1,
          agent: materialise({ name: `archived-${environment}` }),
        }),
      ).resolves.toEqual({ kind: 'agent-archived' });

      expect((await fixture.repoA.list(agentId))?.pointers).toEqual([]);
      expect(await snapshot(agentId)).toEqual(before);
      expect(
        await fixture.isolated.db.$count(
          auditEvents,
          and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, agentId)),
        ),
      ).toBe(auditsBefore);
    },
  );
}
