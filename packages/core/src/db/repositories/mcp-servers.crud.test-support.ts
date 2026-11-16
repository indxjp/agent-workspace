import crypto from 'node:crypto';

import { expect, it } from 'vitest';

import {
  created,
  httpConnector,
  stdioConnector,
  type McpServerFixture,
} from './mcp-servers.fixture.test-support.js';

function registerCreateCases(fixture: McpServerFixture): void {
  const { principalA, userA } = fixture;

  it('creates a stdio connector with no credential and lists it back', async () => {
    const repo = fixture.repo(fixture.scopeA);
    const args = ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'];

    const outcome = await repo.create(
      stdioConnector({
        name: 'Filesystem',
        command: 'npx',
        args,
        ownerPrincipalId: principalA,
        createdBy: userA,
      }),
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.server).toMatchObject({
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      workspaceId: fixture.workspaceA.id,
    });

    const listed = await repo.list();
    expect(listed.map((s) => s.id)).toContain(outcome.server.id);
  });

  it('creates an http connector referencing a real secret row, by id — never by value', async () => {
    const repo = fixture.repo(fixture.scopeA);

    const outcome = await repo.create(
      httpConnector({
        name: 'GitHub',
        url: 'https://api.example.test/mcp',
        authType: 'bearer',
        credentialSecretId: fixture.secretInA,
        ownerPrincipalId: principalA,
        createdBy: userA,
      }),
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.server.credentialSecretId).toBe(fixture.secretInA);
    // The point of the whole exercise: nothing on the record type or the row this reads back
    // could ever hold the plaintext "gh-real-token" — it is a reference, structurally.
    expect(JSON.stringify(outcome.server)).not.toContain('gh-real-token');

    const fetched = await repo.get(outcome.server.id);
    expect(fetched?.credentialSecretId).toBe(fixture.secretInA);
  });
}

function registerNameCases(fixture: McpServerFixture): void {
  const { principalA, principalB, userA, userB } = fixture;

  it('refuses a duplicate name in the same workspace', async () => {
    const repo = fixture.repo(fixture.scopeA);
    const duplicate = stdioConnector({
      name: 'Duplicate',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await repo.create(duplicate);
    const second = await repo.create(duplicate);
    expect(second).toEqual({ kind: 'name-conflict', name: 'Duplicate' });
  });

  it('allows the same name in a different workspace (tenant isolation)', async () => {
    const repoA = fixture.repo(fixture.scopeA);
    const repoB = fixture.repo(fixture.scopeB);
    await repoA.create(
      stdioConnector({ name: 'SameName', ownerPrincipalId: principalA, createdBy: userA }),
    );
    const inB = await repoB.create(
      stdioConnector({ name: 'SameName', ownerPrincipalId: principalB, createdBy: userB }),
    );
    expect(inB.kind).toBe('created');
  });
}

function registerCredentialCases(fixture: McpServerFixture): void {
  const { principalA, userA } = fixture;
  const bearer = (name: string, credentialSecretId: string) =>
    httpConnector({
      name,
      url: 'https://example.test/mcp',
      authType: 'bearer',
      credentialSecretId,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });

  it('refuses a credential secret id that does not exist', async () => {
    const repo = fixture.repo(fixture.scopeA);
    const bogus = crypto.randomUUID();
    const outcome = await repo.create(bearer('BadSecretRef', bogus));
    expect(outcome).toEqual({ kind: 'unknown-credential-secret', secretId: bogus });
  });

  it("refuses another workspace's secret as a credential reference (spec §25)", async () => {
    const repo = fixture.repo(fixture.scopeA);
    const outcome = await repo.create(bearer('CrossTenantSecretRef', fixture.secretInB));
    expect(outcome).toEqual({ kind: 'unknown-credential-secret', secretId: fixture.secretInB });
  });
}

function registerDeleteAndIsolationCases(fixture: McpServerFixture): void {
  const { principalA, userA } = fixture;

  it('deletes a connector, and a second delete answers not-found', async () => {
    const repo = fixture.repo(fixture.scopeA);
    const { server } = created(
      await repo.create(
        stdioConnector({ name: 'ToDelete', ownerPrincipalId: principalA, createdBy: userA }),
      ),
    );
    await expect(repo.delete(server.id)).resolves.toEqual({ kind: 'deleted' });
    await expect(repo.delete(server.id)).resolves.toEqual({ kind: 'not-found' });
  });

  it("does not see another workspace's connector by id", async () => {
    const repoA = fixture.repo(fixture.scopeA);
    const repoB = fixture.repo(fixture.scopeB);
    const { server } = created(
      await repoA.create(
        stdioConnector({ name: 'OnlyA', ownerPrincipalId: principalA, createdBy: userA }),
      ),
    );
    await expect(repoB.get(server.id)).resolves.toBeNull();
  });
}

function registerUpdateCases(fixture: McpServerFixture): void {
  const { principalA, userA } = fixture;

  it('updates fields in place without moving the owner, and conceals another workspace (#240)', async () => {
    const repo = fixture.repo(fixture.scopeA);
    const repoB = fixture.repo(fixture.scopeB);
    const { server } = created(
      await repo.create(
        httpConnector({
          name: 'Update me',
          url: 'https://mcp.example.test/before',
          ownerPrincipalId: principalA,
          createdBy: userA,
        }),
      ),
    );

    await expect(repoB.update(server.id, { enabled: false })).resolves.toEqual({
      kind: 'not-found',
    });
    const updated = await repo.update(server.id, {
      name: 'Updated',
      enabled: false,
      url: 'https://mcp.example.test/after',
    });
    expect(updated).toMatchObject({
      kind: 'updated',
      server: {
        name: 'Updated',
        enabled: false,
        url: 'https://mcp.example.test/after',
        ownerPrincipalId: principalA,
        createdBy: userA,
      },
    });
    await expect(repo.update(server.id, { name: 'Filesystem' })).resolves.toEqual({
      kind: 'name-conflict',
      name: 'Filesystem',
    });
  });
}

/** Create, name uniqueness, credential references, delete, tenant isolation and update. */
export function registerCrudCases(fixture: McpServerFixture): void {
  registerCreateCases(fixture);
  registerNameCases(fixture);
  registerCredentialCases(fixture);
  registerDeleteAndIsolationCases(fixture);
  registerUpdateCases(fixture);
}
