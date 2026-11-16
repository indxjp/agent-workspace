import { and, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { modelConnections } from '../schema/model-connections.js';
import {
  NO_REFERENCES,
  bodyWith,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
import { createDatabaseRuntimeProfileRepositoryProvider } from './runtime-profiles.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
export function registerEnvironmentsCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const {
    workspaceA,
    skillId,
    connectorId,
    fileId,
    defaultConnectionB,
    seedAgent,
    version,
    materialise,
    auditBy,
    auditRows,
    snapshot,
    violationsOf,
  } = fixture;

  it('names each kind by id in its own workspace only (namesOf, #616)', async () => {
    const scopeA = await createDatabaseWorkspaceScopeResolver(fixture.isolated.db).forWorkspaceId(
      workspaceA,
    );
    if (scopeA === null) throw new Error('workspace A did not resolve');
    const profile = await createDatabaseRuntimeProfileRepositoryProvider(fixture.isolated.db)
      .forScope(scopeA)
      .create({
        name: 'names-of',
        driver: 'local',
        runtimeConnectionId: null,
        cpu: null,
        memoryMb: null,
        diskMb: null,
        networkPolicy: 'open',
        allowedDomains: null,
        filesystem: 'read-write',
        persistPaths: null,
        timeoutSeconds: null,
        idleTimeoutSeconds: null,
        driverConfig: null,
      });
    if (profile.kind !== 'created') throw new Error(`expected created, got ${profile.kind}`);
    const [claude] = await fixture.isolated.db
      .select({ id: modelConnections.id })
      .from(modelConnections)
      .where(
        and(eq(modelConnections.workspaceId, workspaceA), eq(modelConnections.name, 'Claude')),
      );
    if (claude === undefined) throw new Error('the Claude connection fixture is missing');

    const names = await fixture.repoA.namesOf({
      skill: [skillId],
      connector: [connectorId],
      file: [fileId],
      // Workspace B's connection and a non-UUID are not workspace A's: both are absent.
      'model-connection': [claude.id, defaultConnectionB, 'not-a-uuid'],
      'runtime-profile': [profile.profile.id],
    });
    expect([...names.skill]).toEqual([[skillId, 'reviewer']]);
    expect([...names.connector]).toEqual([[connectorId, 'github']]);
    expect([...names.file]).toEqual([[fileId, 'handbook']]);
    expect([...names['model-connection']]).toEqual([[claude.id, 'Claude']]);
    expect([...names['runtime-profile']]).toEqual([[profile.profile.id, 'names-of']]);

    const fromB = await fixture.repoB.namesOf({ skill: [skillId], file: [fileId] });
    expect(fromB.skill.size + fromB.file.size).toBe(0);
  });

  it('points production without rewriting the agent row or its assignments (#612)', async () => {
    const agentId = await seedAgent('promoted');
    await version(agentId);
    await version(agentId);
    await expect(
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({
          name: 'promoted',
          instructions: 'Version two.',
          references: { ...NO_REFERENCES, skillIds: [skillId] },
        }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    const before = await snapshot(agentId);

    const outcome = await fixture.repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy({ subjectLabel: 'promoted: production -> version 1' }),
      environment: 'production',
      number: 1,
      agent: materialise({ name: 'renamed-by-v1', instructions: 'Version one.' }),
    });

    expect(outcome).toMatchObject({
      kind: 'applied',
      agent: { id: agentId, name: 'promoted', instructions: 'Version two.' },
      pointer: { agentId, environment: 'production', number: 1 },
    });
    const after = await snapshot(agentId);
    expect(after.agent).toEqual(before.agent);
    expect(after.skillRows).toEqual(before.skillRows);
    expect(after.pointerRows.map((row) => row.environment).sort()).toEqual(['local', 'production']);
    const listed = await fixture.repoA.list(agentId);
    expect(listed?.pointers.map((row) => [row.environment, row.number])).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    // The row is still `local`'s working copy, written from version 2.
    expect(listed?.materialisedVersionId).toBe(listed?.versions[1]?.id);
    expect((await auditRows(agentId)).map((row) => row.subjectLabel)).toEqual([
      'an agent: local -> version 1',
      'promoted: production -> version 1',
    ]);
  });

  it('C9 holds per environment: production refuses a name another production pointer serves', async () => {
    const first = await seedAgent('production-first');
    const second = await seedAgent('production-second');
    await version(first, bodyWith('storefront'));
    await version(second, bodyWith('storefront'));
    const point = (agentId: string, environment: 'local' | 'production', name: string) =>
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment,
        number: 1,
        agent: materialise({ name }),
      });
    await expect(point(first, 'production', 'production-first')).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(point(second, 'local', 'production-second')).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(point(second, 'production', 'production-second')).resolves.toEqual({
      kind: 'surface-name-taken',
      name: 'storefront',
    });
  });

  it('accepts a production pointer and refuses preview (agent_version_pointers_environment_valid)', async () => {
    const agentId = await seedAgent('environments');
    const v1 = await version(agentId);
    await fixture.isolated.db
      .insert(agentVersionPointers)
      .values({ workspaceId: workspaceA, agentId, environment: 'production', versionId: v1.id });
    const violations = await violationsOf(
      fixture.isolated.db.execute(
        sql`insert into agent_version_pointers (workspace_id, agent_id, environment, version_id)
            values (${workspaceA}, ${agentId}, 'preview', ${v1.id})`,
      ),
    );
    expect(violations).toEqual([
      { code: '23514', constraint: 'agent_version_pointers_environment_valid' },
    ]);
  });
}
