/**
 * `resolveActor`'s `awo_live_` branch (ADR-0134 part 3), against real PostgreSQL: the same seam
 * `browser-token-principal.integration.test.ts` drives. What this proves is the part the in-memory
 * OAuth server tests cannot: the hash lookup, the revoked-client and revoked-family refusals, the
 * re-read of the consenting member, and that the token is admitted on the agent-endpoint routes
 * and nowhere else.
 */
import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';

import { serveExternalBuilderMcp } from '../builder/transport/external';
import { mintOAuthToken } from '../oauth/tokens';
import { installRbacApi, type InstalledRbacApi } from './session-rbac';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/oauth-principal.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, ' +
      'so the OAuth access-token verifier was not exercised against PostgreSQL.',
  );
}

const SESSION_SECRET = 'oauth-principal-test-secret-at-least-32-characters';
const RESOURCE = 'https://aw.example/api/a2a/agents/helper';
const A2A_PATH = 'https://aw.example/api/a2a/agents/helper';
const BUILDER_RESOURCE = 'https://aw.example/mcp/builder';

describe.skipIf(!hasDatabase)('the OAuth access-token verifier, against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let root: DatabaseRoot | undefined;

  afterEach(async () => {
    await root?.close();
    if (isolated !== undefined) await closeIsolatedTestResources(isolated);
    isolated = undefined;
    root = undefined;
  });

  async function fixture(kind: 'a2a-agent' | 'mcp-project' | 'builder' = 'a2a-agent') {
    const db = await createIsolatedTestDatabase('aw_oauth_principal');
    isolated = db;
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await db.db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'T' });
    await db.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Consenter' });
    const principalId = await db.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId, role: 'builder' });
      const inserted = await tx
        .insert(workspacePrincipals)
        .values({ workspaceId, kind: 'membership', membershipId })
        .returning({ id: workspacePrincipals.id });
      const row = inserted[0];
      if (row === undefined) throw new Error('fixture: principal insert returned no row');
      return row.id;
    });
    await db.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'helper',
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
    const opened = await openDatabaseRoot({ DATABASE_URL: db.url });
    root = opened;
    const installed = await installRbacApi(opened, SESSION_SECRET);
    const scope = await opened.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    const created = await opened.endpointClients.forScope(scope).create({
      name: 'bot',
      kind,
      agentIds: kind === 'builder' ? [] : [agentId],
      actsForPrincipalId: principalId,
      createdByPrincipalId: principalId,
    });
    if (created.kind !== 'created') throw new Error('fixture: client creation failed');
    const tokens = opened.oauthTokens.forScope(scope);
    const issue = async (over: { expiresAt?: Date; familyId?: string } = {}): Promise<string> => {
      const minted = await mintOAuthToken('access');
      await tokens.issue({
        id: crypto.randomUUID(),
        clientId: created.client.id,
        kind: 'access',
        tokenHash: minted.tokenHash,
        subjectPrincipalId: principalId,
        resource: kind === 'builder' ? BUILDER_RESOURCE : RESOURCE,
        familyId: over.familyId ?? crypto.randomUUID(),
        expiresAt: over.expiresAt ?? new Date(Date.now() + 5 * 60_000),
      });
      return minted.presented;
    };
    return {
      opened,
      installed,
      scope,
      workspaceId,
      membershipId,
      principalId,
      agentId,
      client: created.client,
      tokens,
      issue,
    };
  }

  const request = (token: string, url = A2A_PATH, method = 'POST'): Request =>
    new Request(url, { method, headers: { authorization: `Bearer ${token}` } });

  async function identify(
    installed: InstalledRbacApi,
    token: string,
    url?: string,
    method?: string,
  ) {
    return installed.identify(request(token, url, method));
  }

  it('resolves an a2a-agent token to the consenting member, scoped to the agent, with its audience', async () => {
    const f = await fixture();
    const principal = await identify(f.installed, await f.issue());
    expect(principal).not.toBeNull();
    expect(principal).toMatchObject({
      via: 'oauth-token',
      kind: 'membership',
      role: 'builder',
      principalId: f.principalId,
      workspaceId: f.workspaceId,
      scope: { kind: 'a2a-agent', id: f.agentId },
      oauth: { clientId: f.client.id, audience: RESOURCE },
    });
  }, 180_000);

  it('resolves an mcp-project token to the client itself', async () => {
    const f = await fixture('mcp-project');
    const principal = await identify(
      f.installed,
      await f.issue(),
      'https://aw.example/mcp/projects/bot',
    );
    expect(principal?.scope).toEqual({ kind: 'mcp-project', id: f.client.id });
  }, 180_000);

  it('is admitted on the agent-endpoint routes only', async () => {
    const f = await fixture();
    const token = await f.issue();
    for (const [url, method] of [
      [`https://aw.example/api/agents/${f.agentId}/runs`, 'POST'],
      ['https://aw.example/api/endpoint-clients', 'GET'],
      ['https://aw.example/api/tokens', 'POST'],
      ['https://aw.example/api/a2a/agents/helper/extra', 'POST'],
    ] as const) {
      await expect(identify(f.installed, token, url, method)).resolves.toBeNull();
    }
    await expect(
      identify(f.installed, token, `${A2A_PATH}/.well-known/agent-card.json`, 'GET'),
    ).resolves.not.toBeNull();
  }, 180_000);

  it('refuses an unknown token, a malformed one, and one of another kind', async () => {
    const f = await fixture();
    await expect(
      identify(f.installed, (await mintOAuthToken('access')).presented),
    ).resolves.toBeNull();
    await expect(identify(f.installed, 'awo_live_short')).resolves.toBeNull();
    // A refresh token's secret is a valid hash in the table, but the prefix is not an access token's.
    const refresh = await mintOAuthToken('refresh');
    await f.tokens.issue({
      id: crypto.randomUUID(),
      clientId: f.client.id,
      kind: 'refresh',
      tokenHash: refresh.tokenHash,
      subjectPrincipalId: f.principalId,
      resource: RESOURCE,
      familyId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(identify(f.installed, refresh.presented)).resolves.toBeNull();
    await expect(
      identify(f.installed, refresh.presented.replace('awr_live_', 'awo_live_')),
    ).resolves.toBeNull();
  }, 180_000);

  it('refuses an expired token', async () => {
    const f = await fixture();
    const token = await f.issue({ expiresAt: new Date(Date.now() + 1_000) });
    await expect(identify(f.installed, token)).resolves.not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(identify(f.installed, token)).resolves.toBeNull();
  }, 180_000);

  it('refuses a token once its family is revoked', async () => {
    const f = await fixture();
    const family = crypto.randomUUID();
    const token = await f.issue({ familyId: family });
    await expect(identify(f.installed, token)).resolves.not.toBeNull();
    await f.tokens.revokeFamily(family);
    await expect(identify(f.installed, token)).resolves.toBeNull();
  }, 180_000);

  it('refuses every token of a client once the client is revoked', async () => {
    const f = await fixture();
    const token = await f.issue();
    await expect(identify(f.installed, token)).resolves.not.toBeNull();
    await f.opened.endpointClients.forScope(f.scope).revoke(f.client.id, new Date());
    await expect(identify(f.installed, token)).resolves.toBeNull();
  }, 180_000);

  it('resolves a builder token to scope builder on /mcp/builder, and refuses it once revoked', async () => {
    const f = await fixture('builder');
    const token = await f.issue();
    expect(await identify(f.installed, token, BUILDER_RESOURCE)).toMatchObject({
      role: 'builder',
      principalId: f.principalId,
      scope: { kind: 'builder', id: f.client.id },
      oauth: { clientId: f.client.id, audience: BUILDER_RESOURCE },
    });
    await expect(
      identify(f.installed, token, 'https://aw.example/api/agents', 'GET'),
    ).resolves.toBeNull();
    await f.opened.endpointClients.forScope(f.scope).revoke(f.client.id, new Date());
    await expect(identify(f.installed, token, BUILDER_RESOURCE)).resolves.toBeNull();
  }, 180_000);

  describe('at the /mcp/builder route boundary', () => {
    beforeEach(() => {
      vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const call = (installed: InstalledRbacApi, token: string, method: string, params?: unknown) =>
      serveExternalBuilderMcp(
        new Request(BUILDER_RESOURCE, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
        { identify: (r) => installed.identify(r), ports: null },
      );

    it('lists the three read tools and refuses draft_save to a real builder token', async () => {
      const f = await fixture('builder');
      const token = await f.issue();
      const listed = (await (await call(f.installed, token, 'tools/list')).json()) as {
        result: { tools: { name: string }[] };
      };
      expect(listed.result.tools.map((t) => t.name)).toEqual([
        'catalog_list',
        'examples_get',
        'draft_check',
      ]);
      const saved = await call(f.installed, token, 'tools/call', {
        name: 'draft_save',
        arguments: {},
      });
      expect(JSON.stringify(await saved.json())).toContain('read_only_client');
    }, 180_000);

    it('refuses an expired token and a revoked client', async () => {
      const f = await fixture('builder');
      const expiring = await f.issue({ expiresAt: new Date(Date.now() + 1_000) });
      const live = await f.issue();
      expect((await call(f.installed, expiring, 'tools/list')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect((await call(f.installed, expiring, 'tools/list')).status).toBe(401);
      expect((await call(f.installed, live, 'tools/list')).status).toBe(200);
      await f.opened.endpointClients.forScope(f.scope).revoke(f.client.id, new Date());
      expect((await call(f.installed, live, 'tools/list')).status).toBe(401);
    }, 180_000);

    it.each(['a2a-agent', 'mcp-project'] as const)(
      'refuses an %s token',
      async (kind) => {
        const f = await fixture(kind);
        const response = await call(f.installed, await f.issue(), 'tools/list');
        expect(response.status).toBe(401);
      },
      180_000,
    );
  });

  it('re-reads the consenting member on every request: a role change bites at once', async () => {
    const f = await fixture();
    const token = await f.issue();
    expect((await identify(f.installed, token))?.role).toBe('builder');
    await f.opened.directory
      .forWorkspace(f.workspaceId)
      .changeMembershipRole(f.membershipId, 'viewer');
    expect((await identify(f.installed, token))?.role).toBe('viewer');
  }, 180_000);
});
