import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { files } from '../schema/files.js';
import { type AgentPointerMoveReason } from './agent-versions.js';
import {
  NO_REFERENCES,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
export function registerReferencesCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const {
    workspaceA,
    userA,
    principalA,
    skillId,
    connectorId,
    fileId,
    seedAgent,
    version,
    materialise,
    auditBy,
    snapshot,
  } = fixture;

  it('appends one history row per move, newest first, scoped to the workspace (#615)', async () => {
    const agentId = await seedAgent('history');
    await version(agentId);
    await version(agentId);
    const move = (
      number: number,
      environment: 'local' | 'production',
      reason: AgentPointerMoveReason,
    ) =>
      fixture.repoA.applyAndPoint(agentId, {
        reason,
        environment,
        number,
        agent: materialise({ name: 'history' }),
        audit: auditBy(),
      });
    await expect(move(1, 'local', 'set')).resolves.toMatchObject({ kind: 'applied' });
    await expect(move(2, 'local', 'set')).resolves.toMatchObject({ kind: 'applied' });
    await expect(move(2, 'production', 'promote')).resolves.toMatchObject({ kind: 'applied' });
    await expect(move(1, 'production', 'rollback')).resolves.toMatchObject({ kind: 'applied' });
    // A refused move appends nothing.
    await expect(move(9, 'production', 'promote')).resolves.toEqual({
      kind: 'version-not-found',
    });

    const moves = await fixture.repoA.listMoves(agentId, null, 10);
    expect(moves.map(({ environment, number, reason }) => [environment, number, reason])).toEqual([
      ['production', 1, 'rollback'],
      ['production', 2, 'promote'],
      ['local', 2, 'set'],
      ['local', 1, 'set'],
    ]);
    expect(moves.every((row) => row.movedByPrincipalId === principalA)).toBe(true);
    const production = await fixture.repoA.listMoves(agentId, 'production', 2);
    expect(production.map((row) => row.number)).toEqual([1, 2]);
    // The head of each environment's history is its pointer.
    const listed = await fixture.repoA.list(agentId);
    expect(listed?.pointers.map((row) => [row.environment, row.number])).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    // Another workspace never sees these rows.
    await expect(fixture.repoB.listMoves(agentId, null, 10)).resolves.toEqual([]);
  });

  it('resolves names exactly and reports a missing skill', async () => {
    await expect(
      fixture.repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: ['reviewer'],
        connectors: ['github'],
        files: [{ path: 'handbook', access: 'read' }],
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      references: {
        modelConnectionId: null,
        runtimeProfileId: null,
        skillIds: [skillId],
        connectorIds: [connectorId],
        files: [{ fileId, access: 'read' }],
      },
    });
    await expect(
      fixture.repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: 'nowhere',
        skills: ['nope', 'reviewer'],
        connectors: ['GitHub'],
        files: [],
      }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [
        { kind: 'skill', name: 'nope' },
        { kind: 'connector', name: 'GitHub' },
        { kind: 'runtime-profile', name: 'nowhere' },
      ],
      ambiguous: [],
    });
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] does not resolve a pending upload by path or id', async () => {
    const pendingId = crypto.randomUUID();
    await fixture.isolated.db.insert(files).values({
      id: pendingId,
      workspaceId: workspaceA,
      path: 'pending-upload.pdf',
      kind: 'file',
      storageKey: 'pending-upload.pdf',
      objectId: crypto.randomUUID(),
      status: 'pending',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const result = await fixture.repoA.resolveDefinition({
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [{ path: 'pending-upload.pdf', access: 'read' }],
    });
    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).toContain('pending-upload.pdf');
    // The id lookup (`namesOf`) is the other branch of the same file query.
    const byId = await fixture.repoA.namesOf({ file: [pendingId] });
    expect(byId.file.has(pendingId)).toBe(false);
  });

  it('resolves a skill revision pin only once that revision is published, and writes it with the assignment (SDK-19, N-1)', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: ['reviewer'],
      skillRevisions: { reviewer: 1 },
      connectors: [],
      files: [],
    };
    await expect(fixture.repoA.resolveDefinition(references)).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'skill', name: 'reviewer@1' }],
      ambiguous: [],
    });

    await fixture.catalogA.publishSkillRevision('reviewer', {
      fileCount: 1,
      write: () => Promise.resolve(undefined),
    });
    await expect(fixture.repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { skillIds: [skillId], skillRevisions: { [skillId]: 1 } },
    });
    // Another workspace has no such skill, so it has no such revision either.
    await expect(fixture.repoB.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
    });

    const agentId = await seedAgent('pins-a-revision');
    await version(agentId);
    const applied = await fixture.repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'pins-a-revision',
        references: { ...NO_REFERENCES, skillIds: [skillId], skillRevisions: { [skillId]: 1 } },
      }),
    });
    expect(applied.kind).toBe('applied');
    expect((await snapshot(agentId)).skillRows).toMatchObject([{ skillId, revision: 1 }]);
  });
}
