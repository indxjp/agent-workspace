import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import {
  NO_REFERENCES,
  bodyWith,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
export function registerMaterialisationCases(
  fixture: ReturnType<typeof createAgentVersionFixture>,
) {
  const {
    workspaceA,
    userA,
    userB,
    principalA,
    principalB,
    skillId,
    connectorId,
    fileId,
    seedAgent,
    version,
    materialise,
    auditBy,
    auditRows,
    snapshot,
    violationsOf,
  } = fixture;

  it('applies a version and its assignments, narrowing read-write to read (#133)', async () => {
    const agentId = await seedAgent('applied');
    await version(agentId);
    const outcome = await fixture.repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'applied',
        references: {
          ...NO_REFERENCES,
          skillIds: [skillId],
          connectorIds: [connectorId],
          files: [{ fileId, access: 'read-write' }],
        },
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'applied',
      agent: { id: agentId, instructions: 'Be helpful.' },
      pointer: { agentId, environment: 'local', number: 1 },
    });
    const rows = await snapshot(agentId);
    expect(rows.fileRows.map((row) => row.access)).toEqual(['read']);
    expect(rows.skillRows.map((row) => row.skillId)).toEqual([skillId]);
    expect(rows.connectorRows.map((row) => row.mcpServerId)).toEqual([connectorId]);
    const listed = await fixture.repoA.list(agentId);
    expect(listed?.pointers).toEqual([
      expect.objectContaining({ environment: 'local', number: 1 }),
    ]);
    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 9,
        agent: materialise({}),
        audit: auditBy(),
      }),
    ).resolves.toEqual({ kind: 'version-not-found' });
    await expect(
      fixture.repoB.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 1,
        agent: materialise({}),
        audit: auditBy({ actorPrincipalId: principalB, actorUserId: userB }),
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('rolls everything back on a vanished reference and on a name conflict', async () => {
    const agentId = await seedAgent('atomic');
    await seedAgent('taken-name');
    await version(agentId);
    await version(agentId);
    const applied = await fixture.repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'atomic',
        references: {
          ...NO_REFERENCES,
          skillIds: [skillId],
          connectorIds: [connectorId],
          files: [{ fileId, access: 'read' }],
        },
      }),
    });
    expect(applied.kind).toBe('applied');
    const before = await snapshot(agentId);

    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({
          name: 'atomic',
          instructions: 'changed',
          references: { ...NO_REFERENCES, skillIds: [crypto.randomUUID()] },
        }),
      }),
    ).resolves.toEqual({ kind: 'reference-gone', referenceKind: 'skill' });
    expect(await snapshot(agentId)).toEqual(before);

    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'taken-name', instructions: 'changed' }),
      }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'taken-name' });
    expect(await snapshot(agentId)).toEqual(before);
  });

  it('writes exactly one agent-changed audit row for an applied move (#478, ADR-0101)', async () => {
    const agentId = await seedAgent('audited');
    await version(agentId);
    const outcome = await fixture.repoA.applyAndPoint(agentId, {
      reason: 'set',
      environment: 'local',
      number: 1,
      agent: materialise({ name: 'audited' }),
      audit: auditBy({ subjectLabel: 'audited: local -> version 1' }),
    });
    expect(outcome.kind).toBe('applied');
    const rows = await auditRows(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: workspaceA,
      action: 'agent-changed',
      subjectId: agentId,
      subjectLabel: 'audited: local -> version 1',
      actorPrincipalId: principalA,
      actorUserId: userA,
      actorLabel: 'Owner A',
    });
  });

  it('rolls the whole move back when its audit row cannot be written (#478 regression)', async () => {
    const agentId = await seedAgent('audit-refused');
    await version(agentId);
    await version(agentId);
    const applied = await fixture.repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'audit-refused',
        references: { ...NO_REFERENCES, skillIds: [skillId] },
      }),
    });
    expect(applied.kind).toBe('applied');
    const before = await snapshot(agentId);
    const auditsBefore = await auditRows(agentId);
    expect(auditsBefore).toHaveLength(1);

    // Another workspace's principal: the move's history row, written before the audit row, is
    // refused first by `agent_pointer_moves_moved_by_principal_workspace_fk` (#615).
    const crossWorkspace = await violationsOf(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'audit-refused-renamed', instructions: 'changed' }),
        audit: auditBy({ actorPrincipalId: principalB }),
      }),
    );
    expect(crossWorkspace).toContainEqual({
      code: '23503',
      constraint: 'agent_pointer_moves_moved_by_principal_workspace_fk',
    });
    expect(await snapshot(agentId)).toEqual(before);
    expect(await auditRows(agentId)).toEqual(auditsBefore);

    // A blank actor label: `audit_events_actor_label_not_blank` refuses the row.
    const blankLabel = await violationsOf(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'audit-refused-renamed', instructions: 'changed' }),
        audit: auditBy({ actorLabel: '   ' }),
      }),
    );
    expect(blankLabel).toContainEqual({
      code: '23514',
      constraint: 'audit_events_actor_label_not_blank',
    });
    expect(await snapshot(agentId)).toEqual(before);
    expect(await auditRows(agentId)).toEqual(auditsBefore);
  });

  it('writes no audit row for a refused move (#478)', async () => {
    const agentId = await seedAgent('audit-quiet');
    await seedAgent('audit-quiet-taken');
    const holder = await seedAgent('audit-quiet-holder');
    await version(agentId, bodyWith('quiet-surface'));
    await version(holder, bodyWith('quiet-surface'));
    await expect(
      fixture.repoA.applyAndPoint(holder, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'audit-quiet-holder' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });

    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 7,
        agent: materialise({ name: 'audit-quiet' }),
      }),
    ).resolves.toEqual({ kind: 'version-not-found' });
    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'audit-quiet' }),
      }),
    ).resolves.toEqual({ kind: 'surface-name-taken', name: 'quiet-surface' });
    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'audit-quiet-taken' }),
      }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'audit-quiet-taken' });
    expect(await auditRows(agentId)).toEqual([]);
  });
}
