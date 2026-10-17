import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseBrowserTokenRepositoryProvider } from './browser-tokens.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('BrowserTokenRepository', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_browser_tokens');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Tokens' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Token agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await isolated.db.insert(runs).values({ id: runId, workspaceId, sessionId });
  }, 180_000);

  afterAll(async () => isolated.close());

  const scoped = async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseBrowserTokenRepositoryProvider(isolated.db).forScope(scope);
  };

  it('issues a run-scoped token and finds it active by hash', async () => {
    const tokens = await scoped();
    const id = crypto.randomUUID();
    await tokens.issue({
      id,
      mintedByPrincipalId: principalId,
      scope: { kind: 'run', id: runId },
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const active = await tokens.findActiveByHash('a'.repeat(64));
    expect(active?.id).toBe(id);
    expect(active?.scopeKind).toBe('run');
    expect(active?.runId).toBe(runId);
    expect(active?.sessionId).toBeNull();
    await expect(tokens.findActiveByHash('c'.repeat(64))).resolves.toBeNull();
  });

  it('the XOR check refuses a row naming both a run and a session, or neither', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    // Bypass the repository's own construction (which only ever sets one) to prove the database
    // constraint itself refuses, not merely the TypeScript layer above it.
    const { browserTokens } = await import('../schema/browser-tokens.js');
    await expect(
      isolated.db.insert(browserTokens).values({
        id: crypto.randomUUID(),
        workspaceId,
        mintedByPrincipalId: principalId,
        scopeKind: 'run',
        runId,
        sessionId,
        tokenHash: 'd'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  it('refuses a hash already used by another row (global uniqueness)', async () => {
    const tokens = await scoped();
    const hash = 'e'.repeat(64);
    await tokens.issue({
      id: crypto.randomUUID(),
      mintedByPrincipalId: principalId,
      scope: { kind: 'session', id: sessionId },
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      tokens.issue({
        id: crypto.randomUUID(),
        mintedByPrincipalId: principalId,
        scope: { kind: 'session', id: sessionId },
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  it('refuses a cross-tenant scope: a run or minter from another workspace', async () => {
    const otherScope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      otherWorkspaceId,
    );
    if (otherScope === null) throw new Error('workspace did not resolve');
    const otherTokens = createDatabaseBrowserTokenRepositoryProvider(isolated.db).forScope(
      otherScope,
    );
    await expect(
      otherTokens.issue({
        id: crypto.randomUUID(),
        mintedByPrincipalId: principalId,
        scope: { kind: 'run', id: runId },
        tokenHash: 'f'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  it('revokeForRun and revokeForSession revoke only their own scope kind', async () => {
    const tokens = await scoped();
    // A fresh run, so this run's revocation count is not conflated with the row `issue`d against
    // `runId` by an earlier test in this suite.
    const freshRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: freshRunId, workspaceId, sessionId });
    await tokens.issue({
      id: crypto.randomUUID(),
      mintedByPrincipalId: principalId,
      scope: { kind: 'run', id: freshRunId },
      tokenHash: 'g'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await tokens.issue({
      id: crypto.randomUUID(),
      mintedByPrincipalId: principalId,
      scope: { kind: 'session', id: sessionId },
      tokenHash: 'h'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(tokens.revokeForRun(freshRunId)).resolves.toBe(1);
    await expect(tokens.findActiveByHash('g'.repeat(64))).resolves.toBeNull();
    await expect(tokens.findActiveByHash('h'.repeat(64))).resolves.not.toBeNull();
    // Not asserted at exactly 1: an earlier test in this suite also issued a still-active
    // session-scoped token against this same `sessionId` fixture, so this revokes it too.
    await expect(tokens.revokeForSession(sessionId)).resolves.not.toBe(0);
    await expect(tokens.findActiveByHash('h'.repeat(64))).resolves.toBeNull();
  });

  it('an expired token is not active', async () => {
    const tokens = await scoped();
    await tokens.issue({
      id: crypto.randomUUID(),
      mintedByPrincipalId: principalId,
      scope: { kind: 'run', id: runId },
      tokenHash: 'i'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      tokens.findActiveByHash('i'.repeat(64), new Date(Date.now() + 120_000)),
    ).resolves.toBeNull();
  });
});
