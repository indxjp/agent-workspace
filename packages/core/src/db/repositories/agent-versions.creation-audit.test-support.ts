import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { bodyWith, type createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
export function registerCreationAuditCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const { workspaceA, userA, principalA, materialise, violationsOf } = fixture;

  describe('agentCreatedAudit', () => {
    const created = (name: string) => ({
      agent: { ...materialise({ name }), ownerPrincipalId: principalA, createdBy: userA },
      version: {
        summary: name,
        via: 'builder' as const,
        body: bodyWith(name),
        createdByPrincipalId: principalA,
      },
      environment: 'local' as const,
    });
    const audit = (overrides: { actorLabel?: string } = {}) => ({
      actorPrincipalId: principalA,
      actorUserId: userA,
      actorLabel: 'Owner A',
      details: { builderRunId: 'run-1' },
      ...overrides,
    });
    const createdRows = (name: string) =>
      fixture.isolated.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceA),
            eq(auditEvents.action, 'agent-created'),
            eq(auditEvents.subjectLabel, name),
          ),
        );
    const pointerCount = async () =>
      (
        await fixture.isolated.db
          .select({ id: agentVersionPointers.agentId })
          .from(agentVersionPointers)
          .where(eq(agentVersionPointers.workspaceId, workspaceA))
      ).length;

    it('leaves no agent, version, pointer or audit row when the audit row is refused', async () => {
      const name = 'born-audit-refused';
      const pointersBefore = await pointerCount();

      const violations = await violationsOf(
        fixture.repoA.createAgentWithFirstVersion({
          ...created(name),
          agentCreatedAudit: audit({ actorLabel: '   ' }),
        }),
      );

      expect(violations).toContainEqual({
        code: '23514',
        constraint: 'audit_events_actor_label_not_blank',
      });
      expect(
        await fixture.isolated.db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.workspaceId, workspaceA), eq(agents.name, name))),
      ).toEqual([]);
      expect(
        await fixture.isolated.db
          .select({ id: agentVersions.id })
          .from(agentVersions)
          .where(eq(agentVersions.summary, name)),
      ).toEqual([]);
      expect(await pointerCount()).toBe(pointersBefore);
      expect(await createdRows(name)).toEqual([]);
    });

    it('writes exactly one agent-created row naming the agent, version 1 and the run', async () => {
      const name = 'born-audited';

      const result = await fixture.repoA.createAgentWithFirstVersion({
        ...created(name),
        agentCreatedAudit: audit(),
      });

      if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
      expect(await createdRows(name)).toMatchObject([
        {
          subjectId: result.agent.id,
          actorPrincipalId: principalA,
          actorUserId: userA,
          actorLabel: 'Owner A',
          details: { agentId: result.agent.id, version: 1, via: 'builder', builderRunId: 'run-1' },
        },
      ]);
    });

    it('writes no agent-created row without the input', async () => {
      const name = 'born-unaudited';

      const result = await fixture.repoA.createAgentWithFirstVersion(created(name));

      expect(result.kind).toBe('created');
      expect(await createdRows(name)).toEqual([]);
    });
  });
}
