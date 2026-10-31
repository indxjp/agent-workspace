import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  openDatabaseRoot,
  type DatabaseDirectoryRoot,
  type DatabaseRoot,
  type DirectoryApiKeyRecord,
  type DirectoryEndpointScope,
} from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  endpointClientApiKeys,
  endpointClients,
  memberships,
  projects,
  type IsolatedTestDatabase,
  users,
  workspacePrincipals,
  workspaces,
} from '@agent-workspace/core/db/unscoped';
import { conferredBy } from './conferral';
import { deleteMembership as deleteMembershipHandler } from './handlers';
import { createPostgresDirectory } from './postgres-directory';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('PostgreSQL RBAC directory', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  const workspace = { id: crypto.randomUUID(), slug: 'rbac-test', name: 'RBAC test' };
  // The profile name deliberately shares nothing with the email's local part, so a projection that
  // published the address instead of the name cannot accidentally satisfy an assertion here.
  const owner = {
    id: crypto.randomUUID(),
    email: 'owner@example.test',
    name: 'Durable Profile Name',
  };
  const ownerMembershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_rbac_directory');
    await isolated.db.insert(workspaces).values(workspace);
    await isolated.db.insert(users).values(owner);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: ownerMembershipId,
        workspaceId: workspace.id,
        userId: owner.id,
        role: 'owner',
      });
      await tx.insert(workspacePrincipals).values({
        id: ownerPrincipalId,
        workspaceId: workspace.id,
        kind: 'membership',
        membershipId: ownerMembershipId,
      });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await root.close();
    await isolated.close();
  });

  it('persists users, memberships and presentation-once API keys across a root restart', async () => {
    let directory = createPostgresDirectory(root.directory);
    const scoped = directory.forWorkspace(workspace.id);
    const createdUser = await scoped.createUser({
      email: 'Builder@Example.test',
      name: 'Builder',
      role: conferredBy('owner', 'builder', 'test'),
    });
    if (createdUser.kind !== 'created') throw new Error(createdUser.kind);
    // Issue #181: this `201` body is built by hand from the `users` row, not by
    // `membershipColumns()`, so the list path's join is no evidence for it.
    expect(createdUser.membership.name).toBe('Builder');
    expect(createdUser.membership.name).not.toBe(createdUser.membership.email);

    const createdKey = await scoped.createApiKey({
      name: 'CI',
      role: conferredBy('owner', 'builder', 'test'),
      expiresAt: null,
    });
    if (createdKey.kind !== 'created') throw new Error(createdKey.kind);
    const presented = createdKey.presented;
    const stored = await scoped.readStoredApiKey(createdKey.key.id);
    expect(stored?.keyHash).not.toContain(presented);
    expect(JSON.stringify(stored)).not.toContain(presented);

    await root.close();
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    directory = createPostgresDirectory(root.directory);
    expect(await directory.forWorkspace(workspace.id).listUsers()).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: 'builder@example.test' })]),
    );
    expect(await directory.authenticateApiKey(presented, new Date())).toMatchObject({
      workspaceId: workspace.id,
      role: 'builder',
    });

    await directory.forWorkspace(workspace.id).revokeApiKey(createdKey.key.id);
    await expect(directory.authenticateApiKey(presented, new Date())).resolves.toBeNull();
  });

  it('lists keys, and refuses to authenticate one, bound to a builder endpoint client (SEC-11)', async () => {
    const directory = createPostgresDirectory(root.directory);
    const scoped = directory.forWorkspace(workspace.id);
    const created = await scoped.createApiKey({
      name: 'bound-to-builder',
      role: conferredBy('owner', 'viewer', 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    // A builder client is reached by an OAuth token only, but nothing in the schema stops a row
    // binding a key to one; the directory must then fail closed, not fail the whole key list.
    const [client] = await isolated.db
      .insert(endpointClients)
      .values({
        workspaceId: workspace.id,
        name: 'builder-door',
        kind: 'builder',
        actsForPrincipalId: ownerPrincipalId,
        createdByPrincipalId: ownerPrincipalId,
      })
      .returning({ id: endpointClients.id });
    if (client === undefined) throw new Error('the builder client was not inserted');
    await isolated.db
      .insert(endpointClientApiKeys)
      .values({ apiKeyId: created.key.id, clientId: client.id, workspaceId: workspace.id });

    const listed = await scoped.listApiKeys();
    expect(listed.map((row) => row.name)).toContain('bound-to-builder');
    await expect(directory.authenticateApiKey(created.presented, new Date())).resolves.toBeNull();
  });

  it('refuses to remove the last owner', async () => {
    const directory = createPostgresDirectory(root.directory);
    const membershipRows = await directory.forWorkspace(workspace.id).listMemberships();
    const ownerMembership = membershipRows.find((entry) => entry.role === 'owner');
    expect(ownerMembership).toBeDefined();
    await expect(
      directory.forWorkspace(workspace.id).deleteMembership(ownerMembership?.id ?? ''),
    ).resolves.toMatchObject({ kind: 'last-owner' });
  });

  it('returns a typed conflict and preserves data when the member still owns a project', async () => {
    const directory = createPostgresDirectory(root.directory);
    const scoped = directory.forWorkspace(workspace.id);
    const created = await scoped.createUser({
      email: `project-owner-${crypto.randomUUID()}@example.test`,
      name: 'Project owner',
      role: conferredBy('owner', 'builder', 'test'),
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const projectId = crypto.randomUUID();
    await isolated.db.insert(projects).values({
      id: projectId,
      workspaceId: workspace.id,
      name: `Owned project ${projectId}`,
      createdBy: created.user.id,
      ownerPrincipalId: created.membership.principalId,
    });

    const response = await deleteMembershipHandler(scoped, 'owner', created.membership.id);

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: 'membership_in_use',
          message:
            'This member still owns projects in this workspace. Delete or reassign those projects before removing the membership.',
          detail:
            'This member still owns projects in this workspace. Delete or reassign those projects before removing the membership.',
        },
      },
    });
    expect(await scoped.listMemberships()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.membership.id })]),
    );
    expect(await isolated.db.select({ id: projects.id }).from(projects)).toContainEqual({
      id: projectId,
    });
  });

  // Issue #509 (S1-24): a local runtime key records the member it acts for, and that reference
  // keeps the member. Removing one answers a typed 409, never a raw constraint failure (a 500).
  it('returns a typed conflict when a revoked local runtime key acted for the member', async () => {
    const directory = createPostgresDirectory(root.directory);
    const scoped = directory.forWorkspace(workspace.id);
    const created = await scoped.createUser({
      email: `local-dev-${crypto.randomUUID()}@example.test`,
      name: 'Local developer',
      role: conferredBy('owner', 'builder', 'test'),
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const core = root.directory.forWorkspace(workspace.id);
    const local = await core.createApiKey({
      name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
      role: 'builder',
      keyPrefix: `ak_live_${crypto.randomUUID().slice(0, 8)}`,
      keyHash: crypto.randomUUID().replaceAll('-', ''),
      expiresAt: null,
      actsForPrincipalId: created.membership.principalId,
    });
    if (local.kind !== 'created') throw new Error(local.kind);
    expect((await core.revokeApiKey(local.key.id, new Date())).kind).toBe('revoked');

    const response = await deleteMembershipHandler(scoped, 'owner', created.membership.id);

    const message =
      'Local runtime keys created by `aw dev` acted for this member and still reference it. ' +
      'Removing a member that a local runtime key acted for is not supported.';
    expect(response).toEqual({
      status: 409,
      body: { error: { code: 'membership_in_use', message, detail: message } },
    });
    expect(await scoped.listMemberships()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.membership.id })]),
    );
  });

  // Issue #181: the Team UX (#122) reads member names from `GET /api/memberships` alone, so the
  // real workspace-scoped join — not only the in-memory substitute — has to carry `users.name`,
  // publish exactly the six public fields, and carry no other tenant's roster with it.
  it('projects joined user names through the workspace-scoped PostgreSQL adapter', async () => {
    const directory = createPostgresDirectory(root.directory);
    const foreignWorkspace = {
      id: crypto.randomUUID(),
      slug: `foreign-${crypto.randomUUID()}`,
      name: 'Foreign Workspace',
    };
    const foreignUser = {
      id: crypto.randomUUID(),
      email: `foreign-${crypto.randomUUID()}@example.test`,
      name: 'Foreign Tenant Member',
    };
    await isolated.db.insert(workspaces).values(foreignWorkspace);
    await isolated.db.insert(users).values(foreignUser);
    const foreignMembershipId = '338834dd-bfde-47d5-98b8-da173a42655a';
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: foreignMembershipId,
        workspaceId: foreignWorkspace.id,
        userId: foreignUser.id,
        role: 'owner',
      });
      await tx.insert(workspacePrincipals).values({
        id: '10df75cf-40a2-4702-928e-af80234ebf40',
        workspaceId: foreignWorkspace.id,
        kind: 'membership',
        membershipId: foreignMembershipId,
      });
    });

    const rows = await directory.forWorkspace(workspace.id).listMemberships();
    const ownerMembership = rows.find((row) => row.userId === owner.id);
    if (ownerMembership === undefined) throw new Error('the fixture owner has no membership');

    expect(ownerMembership.name).toBe(owner.name);
    expect(ownerMembership.name).not.toBe(owner.email);
    // The internal directory shape includes the principal required to build ActorContext. The HTTP
    // handler projects the established six-field public contract.
    expect(Object.keys(ownerMembership).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'principalId',
      'role',
      'userId',
    ]);

    // §25 applies to the new field as much as to the email: a name names a member too.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(foreignUser.email);
    expect(serialised).not.toContain(foreignUser.name);
  });

  // Issue #181: `createMembership` also builds its `201` body by hand, from a separately read
  // `users` row. Its name has to be the stored profile name of the user the email names.
  it('returns the stored name of a pre-existing user from the hand-built createMembership record', async () => {
    const directory = createPostgresDirectory(root.directory);
    // Again a profile name sharing nothing with the local part, so publishing the address cannot
    // satisfy the assertion by accident.
    const member = {
      id: crypto.randomUUID(),
      email: `stored-name-${crypto.randomUUID()}@example.test`,
      name: 'Stored Profile Name',
    };
    await isolated.db.insert(users).values(member);

    const created = await directory.forWorkspace(workspace.id).createMembership({
      email: member.email.toUpperCase(),
      role: conferredBy('owner', 'viewer', 'test'),
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    expect(created.membership.name).toBe(member.name);
    expect(created.membership.name).not.toBe(member.email);
  });

  // Issue #181: acceptance is the third hand-built membership record, and the only one whose user
  // row the caller never supplied a name for. It is asserted here rather than in
  // `postgres-invitations.test.ts` because the name on that body is this task's contract and this
  // file is the one this task owns; the acceptance mechanics stay covered where they already are.
  it('returns the stored profile name on the membership an invitation acceptance creates', async () => {
    const directory = createPostgresDirectory(root.directory);
    const invitee = {
      id: crypto.randomUUID(),
      email: `invited-${crypto.randomUUID()}@example.test`,
      name: 'Invited Profile Name',
    };
    await isolated.db.insert(users).values(invitee);

    const invited = await directory.forWorkspace(workspace.id).createInvitation({
      email: invitee.email,
      role: conferredBy('owner', 'viewer', 'test'),
      invitedBy: owner.id,
    });
    if (invited.kind !== 'created') throw new Error(invited.kind);

    const accepted = await directory.acceptInvitation(invited.invitation.id, invited.token, {
      email: invitee.email,
      issuer: 'https://idp.example',
      subject: `sub-invited-${invitee.id}`,
    });
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    expect(accepted.membership.name).toBe(invitee.name);
    expect(accepted.membership.name).not.toBe(invitee.email);
  });

  // Issue #118: OIDC identity binding and cross-workspace membership enumeration, over a real
  // `user_identities` table and a real join to `memberships`/`workspaces`. `directory.test.ts`
  // proves the same contract against the in-memory implementation; this is the half that proves
  // the SQL actually does it.
  it('binds an OIDC identity to a user and reads it back across a root restart', async () => {
    let directory = createPostgresDirectory(root.directory);
    expect(await directory.findIdentity('https://idp.example', 'sub-pg-1')).toBeNull();
    await directory.linkIdentity('https://idp.example', 'sub-pg-1', owner.id);
    // Idempotent: a replayed callback binds the same pair to the same user again and does not throw.
    await expect(
      directory.linkIdentity('https://idp.example', 'sub-pg-1', owner.id),
    ).resolves.toBeUndefined();

    await root.close();
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    directory = createPostgresDirectory(root.directory);
    expect(await directory.findIdentity('https://idp.example', 'sub-pg-1')).toEqual({
      userId: owner.id,
      email: owner.email,
    });
    expect(await directory.findUserByEmail(owner.email.toUpperCase())).toMatchObject({
      id: owner.id,
      email: owner.email,
    });
  });

  it('refuses to rebind an existing OIDC identity to a different durable user', async () => {
    const directory = createPostgresDirectory(root.directory);
    const other = {
      id: crypto.randomUUID(),
      email: `identity-conflict-${crypto.randomUUID()}@example.test`,
      name: 'Identity conflict',
    };
    await isolated.db.insert(users).values(other);

    await directory.linkIdentity('https://idp.example', 'sub-pg-conflict', owner.id);
    await expect(
      directory.linkIdentity('https://idp.example', 'sub-pg-conflict', other.id),
    ).rejects.toThrow('OIDC identity is already bound to a different user');
    expect(await directory.findIdentity('https://idp.example', 'sub-pg-conflict')).toEqual({
      userId: owner.id,
      email: owner.email,
    });
  });

  it('lists every CURRENT membership a user holds, across workspaces, via a real join', async () => {
    const directory = createPostgresDirectory(root.directory);
    const second = { id: crypto.randomUUID(), slug: 'second-ws', name: 'Second Workspace' };
    await isolated.db.insert(workspaces).values(second);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: '78d074ae-ed2a-4ef5-b314-c330ee85e0f1',
        workspaceId: second.id,
        userId: owner.id,
        role: 'admin',
      });
      await tx.insert(workspacePrincipals).values({
        id: '80cf5265-94aa-4973-a2a1-06da0ca0d5bf',
        workspaceId: second.id,
        kind: 'membership',
        membershipId: '78d074ae-ed2a-4ef5-b314-c330ee85e0f1',
      });
    });

    const rows = await directory.membershipsForUser(owner.id);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          principalId: ownerPrincipalId,
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          workspaceName: workspace.name,
          role: 'owner',
        },
        {
          principalId: '80cf5265-94aa-4973-a2a1-06da0ca0d5bf',
          workspaceId: second.id,
          workspaceSlug: second.slug,
          workspaceName: second.name,
          role: 'admin',
        },
      ]),
    );
  });
});

describe('PostgreSQL RBAC directory: revoking a key reports its mcp-project client', () => {
  const keyRow = (endpointScope: DirectoryEndpointScope | null): DirectoryApiKeyRecord => ({
    id: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    name: 'key',
    role: 'builder',
    keyPrefix: 'ak_live_abc',
    keyHash: 'hash',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: new Date(),
    createdAt: new Date(),
    actsForPrincipalId: null,
    endpointScope,
  });
  const revokeWith = async (endpointScope: DirectoryEndpointScope | null) => {
    const repository = {
      forWorkspace: () => ({
        revokeApiKey: () => Promise.resolve({ kind: 'revoked', key: keyRow(endpointScope) }),
      }),
    } as unknown as DatabaseDirectoryRoot;
    return createPostgresDirectory(repository).forWorkspace('w').revokeApiKey('k');
  };

  it('returns the client id of an mcp-project key and null for any other key', async () => {
    const clientId = crypto.randomUUID();
    expect(await revokeWith({ kind: 'mcp-project', clientId })).toMatchObject({
      kind: 'revoked',
      mcpProjectClientId: clientId,
    });
    expect(
      await revokeWith({ kind: 'a2a-agent', clientId, agentId: crypto.randomUUID() }),
    ).toMatchObject({ kind: 'revoked', mcpProjectClientId: null });
    expect(await revokeWith(null)).toMatchObject({ kind: 'revoked', mcpProjectClientId: null });
  });
});
