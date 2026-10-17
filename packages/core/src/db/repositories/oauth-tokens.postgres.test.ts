import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { endpointClients } from '../schema/endpoint-clients.js';
import { memberships } from '../schema/memberships.js';
import { oauthTokens } from '../schema/oauth-tokens.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseEndpointClientRepositoryProvider } from './endpoint-clients.js';
import {
  createDatabaseOAuthTokenRepositoryProvider,
  findActiveOAuthAccessToken,
  findOAuthClient,
} from './oauth-tokens.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('OAuthTokenRepository (ADR-0134 part 3)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const otherPrincipalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const permissions = {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  };
  const hash = () => crypto.randomBytes(32).toString('hex');
  const later = () => new Date(Date.now() + 60_000);

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_oauth_tokens');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'OAuth' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    for (const [workspace, principal] of [
      [workspaceId, principalId],
      [otherWorkspaceId, otherPrincipalId],
    ] as const) {
      const membershipId = crypto.randomUUID();
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId: workspace, userId, role: 'owner' });
        await tx.insert(workspacePrincipals).values({
          id: principal,
          workspaceId: workspace,
          kind: 'membership',
          membershipId,
        });
      });
    }
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'OAuth agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions,
    });
  }, 180_000);

  afterAll(async () => isolated.close());

  async function tokensFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseOAuthTokenRepositoryProvider(isolated.db).forScope(scope);
  }

  async function newClient(kind: 'mcp-project' | 'a2a-agent' = 'mcp-project') {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const created = await createDatabaseEndpointClientRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({
        name: `client-${crypto.randomUUID().slice(0, 8)}`,
        kind,
        agentIds: [agentId],
        actsForPrincipalId: principalId,
        createdByPrincipalId: principalId,
      });
    if (created.kind !== 'created') throw new Error('expected created');
    return created.client;
  }

  const access = (clientId: string, tokenHash = hash(), familyId = crypto.randomUUID()) => ({
    id: crypto.randomUUID(),
    clientId,
    kind: 'access' as const,
    tokenHash,
    subjectPrincipalId: principalId,
    resource: 'https://aw.example.com/mcp/projects/p',
    familyId,
    expiresAt: later(),
  });
  const code = (clientId: string, tokenHash = hash(), familyId = crypto.randomUUID()) => ({
    ...access(clientId, tokenHash, familyId),
    kind: 'code' as const,
    codeChallenge: 'c'.repeat(43),
    redirectUri: 'https://platform.example.com/cb',
  });

  it('refuses a client or subject of another workspace (tenant-paired foreign keys)', async () => {
    const client = await newClient();
    const other = await tokensFor(otherWorkspaceId);
    await expect(other.issue(access(client.id))).rejects.toThrow();
    const own = await tokensFor(workspaceId);
    await expect(
      own.issue({ ...access(client.id), subjectPrincipalId: otherPrincipalId }),
    ).rejects.toThrow();
  });

  it('requires a challenge and redirect for a code, and forbids them on other kinds', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    await expect(tokens.issue({ ...code(client.id), codeChallenge: undefined })).rejects.toThrow();
    await expect(
      tokens.issue({
        ...access(client.id),
        redirectUri: 'https://x.example/cb',
        codeChallenge: 'c'.repeat(43),
      }),
    ).rejects.toThrow();
    await tokens.issue(code(client.id));
  });

  it('refuses a duplicate hash (global uniqueness)', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    const shared = hash();
    await tokens.issue(access(client.id, shared));
    await expect(tokens.issue(access(client.id, shared))).rejects.toThrow();
  });

  it('lets exactly one of two concurrent consumers spend a code', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    const tokenHash = hash();
    await tokens.issue(code(client.id, tokenHash));
    const outcomes = await Promise.all([
      tokens.consume('code', tokenHash, client.id),
      tokens.consume('code', tokenHash, client.id),
    ]);
    expect(outcomes.filter((o) => o.kind === 'consumed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'reused')).toHaveLength(1);
  });

  it('reports a second presentation as reused, an unknown or expired one as invalid, and binds the client', async () => {
    const client = await newClient();
    const other = await newClient();
    const tokens = await tokensFor(workspaceId);
    const tokenHash = hash();
    const row = code(client.id, tokenHash);
    await tokens.issue(row);
    expect((await tokens.consume('code', tokenHash, other.id)).kind).toBe('invalid');
    const first = await tokens.consume('code', tokenHash, client.id);
    expect(first.kind).toBe('consumed');
    expect(await tokens.consume('code', tokenHash, client.id)).toEqual({
      kind: 'reused',
      familyId: row.familyId,
      subjectPrincipalId: row.subjectPrincipalId,
    });
    expect(await tokens.consume('code', hash(), client.id)).toEqual({ kind: 'invalid' });
    const expired = hash();
    await tokens.issue(code(client.id, expired));
    expect(
      (await tokens.consume('code', expired, client.id, new Date(Date.now() + 120_000))).kind,
    ).toBe('invalid');
  });

  it('does not let another workspace spend or revoke a token', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    const other = await tokensFor(otherWorkspaceId);
    const tokenHash = hash();
    const row = code(client.id, tokenHash);
    await tokens.issue(row);
    expect(await other.consume('code', tokenHash, client.id)).toEqual({ kind: 'invalid' });
    expect(await other.revokeFamily(row.familyId)).toBe(0);
  });

  it('revokes a whole family and nothing else', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    const family = crypto.randomUUID();
    const mine = hash();
    const theirs = hash();
    await tokens.issue(access(client.id, mine, family));
    await tokens.issue({ ...access(client.id, hash(), family), kind: 'refresh' });
    await tokens.issue(access(client.id, theirs));
    expect(await tokens.revokeFamily(family)).toBe(2);
    expect(await findActiveOAuthAccessToken(isolated.db, mine)).toBeNull();
    expect((await findActiveOAuthAccessToken(isolated.db, theirs))?.clientId).toBe(client.id);
  });

  it('revoke: an access token alone, a refresh token with its family, an unknown or already-revoked token not at all', async () => {
    const client = await newClient();
    const other = await newClient();
    const tokens = await tokensFor(workspaceId);
    const family = crypto.randomUUID();
    const accessHash = hash();
    const siblingHash = hash();
    const refreshHash = hash();
    await tokens.issue(access(client.id, accessHash, family));
    await tokens.issue(access(client.id, siblingHash, family));
    await tokens.issue({ ...access(client.id, refreshHash, family), kind: 'refresh' });
    expect(await tokens.revoke(accessHash, other.id)).toBeNull();
    expect(await tokens.revoke(accessHash, client.id)).toMatchObject({
      kind: 'access',
      subjectPrincipalId: principalId,
    });
    expect(await tokens.revoke(accessHash, client.id)).toBeNull();
    expect(await findActiveOAuthAccessToken(isolated.db, accessHash)).toBeNull();
    expect((await findActiveOAuthAccessToken(isolated.db, siblingHash))?.clientId).toBe(client.id);
    expect(await tokens.revoke(refreshHash, client.id)).toMatchObject({ kind: 'refresh' });
    expect(await findActiveOAuthAccessToken(isolated.db, siblingHash)).toBeNull();
    expect(await tokens.revoke(refreshHash, client.id)).toBeNull();
    expect(await tokens.revoke(siblingHash, client.id)).toBeNull();
    expect(await tokens.revoke(hash(), client.id)).toBeNull();
  });

  it('revoke: of two concurrent revocations exactly one reports the token', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    const family = crypto.randomUUID();
    const accessHash = hash();
    const refreshHash = hash();
    const siblingHash = hash();
    await tokens.issue(access(client.id, accessHash));
    await tokens.issue({ ...access(client.id, refreshHash, family), kind: 'refresh' });
    await tokens.issue(access(client.id, siblingHash, family));
    for (const tokenHash of [accessHash, refreshHash]) {
      const outcomes = await Promise.all([
        tokens.revoke(tokenHash, client.id),
        tokens.revoke(tokenHash, client.id),
      ]);
      expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
    }
    expect(await findActiveOAuthAccessToken(isolated.db, siblingHash)).toBeNull();
    expect(await tokens.revokeFamily(family)).toBe(0);
  });

  it('resolves an access token to its client, the agent of an a2a client, and fails closed', async () => {
    const mcp = await newClient('mcp-project');
    const a2a = await newClient('a2a-agent');
    const tokens = await tokensFor(workspaceId);
    const mcpHash = hash();
    const a2aHash = hash();
    const expiredHash = hash();
    await tokens.issue(access(mcp.id, mcpHash));
    await tokens.issue(access(a2a.id, a2aHash));
    await tokens.issue(access(mcp.id, expiredHash));
    expect(await findActiveOAuthAccessToken(isolated.db, mcpHash)).toMatchObject({
      workspaceId,
      clientId: mcp.id,
      clientKind: 'mcp-project',
      agentId: null,
      subjectPrincipalId: principalId,
    });
    expect(await findActiveOAuthAccessToken(isolated.db, a2aHash)).toMatchObject({
      clientKind: 'a2a-agent',
      agentId,
    });
    expect(
      await findActiveOAuthAccessToken(isolated.db, expiredHash, new Date(Date.now() + 120_000)),
    ).toBeNull();
    // A refresh token is not an access token, whatever its hash.
    const refreshHash = hash();
    await tokens.issue({ ...access(mcp.id, refreshHash), kind: 'refresh' });
    expect(await findActiveOAuthAccessToken(isolated.db, refreshHash)).toBeNull();
    await isolated.db.delete(endpointClientAgents).where(eq(endpointClientAgents.clientId, a2a.id));
    expect(await findActiveOAuthAccessToken(isolated.db, a2aHash)).toBeNull();
  });

  it('stops a revoked client at lookup time, for tokens and for authentication', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    const tokenHash = hash();
    await tokens.issue(access(client.id, tokenHash));
    expect(await findOAuthClient(isolated.db, client.id)).toMatchObject({
      id: client.id,
      workspaceId,
      clientSecretHash: null,
      redirectUris: [],
    });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    await createDatabaseEndpointClientRepositoryProvider(isolated.db)
      .forScope(scope)
      .revoke(client.id, new Date());
    expect(await findActiveOAuthAccessToken(isolated.db, tokenHash)).toBeNull();
    expect(await findOAuthClient(isolated.db, client.id)).toBeNull();
  });

  it('cascades token rows when the client is deleted', async () => {
    const client = await newClient();
    const tokens = await tokensFor(workspaceId);
    await tokens.issue(access(client.id));
    await isolated.db.delete(endpointClients).where(eq(endpointClients.id, client.id));
    const rows = await isolated.db
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(eq(oauthTokens.clientId, client.id));
    expect(rows).toEqual([]);
  });

  it('stores a secret hash and redirect URIs on a client without ever returning the hash', async () => {
    const client = await newClient();
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const clients = createDatabaseEndpointClientRepositoryProvider(isolated.db).forScope(scope);
    expect(client.hasClientSecret).toBe(false);
    const secretHash = hash();
    const set = await clients.setSecretHash(client.id, secretHash, new Date());
    if (set.kind !== 'set') throw new Error('expected set');
    expect(set.client.hasClientSecret).toBe(true);
    expect(JSON.stringify(set.client)).not.toContain(secretHash);
    expect((await findOAuthClient(isolated.db, client.id))?.clientSecretHash).toBe(secretHash);
    const updated = await clients.update(client.id, {
      redirectUris: ['https://a.example/cb', 'https://a.example/cb'],
    });
    if (updated.kind !== 'updated') throw new Error('expected updated');
    expect(updated.client.redirectUris).toEqual(['https://a.example/cb']);
    await expect(
      clients.update(client.id, {
        redirectUris: Array.from({ length: 11 }, (_, i) => `https://a.example/${String(i)}`),
      }),
    ).rejects.toThrow();
    expect(await clients.setSecretHash(crypto.randomUUID(), hash(), new Date())).toEqual({
      kind: 'not-found',
    });
    await clients.revoke(client.id, new Date());
    expect(await clients.setSecretHash(client.id, hash(), new Date())).toEqual({
      kind: 'revoked',
    });
  });
});
