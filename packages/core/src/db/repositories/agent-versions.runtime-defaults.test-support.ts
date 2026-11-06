import { eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  NO_REFERENCES,
  bodyWith,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
import { createDatabaseAgentVersionRepositoryProvider } from './agent-versions.js';
import { createDatabaseRuntimeProfileRepositoryProvider } from './runtime-profiles.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
export function registerRuntimeDefaultsCases(
  fixture: ReturnType<typeof createAgentVersionFixture>,
) {
  it('#504: a null runtime profile name resolves to the workspace default at apply time, else none', async () => {
    // A workspace of its own, so the default set here cannot leak into the other cases above.
    const workspaceC = crypto.randomUUID();
    const userC = crypto.randomUUID();
    const membershipC = crypto.randomUUID();
    const principalC = crypto.randomUUID();
    await fixture.isolated.db
      .insert(workspaces)
      .values({ id: workspaceC, slug: 'versions-c', name: 'Versions C' });
    await fixture.isolated.db
      .insert(users)
      .values({ id: userC, email: `${userC}@example.test`, name: 'Owner C' });
    await fixture.isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipC, workspaceId: workspaceC, userId: userC, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalC,
        workspaceId: workspaceC,
        kind: 'membership',
        membershipId: membershipC,
      });
    });
    const scopeC = await createDatabaseWorkspaceScopeResolver(fixture.isolated.db).forWorkspaceId(
      workspaceC,
    );
    if (scopeC === null) throw new Error('workspace C did not resolve');
    const repoC = createDatabaseAgentVersionRepositoryProvider(fixture.isolated.db).forScope(
      scopeC,
    );
    const profilesC = createDatabaseRuntimeProfileRepositoryProvider(fixture.isolated.db).forScope(
      scopeC,
    );
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    } as const;

    // No default chosen: none, exactly as before #504 — and never reported missing.
    await expect(repoC.resolveDefinition(references)).resolves.toEqual({
      kind: 'resolved',
      references: NO_REFERENCES,
    });

    const heavy = await profilesC.create({
      name: 'heavy',
      driver: 'docker',
      runtimeConnectionId: null,
      cpu: 4,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'restricted',
      allowedDomains: null,
      filesystem: 'read-write',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
    if (heavy.kind !== 'created') throw new Error(`expected created, got ${heavy.kind}`);
    const ensured = await profilesC.ensureWorkspaceDefault(
      {
        name: 'local',
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
      },
      { adoptable: () => true },
    );
    if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
    const localId = ensured.profile.id;

    const resolved = await repoC.resolveDefinition(references);
    expect(resolved).toEqual({
      kind: 'resolved',
      references: { ...NO_REFERENCES, runtimeProfileId: localId },
    });
    if (resolved.kind !== 'resolved') return;
    // A named profile wins over the default, and an unknown name is still missing.
    await expect(
      repoC.resolveDefinition({ ...references, runtimeProfileName: 'heavy' }),
    ).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: heavy.profile.id },
    });
    await expect(
      repoC.resolveDefinition({ ...references, runtimeProfileName: 'nowhere' }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'runtime-profile', name: 'nowhere' }],
      ambiguous: [],
    });
    // Workspace A has no default, whatever workspace C chose.
    await expect(fixture.repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: null },
    });

    // Both materialising paths store the concrete profile id.
    const created = await repoC.createAgentWithFirstVersion({
      agent: {
        ...fixture.materialise({ name: 'defaulted', references: resolved.references }),
        ownerPrincipalId: principalC,
        createdBy: userC,
      },
      version: {
        summary: 'first',
        via: 'aw-push',
        body: bodyWith(),
        createdByPrincipalId: principalC,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
    expect(created.agent.runtimeProfileId).toBe(localId);

    const second = await repoC.create(created.agent.id, {
      summary: 'second',
      via: 'aw-push',
      body: bodyWith(),
      createdByPrincipalId: principalC,
    });
    if (second.kind !== 'created') throw new Error(`expected created, got ${second.kind}`);
    await fixture.isolated.db
      .update(agents)
      .set({ runtimeProfileId: null })
      .where(eq(agents.id, created.agent.id));
    const applied = await repoC.applyAndPoint(created.agent.id, {
      reason: 'set',
      environment: 'local',
      number: 2,
      agent: fixture.materialise({ name: 'defaulted', references: resolved.references }),
      audit: fixture.auditBy({
        actorPrincipalId: principalC,
        actorUserId: userC,
        actorLabel: 'Owner C',
      }),
    });
    expect(applied).toMatchObject({
      kind: 'applied',
      agent: { id: created.agent.id, runtimeProfileId: localId },
    });

    // The default deleted between resolve and apply is the existing `reference-gone` race.
    const stale = await profilesC.create({
      name: 'stale',
      driver: 'docker',
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'none',
      allowedDomains: null,
      filesystem: 'read-only',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
    if (stale.kind !== 'created') throw new Error(`expected created, got ${stale.kind}`);
    await profilesC.delete(stale.profile.id);
    const staleApply = {
      reason: 'set',
      environment: 'local',
      number: 1,
      agent: fixture.materialise({
        name: 'defaulted',
        references: { ...NO_REFERENCES, runtimeProfileId: stale.profile.id },
      }),
      audit: fixture.auditBy({ actorPrincipalId: principalC, actorUserId: userC }),
    } as const;
    // #832: a row that has a profile keeps it, so the resolved default is not written at all.
    await expect(repoC.applyAndPoint(created.agent.id, staleApply)).resolves.toMatchObject({
      kind: 'applied',
      agent: { runtimeProfileId: localId },
    });
    // Only a row with none takes the default, and so meets the race.
    await fixture.isolated.db
      .update(agents)
      .set({ runtimeProfileId: null })
      .where(eq(agents.id, created.agent.id));
    await expect(repoC.applyAndPoint(created.agent.id, staleApply)).resolves.toEqual({
      kind: 'reference-gone',
      referenceKind: 'runtime-profile',
    });
  });

  it('#504 review: ensuring a default attaches it to agents applied while the workspace had none, and #786: a replaceable default hands them over', async () => {
    const workspaceD = crypto.randomUUID();
    const userD = crypto.randomUUID();
    const membershipD = crypto.randomUUID();
    const principalD = crypto.randomUUID();
    await fixture.isolated.db
      .insert(workspaces)
      .values({ id: workspaceD, slug: 'versions-d', name: 'Versions D' });
    await fixture.isolated.db
      .insert(users)
      .values({ id: userD, email: `${userD}@example.test`, name: 'Owner D' });
    await fixture.isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipD, workspaceId: workspaceD, userId: userD, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalD,
        workspaceId: workspaceD,
        kind: 'membership',
        membershipId: membershipD,
      });
    });
    const scopeD = await createDatabaseWorkspaceScopeResolver(fixture.isolated.db).forWorkspaceId(
      workspaceD,
    );
    if (scopeD === null) throw new Error('workspace D did not resolve');
    const repoD = createDatabaseAgentVersionRepositoryProvider(fixture.isolated.db).forScope(
      scopeD,
    );
    const profilesD = createDatabaseRuntimeProfileRepositoryProvider(fixture.isolated.db).forScope(
      scopeD,
    );
    const localInput = {
      name: 'local',
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
    } as const;
    const bodyNaming = (name: string, runtimeProfileName: string | null): unknown => ({
      definition: { agent: { name, runtimeProfileName } },
      surfaces: [],
    });
    /** Push `name` as `aw push` does while the workspace has no default: the row gets no profile. */
    async function pushed(name: string, runtimeProfileName: string | null): Promise<string> {
      const created = await repoD.createAgentWithFirstVersion({
        agent: {
          ...fixture.materialise({ name, references: NO_REFERENCES }),
          ownerPrincipalId: principalD,
          createdBy: userD,
        },
        version: {
          summary: 'first',
          via: 'aw-push',
          body: bodyNaming(name, runtimeProfileName),
          createdByPrincipalId: principalD,
        },
        environment: 'local',
      });
      if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
      return created.agent.id;
    }
    async function row(agentId: string) {
      const rows = await fixture.isolated.db
        .select({ runtimeProfileId: agents.runtimeProfileId, updatedAt: agents.updatedAt })
        .from(agents)
        .where(eq(agents.id, agentId));
      const found = rows[0];
      if (found === undefined) throw new Error('agent row missing');
      return found;
    }

    const unprofiled = await pushed('unprofiled', null);
    // Its version names a profile; its row is NULL because that profile is gone. Not ours to fill.
    const named = await pushed('named', 'heavy');
    // Edited by hand after its pointer moved: the row is no longer what the version materialised.
    const edited = await pushed('edited', null);
    await fixture.isolated.db
      .update(agents)
      .set({ instructions: 'Edited in the UI.', materialisedVersionId: null })
      .where(eq(agents.id, edited));
    const before = await row(unprofiled);
    expect(before.runtimeProfileId).toBeNull();

    const ensured = await profilesD.ensureWorkspaceDefault(localInput, { adoptable: () => true });
    if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
    // Attached without moving `updated_at`, so `aw push` still reads it as unedited.
    await expect(row(unprofiled)).resolves.toEqual({
      runtimeProfileId: ensured.profile.id,
      updatedAt: before.updatedAt,
    });
    await expect(row(named)).resolves.toMatchObject({ runtimeProfileId: null });
    await expect(row(edited)).resolves.toMatchObject({ runtimeProfileId: null });

    // The default deleted (the foreign key sets the row to NULL) and ensured again on restart.
    await expect(profilesD.delete(ensured.profile.id)).resolves.toEqual({ kind: 'deleted' });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: null });
    const again = await profilesD.ensureWorkspaceDefault(localInput, { adoptable: () => true });
    if (again.kind !== 'created') throw new Error(`expected created, got ${again.kind}`);
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });

    // `kept` attaches too: an agent whose row lost the default is filled on the next ensure.
    await fixture.isolated.db.execute(
      sql`update agents set runtime_profile_id = null where id = ${unprofiled}`,
    );
    await expect(
      profilesD.ensureWorkspaceDefault(localInput, { adoptable: () => true }),
    ).resolves.toMatchObject({ kind: 'kept' });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });

    // #786: a caller that owns the default may replace it. The new default takes the mark and the
    // agents that carried the old one as the default; an agent set to it by hand stays.
    const pinned = await pushed('pinned', null);
    await fixture.isolated.db
      .update(agents)
      .set({ runtimeProfileId: again.profile.id, materialisedVersionId: null })
      .where(eq(agents.id, pinned));
    const dockerInput = { ...localInput, name: 'docker', driver: 'docker', diskMb: 1_024 } as const;
    const ownLocal = { adoptable: () => true, replaceable: () => true };
    await expect(
      profilesD.ensureWorkspaceDefault(dockerInput, { adoptable: () => true }),
    ).resolves.toMatchObject({ kind: 'kept', profile: { id: again.profile.id } });
    const docker = await profilesD.ensureWorkspaceDefault(dockerInput, ownLocal);
    if (docker.kind !== 'created') throw new Error(`expected created, got ${docker.kind}`);
    await expect(profilesD.findWorkspaceDefault()).resolves.toMatchObject({
      id: docker.profile.id,
    });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: docker.profile.id });
    await expect(row(pinned)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });
    await expect(row(named)).resolves.toMatchObject({ runtimeProfileId: null });

    // And back: the existing `local` profile is adopted, nothing new is created.
    const back = await profilesD.ensureWorkspaceDefault(localInput, ownLocal);
    expect(back).toMatchObject({ kind: 'adopted', profile: { id: again.profile.id } });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });
    await expect(profilesD.list()).resolves.toHaveLength(2);
  });
}
