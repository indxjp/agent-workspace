import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import { skills } from '../schema/skills.js';
import {
  NO_REFERENCES,
  bodyWith,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
export function registerCreationCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const {
    workspaceA,
    userA,
    principalA,
    skillId,
    seedAgent,
    version,
    materialise,
    auditBy,
    snapshot,
  } = fixture;

  it('C9: refuses a second agent serving the same surface name, leaving its pointer alone', async () => {
    const first = await seedAgent('surface-first');
    const second = await seedAgent('surface-second');
    await version(first, bodyWith('main'));
    await version(second, bodyWith('other'));
    await version(second, bodyWith('main', 'side'));
    await expect(
      fixture.repoA.applyAndPoint(first, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'surface-first' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      fixture.repoA.applyAndPoint(second, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'surface-second' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied', pointer: { number: 1 } });
    const before = await snapshot(second);

    await expect(
      fixture.repoA.applyAndPoint(second, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'surface-second', instructions: 'changed' }),
      }),
    ).resolves.toEqual({ kind: 'surface-name-taken', name: 'main' });
    expect(await snapshot(second)).toEqual(before);

    // Re-pointing the agent that already serves `main` is not a conflict with itself.
    await expect(
      fixture.repoA.applyAndPoint(first, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'surface-first' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });

    const firstVersion = await fixture.repoA.find(first, 1);
    await expect(fixture.repoA.findPointedSurface('local', 'main')).resolves.toEqual({
      agentId: first,
      versionId: firstVersion?.id,
      number: 1,
      surface: { name: 'main', kind: 'chat' },
    });
    await expect(fixture.repoA.findPointedSurface('local', 'other')).resolves.toMatchObject({
      agentId: second,
      number: 1,
    });
    await expect(fixture.repoA.findPointedSurface('local', 'unknown')).resolves.toBeNull();
    await expect(fixture.repoB.findPointedSurface('local', 'main')).resolves.toBeNull();
    // Issue #680: each pointed surface name once, not an unpointed version's, never another
    // workspace's.
    const names = await fixture.repoA.listPointedSurfaceNames();
    expect(names).toEqual(expect.arrayContaining(['main', 'other']));
    expect(names).not.toContain('side');
    expect(new Set(names).size).toBe(names.length);
    await expect(fixture.repoB.listPointedSurfaceNames()).resolves.not.toContain('main');

    // A persisted surface element without a string `name` is skipped, not fatal to the list.
    const malformed = await seedAgent('surface-malformed');
    const bad = await version(malformed, {
      surfaces: [{ kind: 'chat' }, 'bare', { name: 7 }, { name: 'third', kind: 'chat' }],
    });
    await fixture.isolated.db.insert(agentVersionPointers).values({
      workspaceId: workspaceA,
      agentId: malformed,
      environment: 'production',
      versionId: bad.id,
    });
    await expect(fixture.repoA.listPointedSurfaceNames()).resolves.toEqual(
      expect.arrayContaining(['main', 'other', 'third']),
    );
  });

  it('does not resolve a skill being deleted and refuses to assign it, as a conflict and not a missing name', async () => {
    const deletingId = crypto.randomUUID();
    await fixture.isolated.db.insert(skills).values({
      id: deletingId,
      workspaceId: workspaceA,
      name: 'being-deleted',
      skillMd: '# Gone',
      ownerPrincipalId: principalA,
      createdBy: userA,
      pendingDelete: { ownerPrincipalId: principalA, revisions: [] },
    });
    await expect(
      fixture.repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: ['being-deleted', 'nope'],
        connectors: [],
        files: [],
      }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'skill', name: 'nope' }],
      ambiguous: [],
      deleting: [{ kind: 'skill', name: 'being-deleted' }],
    });
    // Marked between resolve and write: a typed outcome, not an escaped rollback.
    await expect(
      fixture.repoA.createAgentWithFirstVersion({
        agent: {
          ...materialise({
            name: 'born-with-deleting',
            references: { ...NO_REFERENCES, skillIds: [deletingId] },
          }),
          ownerPrincipalId: principalA,
          createdBy: userA,
        },
        version: {
          summary: 'first',
          via: 'aw-push',
          body: bodyWith('born'),
          createdByPrincipalId: principalA,
        },
        environment: 'local',
      }),
    ).resolves.toEqual({ kind: 'reference-gone', referenceKind: 'skill' });
  });

  it('creates an agent with its first version atomically', async () => {
    const created = await fixture.repoA.createAgentWithFirstVersion({
      agent: {
        ...materialise({
          name: 'born-versioned',
          references: { ...NO_REFERENCES, skillIds: [skillId] },
        }),
        ownerPrincipalId: principalA,
        createdBy: userA,
      },
      version: {
        summary: 'first',
        via: 'aw-push',
        body: bodyWith('born'),
        createdByPrincipalId: principalA,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
    expect(created.version).toMatchObject({ number: 1, via: 'aw-push', agentId: created.agent.id });
    expect(created.pointer).toMatchObject({ number: 1, versionId: created.version.id });
    expect((await snapshot(created.agent.id)).skillRows).toHaveLength(1);
    await expect(fixture.repoA.listMoves(created.agent.id, null, 10)).resolves.toEqual([
      expect.objectContaining({
        environment: 'local',
        number: 1,
        reason: 'set',
        movedByPrincipalId: principalA,
      }),
    ]);

    const input = {
      ownerPrincipalId: principalA,
      createdBy: userA,
    };
    await expect(
      fixture.repoA.createAgentWithFirstVersion({
        agent: { ...materialise({ name: 'born-versioned' }), ...input },
        version: {
          summary: 'again',
          via: 'api',
          body: bodyWith(),
          createdByPrincipalId: principalA,
        },
        environment: 'local',
      }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'born-versioned' });

    // A refusal after the agent row was inserted (C9 runs last) still leaves no agent behind.
    await expect(
      fixture.repoA.createAgentWithFirstVersion({
        agent: { ...materialise({ name: 'born-refused' }), ...input },
        version: {
          summary: 'clash',
          via: 'api',
          body: bodyWith('born'),
          createdByPrincipalId: principalA,
        },
        environment: 'local',
      }),
    ).resolves.toEqual({ kind: 'surface-name-taken', name: 'born' });
    const left = await fixture.isolated.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceA), eq(agents.name, 'born-refused')));
    expect(left).toEqual([]);
    const orphanVersions = await fixture.isolated.db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(eq(agentVersions.summary, 'clash'));
    expect(orphanVersions).toEqual([]);
  });
}
