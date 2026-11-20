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
type Fixture = ReturnType<typeof createAgentVersionFixture>;
type ProfilesRepo = ReturnType<
  ReturnType<typeof createDatabaseRuntimeProfileRepositoryProvider>['forScope']
>;
type ProfileInput = Parameters<ProfilesRepo['create']>[0];

/** A workspace of its own with an owner, so a default set in it cannot leak into other cases. */
interface OwnedWorkspace {
  readonly userId: string;
  readonly principalId: string;
  readonly ownerName: string;
  readonly repo: ReturnType<
    ReturnType<typeof createDatabaseAgentVersionRepositoryProvider>['forScope']
  >;
  readonly profiles: ProfilesRepo;
}

async function createOwnedWorkspace(
  fixture: Fixture,
  suffix: string,
  label: string,
): Promise<OwnedWorkspace> {
  const { db } = fixture.isolated;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const ownerName = `Owner ${label}`;
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `versions-${suffix}`, name: `Versions ${label}` });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: ownerName });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx.insert(workspacePrincipals).values({
      id: principalId,
      workspaceId,
      kind: 'membership',
      membershipId,
    });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error(`workspace ${label} did not resolve`);
  return {
    userId,
    principalId,
    ownerName,
    repo: createDatabaseAgentVersionRepositoryProvider(db).forScope(scope),
    profiles: createDatabaseRuntimeProfileRepositoryProvider(db).forScope(scope),
  };
}

function profileInput(overrides: Partial<ProfileInput> & Pick<ProfileInput, 'name'>): ProfileInput {
  return {
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
    ...overrides,
  };
}

async function createProfile(profiles: ProfilesRepo, input: ProfileInput) {
  const created = await profiles.create(input);
  if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
  return created.profile;
}

async function clearRuntimeProfile(fixture: Fixture, agentId: string): Promise<void> {
  await fixture.isolated.db
    .update(agents)
    .set({ runtimeProfileId: null })
    .where(eq(agents.id, agentId));
}

const UNSET_REFERENCES = {
  modelConnectionName: null,
  runtimeProfileName: null,
  skills: [],
  connectors: [],
  files: [],
} as const;

/** Both materialising paths store the concrete profile id; returns the agent id. */
async function materialiseDefaulted(
  fixture: Fixture,
  ws: OwnedWorkspace,
  references: typeof NO_REFERENCES,
  localId: string,
): Promise<string> {
  const version = {
    summary: 'first',
    via: 'aw-push',
    body: bodyWith(),
    createdByPrincipalId: ws.principalId,
  } as const;
  const created = await ws.repo.createAgentWithFirstVersion({
    agent: {
      ...fixture.materialise({ name: 'defaulted', references }),
      ownerPrincipalId: ws.principalId,
      createdBy: ws.userId,
    },
    version,
    environment: 'local',
  });
  if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
  expect(created.agent.runtimeProfileId).toBe(localId);

  const second = await ws.repo.create(created.agent.id, { ...version, summary: 'second' });
  if (second.kind !== 'created') throw new Error(`expected created, got ${second.kind}`);
  await clearRuntimeProfile(fixture, created.agent.id);
  const applied = await ws.repo.applyAndPoint(created.agent.id, {
    reason: 'set',
    environment: 'local',
    number: 2,
    agent: fixture.materialise({ name: 'defaulted', references }),
    audit: fixture.auditBy({
      actorPrincipalId: ws.principalId,
      actorUserId: ws.userId,
      actorLabel: ws.ownerName,
    }),
  });
  expect(applied).toMatchObject({
    kind: 'applied',
    agent: { id: created.agent.id, runtimeProfileId: localId },
  });
  return created.agent.id;
}

/** The default deleted between resolve and apply is the existing `reference-gone` race. */
async function expectStaleDefaultRace(
  fixture: Fixture,
  ws: OwnedWorkspace,
  agentId: string,
  localId: string,
): Promise<void> {
  const stale = await createProfile(
    ws.profiles,
    profileInput({
      name: 'stale',
      driver: 'docker',
      networkPolicy: 'none',
      filesystem: 'read-only',
    }),
  );
  await ws.profiles.delete(stale.id);
  const staleApply = {
    reason: 'set',
    environment: 'local',
    number: 1,
    agent: fixture.materialise({
      name: 'defaulted',
      references: { ...NO_REFERENCES, runtimeProfileId: stale.id },
    }),
    audit: fixture.auditBy({ actorPrincipalId: ws.principalId, actorUserId: ws.userId }),
  } as const;
  // #832: a row that has a profile keeps it, so the resolved default is not written at all.
  await expect(ws.repo.applyAndPoint(agentId, staleApply)).resolves.toMatchObject({
    kind: 'applied',
    agent: { runtimeProfileId: localId },
  });
  // Only a row with none takes the default, and so meets the race.
  await clearRuntimeProfile(fixture, agentId);
  await expect(ws.repo.applyAndPoint(agentId, staleApply)).resolves.toEqual({
    kind: 'reference-gone',
    referenceKind: 'runtime-profile',
  });
}

async function expectNullNameResolvesToWorkspaceDefault(fixture: Fixture): Promise<void> {
  const ws = await createOwnedWorkspace(fixture, 'c', 'C');
  const references = UNSET_REFERENCES;

  // No default chosen: none, exactly as before #504 — and never reported missing.
  await expect(ws.repo.resolveDefinition(references)).resolves.toEqual({
    kind: 'resolved',
    references: NO_REFERENCES,
  });

  const heavy = await createProfile(
    ws.profiles,
    profileInput({
      name: 'heavy',
      driver: 'docker',
      cpu: 4,
      networkPolicy: 'restricted',
    }),
  );
  const ensured = await ws.profiles.ensureWorkspaceDefault(profileInput({ name: 'local' }), {
    adoptable: () => true,
  });
  if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
  const localId = ensured.profile.id;

  const resolved = await ws.repo.resolveDefinition(references);
  expect(resolved).toEqual({
    kind: 'resolved',
    references: { ...NO_REFERENCES, runtimeProfileId: localId },
  });
  if (resolved.kind !== 'resolved') return;
  // A named profile wins over the default, and an unknown name is still missing.
  await expect(
    ws.repo.resolveDefinition({ ...references, runtimeProfileName: 'heavy' }),
  ).resolves.toMatchObject({
    kind: 'resolved',
    references: { runtimeProfileId: heavy.id },
  });
  await expect(
    ws.repo.resolveDefinition({ ...references, runtimeProfileName: 'nowhere' }),
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

  const agentId = await materialiseDefaulted(fixture, ws, resolved.references, localId);
  await expectStaleDefaultRace(fixture, ws, agentId, localId);
}

const bodyNaming = (name: string, runtimeProfileName: string | null): unknown => ({
  definition: { agent: { name, runtimeProfileName } },
  surfaces: [],
});

/** Push `name` as `aw push` does while the workspace has no default: the row gets no profile. */
async function pushWithoutDefault(
  fixture: Fixture,
  ws: OwnedWorkspace,
  name: string,
  runtimeProfileName: string | null,
): Promise<string> {
  const created = await ws.repo.createAgentWithFirstVersion({
    agent: {
      ...fixture.materialise({ name, references: NO_REFERENCES }),
      ownerPrincipalId: ws.principalId,
      createdBy: ws.userId,
    },
    version: {
      summary: 'first',
      via: 'aw-push',
      body: bodyNaming(name, runtimeProfileName),
      createdByPrincipalId: ws.principalId,
    },
    environment: 'local',
  });
  if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
  return created.agent.id;
}

async function readAgentRow(fixture: Fixture, agentId: string) {
  const rows = await fixture.isolated.db
    .select({ runtimeProfileId: agents.runtimeProfileId, updatedAt: agents.updatedAt })
    .from(agents)
    .where(eq(agents.id, agentId));
  const found = rows[0];
  if (found === undefined) throw new Error('agent row missing');
  return found;
}

const ADOPTABLE = { adoptable: () => true };

async function expectEnsureAttachesToUnprofiledAgents(fixture: Fixture): Promise<void> {
  const ws = await createOwnedWorkspace(fixture, 'd', 'D');
  const localInput = profileInput({ name: 'local' });
  const row = (agentId: string) => readAgentRow(fixture, agentId);

  const unprofiled = await pushWithoutDefault(fixture, ws, 'unprofiled', null);
  // Its version names a profile; its row is NULL because that profile is gone. Not ours to fill.
  const named = await pushWithoutDefault(fixture, ws, 'named', 'heavy');
  // Edited by hand after its pointer moved: the row is no longer what the version materialised.
  const edited = await pushWithoutDefault(fixture, ws, 'edited', null);
  await fixture.isolated.db
    .update(agents)
    .set({ instructions: 'Edited in the UI.', materialisedVersionId: null })
    .where(eq(agents.id, edited));
  const before = await row(unprofiled);
  expect(before.runtimeProfileId).toBeNull();

  const ensured = await ws.profiles.ensureWorkspaceDefault(localInput, ADOPTABLE);
  if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
  // Attached without moving `updated_at`, so `aw push` still reads it as unedited.
  await expect(row(unprofiled)).resolves.toEqual({
    runtimeProfileId: ensured.profile.id,
    updatedAt: before.updatedAt,
  });
  await expect(row(named)).resolves.toMatchObject({ runtimeProfileId: null });
  await expect(row(edited)).resolves.toMatchObject({ runtimeProfileId: null });

  // The default deleted (the foreign key sets the row to NULL) and ensured again on restart.
  await expect(ws.profiles.delete(ensured.profile.id)).resolves.toEqual({ kind: 'deleted' });
  await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: null });
  const again = await ws.profiles.ensureWorkspaceDefault(localInput, ADOPTABLE);
  if (again.kind !== 'created') throw new Error(`expected created, got ${again.kind}`);
  await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });

  // `kept` attaches too: an agent whose row lost the default is filled on the next ensure.
  await fixture.isolated.db.execute(
    sql`update agents set runtime_profile_id = null where id = ${unprofiled}`,
  );
  await expect(ws.profiles.ensureWorkspaceDefault(localInput, ADOPTABLE)).resolves.toMatchObject({
    kind: 'kept',
  });
  await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });

  // #786: a caller that owns the default may replace it. The new default takes the mark and the
  // agents that carried the old one as the default; an agent set to it by hand stays.
  const pinned = await pushWithoutDefault(fixture, ws, 'pinned', null);
  await fixture.isolated.db
    .update(agents)
    .set({ runtimeProfileId: again.profile.id, materialisedVersionId: null })
    .where(eq(agents.id, pinned));
  const dockerInput = { ...localInput, name: 'docker', driver: 'docker', diskMb: 1_024 } as const;
  const ownLocal = { adoptable: () => true, replaceable: () => true };
  await expect(ws.profiles.ensureWorkspaceDefault(dockerInput, ADOPTABLE)).resolves.toMatchObject({
    kind: 'kept',
    profile: { id: again.profile.id },
  });
  const docker = await ws.profiles.ensureWorkspaceDefault(dockerInput, ownLocal);
  if (docker.kind !== 'created') throw new Error(`expected created, got ${docker.kind}`);
  await expect(ws.profiles.findWorkspaceDefault()).resolves.toMatchObject({
    id: docker.profile.id,
  });
  await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: docker.profile.id });
  await expect(row(pinned)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });
  await expect(row(named)).resolves.toMatchObject({ runtimeProfileId: null });

  // And back: the existing `local` profile is adopted, nothing new is created.
  const back = await ws.profiles.ensureWorkspaceDefault(localInput, ownLocal);
  expect(back).toMatchObject({ kind: 'adopted', profile: { id: again.profile.id } });
  await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });
  await expect(ws.profiles.list()).resolves.toHaveLength(2);
}

export function registerRuntimeDefaultsCases(fixture: Fixture) {
  it('#504: a null runtime profile name resolves to the workspace default at apply time, else none', () =>
    expectNullNameResolvesToWorkspaceDefault(fixture));

  it('#504 review: ensuring a default attaches it to agents applied while the workspace had none, and #786: a replaceable default hands them over', () =>
    expectEnsureAttachesToUnprofiledAgents(fixture));
}
