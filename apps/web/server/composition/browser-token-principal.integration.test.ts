/**
 * The browser-token verifier (issue #236, SDK-04, S-1), against real PostgreSQL.
 *
 * This drives `installRbacApi`'s `resolveActor`/`identify` directly — the same seam
 * `apps/web/server/composition/api-key-principal.integration.test.ts` exercises for an API key —
 * rather than the whole `register()` composition: what step 6 of the plan adds is entirely inside
 * that seam (the hash lookup, the scope repository, the terminal-state refusal, the minter re-read),
 * and a run/session row is all a fixture needs to reach every branch of it.
 *
 * Every mutation below goes through a repository method (`root.runs`, `root.sessions`,
 * `root.browserTokens`, `root.directory`) rather than a raw query: `apps/web` does not depend on
 * `drizzle-orm` directly, and the hash-and-expiry edge itself is already covered, without any real
 * clock or network latency to account for, by `packages/core/src/db/repositories/browser-tokens.
 * test.ts`'s `findActiveByHash(hash, now)` — which takes `now` as a parameter for exactly this
 * reason. (A first attempt at *this* file computed a token's `expiresAt` with a ~1 second TTL
 * before the insert; `created_at` defaults to `now()` on the server, and that margin was not
 * always enough to keep `expires_at > created_at`, so the insert itself failed the CHECK. The TTL
 * below is five minutes for the same margin the core-layer test avoids needing at all.)
 */
import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agents,
  browserTokens,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runs,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';

import { mintApiKey } from '../rbac/api-key';
import { mintBrowserToken } from '../rbac/browser-token';
import { installRbacApi, type InstalledRbacApi } from './session-rbac';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/browser-token-principal.integration.test.ts] SKIPPED — TEST_DATABASE_URL is ' +
      'not set, so the browser-token verifier was not exercised against PostgreSQL.',
  );
}

const SESSION_SECRET = 'browser-token-principal-test-secret-at-least-32-characters';
/** Comfortably above any insert latency — see this file's header. */
const LIVE_TTL_MS = 5 * 60_000;

describe.skipIf(!hasDatabase)('the browser-token verifier, against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let root: DatabaseRoot | undefined;

  afterEach(async () => {
    await root?.close();
    if (isolated !== undefined) await closeIsolatedTestResources(isolated);
    isolated = undefined;
    root = undefined;
  });

  async function fixture(): Promise<{
    readonly db: IsolatedTestDatabase;
    readonly root: DatabaseRoot;
    readonly installed: InstalledRbacApi;
    readonly workspaceId: string;
    readonly membershipId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly runId: string;
  }> {
    const db = await createIsolatedTestDatabase('aw_browser_token_principal');
    isolated = db;
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await db.db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'T' });
    await db.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Minter' });
    const principalId = await db.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'admin' });
      const inserted = await tx
        .insert(workspacePrincipals)
        .values({ workspaceId, kind: 'membership', membershipId })
        .returning({ id: workspacePrincipals.id });
      const row = inserted[0];
      if (row === undefined)
        throw new Error('fixture: membership principal insert returned no row');
      return row.id;
    });
    await db.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Fixture agent',
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
    await db.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await db.db.insert(runs).values({ id: runId, workspaceId, sessionId });

    const opened = await openDatabaseRoot({ DATABASE_URL: db.url });
    root = opened;
    const installed = await installRbacApi(opened, SESSION_SECRET);
    return {
      db,
      root: opened,
      installed,
      workspaceId,
      membershipId,
      principalId,
      sessionId,
      runId,
    };
  }

  async function issueToken(
    db: IsolatedTestDatabase,
    scope: { readonly kind: 'run' | 'session'; readonly id: string },
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<string> {
    const minted = await mintBrowserToken();
    await db.db.insert(browserTokens).values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      mintedByPrincipalId: input.principalId,
      scopeKind: scope.kind,
      runId: scope.kind === 'run' ? scope.id : null,
      sessionId: scope.kind === 'session' ? scope.id : null,
      tokenHash: minted.tokenHash,
      expiresAt: new Date(Date.now() + LIVE_TTL_MS),
    });
    return minted.presented;
  }

  function bearerRequest(token: string): Request {
    return new Request('https://example.invalid/api/runs/x', {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('resolves a run-scoped token to the minter’s identity, attenuated by the scope', async () => {
    const { db, workspaceId, principalId, runId, installed } = await fixture();
    const presented = await issueToken(
      db,
      { kind: 'run', id: runId },
      { workspaceId, principalId },
    );

    const principal = await installed.identify(bearerRequest(presented));
    expect(principal).not.toBeNull();
    expect(principal?.via).toBe('browser-token');
    expect(principal?.kind).toBe('membership');
    expect(principal?.role).toBe('admin');
    expect(principal?.principalId).toBe(principalId);
    expect(principal?.workspaceId).toBe(workspaceId);
    expect(principal?.scope).toEqual({ kind: 'run', id: runId });
  }, 180_000);

  it('resolves a session-scoped token the same way', async () => {
    const { db, workspaceId, principalId, sessionId, installed } = await fixture();
    const presented = await issueToken(
      db,
      { kind: 'session', id: sessionId },
      { workspaceId, principalId },
    );

    const principal = await installed.identify(bearerRequest(presented));
    expect(principal?.scope).toEqual({ kind: 'session', id: sessionId });
  }, 180_000);

  it('refuses an unknown token and a revoked one indistinguishably', async () => {
    const { db, root: opened, workspaceId, principalId, runId, installed } = await fixture();

    const unknown = await mintBrowserToken();
    await expect(installed.identify(bearerRequest(unknown.presented))).resolves.toBeNull();

    const revokedPresented = await issueToken(
      db,
      { kind: 'run', id: runId },
      { workspaceId, principalId },
    );
    await expect(installed.identify(bearerRequest(revokedPresented))).resolves.not.toBeNull();
    const scope = await opened.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    await opened.browserTokens.forScope(scope).revokeForRun(runId);
    await expect(installed.identify(bearerRequest(revokedPresented))).resolves.toBeNull();
  }, 180_000);

  it('refuses a token once its scoped run is terminal', async () => {
    const { db, root: opened, workspaceId, principalId, runId, installed } = await fixture();
    const presented = await issueToken(
      db,
      { kind: 'run', id: runId },
      { workspaceId, principalId },
    );
    await expect(installed.identify(bearerRequest(presented))).resolves.not.toBeNull();

    const scope = await opened.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    await opened.runs.forScope(scope).finish(runId, 'cancelled', null);

    await expect(installed.identify(bearerRequest(presented))).resolves.toBeNull();
  }, 180_000);

  it('refuses a token while its scoped run is paused at awaiting_approval (ADR-0145 D1)', async () => {
    const { db, root: opened, workspaceId, principalId, runId, installed } = await fixture();
    const presented = await issueToken(
      db,
      { kind: 'run', id: runId },
      { workspaceId, principalId },
    );
    await expect(installed.identify(bearerRequest(presented))).resolves.not.toBeNull();

    const scope = await opened.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    const runs = opened.runs.forScope(scope);
    expect((await runs.markRunning(runId)).kind).toBe('moved');
    const paused = await runs.awaitApproval(runId, { toolName: 'send_email', canonicalCall: '{}' });
    expect(paused.kind).toBe('moved');

    await expect(installed.identify(bearerRequest(presented))).resolves.toBeNull();
  }, 180_000);

  it('refuses a token once its scoped session is archived', async () => {
    const { db, root: opened, workspaceId, principalId, sessionId, installed } = await fixture();
    const presented = await issueToken(
      db,
      { kind: 'session', id: sessionId },
      { workspaceId, principalId },
    );
    await expect(installed.identify(bearerRequest(presented))).resolves.not.toBeNull();

    const scope = await opened.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    await opened.sessions.forScope(scope).archive(sessionId);

    await expect(installed.identify(bearerRequest(presented))).resolves.toBeNull();
  }, 180_000);

  it('re-reads a role change on the minter on the very next request', async () => {
    const {
      db,
      workspaceId,
      membershipId,
      principalId,
      runId,
      installed,
      root: opened,
    } = await fixture();
    const presented = await issueToken(
      db,
      { kind: 'run', id: runId },
      { workspaceId, principalId },
    );
    await expect(installed.identify(bearerRequest(presented))).resolves.not.toBeNull();

    // Takes effect on the next request — the same rule `principal.ts`'s header states for a
    // session, extended here to a browser token's minter.
    await opened.directory.forWorkspace(workspaceId).changeMembershipRole(membershipId, 'viewer');
    const demoted = await installed.identify(bearerRequest(presented));
    expect(demoted?.role).toBe('viewer');
  }, 180_000);

  it('refuses a token once its minting API key is revoked', async () => {
    const { db, root: opened, workspaceId, runId, installed } = await fixture();
    const directory = opened.directory.forWorkspace(workspaceId);
    const minted = await mintApiKey();
    const created = await directory.createApiKey({
      name: 'Minting key',
      role: 'builder',
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error('fixture: API key creation failed');
    const presented = await issueToken(
      db,
      { kind: 'run', id: runId },
      { workspaceId, principalId: created.key.principalId },
    );
    const principal = await installed.identify(bearerRequest(presented));
    expect(principal?.kind).toBe('api_key');
    expect(principal?.role).toBe('builder');

    await directory.revokeApiKey(created.key.id, new Date());
    await expect(installed.identify(bearerRequest(presented))).resolves.toBeNull();
  }, 180_000);
});
