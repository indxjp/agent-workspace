/**
 * ADR-0135 on PostgreSQL: the A2A route resolved by the real production composition (`register()`),
 * so the credential check and `findPublishedAgent` are the real ones, not the fake environment of
 * `server/a2a/dispatch.test.ts`.
 */
import crypto from 'node:crypto';

import {
  A2aAgentCardSchema,
  A2aJsonRpcResponseSchema,
  A2A_ERROR_CODES,
} from '@indx-workspace/contracts/a2a';
import { AgentVersionResourceSchema } from '@indx-workspace/contracts/agent-versions';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as agentCard } from '../../app/api/a2a/agents/[agentName]/.well-known/agent-card.json/route';
import { POST as a2aMessage } from '../../app/api/a2a/agents/[agentName]/route';
import { POST as createAgent } from '../../app/api/agents/route';
import { PUT as setPointer } from '../../app/api/agents/[id]/pointers/route';
import { POST as saveVersion } from '../../app/api/agents/[id]/versions/route';
import {
  apiKeys,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { versionRequest } from '../agent-versions/fixtures';
import { mintApiKey } from '../rbac/api-key';
import { serveA2aRpc } from '../a2a/dispatch';
import { resetA2aLimits } from '../a2a/limits';

import { register, type RegisteredComposition } from './register';
import { clearApplicationContext } from '../application-context';
import { resetTestRunApi } from '../application-context-fixtures';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/a2a-published-agent.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, ' +
      'so the A2A route was not exercised against the real credential and published-agent lookups.',
  );
}

const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_PUBLIC_URL',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'WORKSPACE_SLUG',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

describe.skipIf(!hasDatabase)('the A2A route through the production composition', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let composition: RegisteredComposition | undefined;
  const previousEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    resetA2aLimits();
    clearApplicationContext();
    resetTestRunApi();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
    isolated = undefined;
    composition = undefined;
  });

  async function seedWorkspace(
    db: IsolatedTestDatabase['db'],
    slug: string,
  ): Promise<{ readonly keyId: string; readonly key: string }> {
    const workspaceId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const minted = await mintApiKey();
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    await db.insert(apiKeys).values({
      id: keyId,
      workspaceId,
      name: `${slug} key`,
      role: 'owner',
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
    });
    return { keyId, key: minted.presented };
  }

  async function createNamedAgent(key: string, name: string): Promise<string> {
    const response = await createAgent(
      new Request('https://example.invalid/api/agents', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          instructions: 'Answer.',
          modelConnectionId: null,
          model: 'claude-sonnet-4-5',
          permissions: PERMISSIONS,
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function publish(key: string, agentId: string, name: string): Promise<void> {
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const context = { params: Promise.resolve({ id: agentId }) };
    const saved = await saveVersion(
      new Request(`https://example.invalid/api/agents/${agentId}/versions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(versionRequest({ name })),
      }),
      context,
    );
    expect(saved.status, await saved.clone().text()).toBe(201);
    const { number } = AgentVersionResourceSchema.parse(await saved.json());
    const pointed = await setPointer(
      new Request(`https://example.invalid/api/agents/${agentId}/pointers`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ environment: 'production', version: number }),
      }),
      context,
    );
    expect(pointed.status, await pointed.clone().text()).toBe(200);
  }

  const call = (key: string, agentName: string, taskId = crypto.randomUUID()) =>
    serveA2aRpc(
      new Request(`https://example.invalid/api/a2a/agents/${agentName}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: taskId },
        }),
      }),
      agentName,
    );

  it('refuses a revoked key, hides other tenants and unpublished agents, serves a published one, and serves its card without a credential', async () => {
    for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
    isolated = await createIsolatedTestDatabase('aw_composition_a2a_published_agent');
    const tenantA = await seedWorkspace(isolated.db, 'a2a-tenant-a');
    const tenantB = await seedWorkspace(isolated.db, 'a2a-tenant-b');
    const revoked = await seedWorkspace(isolated.db, 'a2a-revoked');

    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'composition-a2a-test-secret-at-least-32-characters';
    delete process.env['NEXT_RUNTIME'];
    for (const key of CONTROLLED_ENV) {
      if (key !== 'DATABASE_URL' && key !== 'SESSION_SECRET') delete process.env[key];
    }
    // The run API installs only with a runtime configured; no call here reaches it.
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    // The deployment's workspace, which the credential-less agent card is served for.
    process.env['BOOTSTRAP_ADMIN'] = 'admin@example.com';
    process.env['BOOTSTRAP_ADMIN_PASSWORD'] = 'a-bootstrap-password-of-length';
    process.env['WORKSPACE_SLUG'] = 'a2a-tenant-a';
    process.env['AW_PUBLIC_URL'] = 'https://aw.example.com';
    composition = await register();

    await publish(
      tenantA.key,
      await createNamedAgent(tenantA.key, 'published-bot'),
      'published-bot',
    );
    await createNamedAgent(tenantA.key, 'draft-bot');
    await publish(tenantB.key, await createNamedAgent(tenantB.key, 'tenant-b-bot'), 'tenant-b-bot');
    const revokedAgent = await createNamedAgent(revoked.key, 'revoked-bot');
    await publish(revoked.key, revokedAgent, 'revoked-bot');

    // Revoking after publishing proves the 401 is the credential's, not a missing agent's.
    await isolated.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, revoked.keyId));
    const revokedCall = await call(revoked.key, 'revoked-bot');
    expect(revokedCall.status).toBe(401);
    expect(revokedCall.headers.get('WWW-Authenticate')).toMatch(/^Bearer realm="agent-workspace"/u);

    const served = await call(tenantA.key, 'published-bot');
    expect(served.status).toBe(200);
    const answer = A2aJsonRpcResponseSchema.parse(await served.json());
    expect('error' in answer && answer.error.code).toBe(A2A_ERROR_CODES.task_not_found);

    const noPointer = await call(tenantA.key, 'draft-bot');
    const unknown = await call(tenantA.key, 'no-such-bot');
    const foreign = await call(tenantB.key, 'published-bot');
    for (const response of [noPointer, unknown, foreign]) expect(response.status).toBe(404);
    const bodies = [await noPointer.text(), await unknown.text(), await foreign.text()];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('a2a_agent_not_found');

    // The agent card is public discovery metadata of the deployment's workspace (issue #1076).
    const publicCard = (name: string) =>
      agentCard(
        new NextRequest(
          `https://aw.example.com/api/a2a/agents/${name}/.well-known/agent-card.json`,
        ),
        { params: Promise.resolve({ agentName: name }) },
      );
    const card = await publicCard('published-bot');
    expect(card.status).toBe(200);
    const cardText = await card.text();
    expect(A2aAgentCardSchema.parse(JSON.parse(cardText))).toMatchObject({
      name: 'published-bot',
      url: 'https://aw.example.com/api/a2a/agents/published-bot',
    });
    for (const secret of [tenantA.key, tenantA.keyId, 'ak_live', 'Bearer ']) {
      expect(cardText).not.toContain(secret);
    }
    const missed = [
      await publicCard('draft-bot'),
      await publicCard('no-such-bot'),
      await publicCard('tenant-b-bot'),
    ];
    for (const response of missed) expect(response.status).toBe(404);
    expect(new Set(await Promise.all(missed.map((response) => response.text()))).size).toBe(1);

    const messageName = 'published-bot';
    const unauthenticated = await a2aMessage(
      new NextRequest(`https://aw.example.com/api/a2a/agents/${messageName}`, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }),
      }),
      { params: Promise.resolve({ agentName: messageName }) },
    );
    expect(unauthenticated.status).toBe(401);
  }, 180_000);

  it('serves the card of the WORKSPACE_SLUG workspace with no bootstrap credential set (issue #1168)', async () => {
    for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
    isolated = await createIsolatedTestDatabase('aw_composition_a2a_oidc_only_card');
    const tenantA = await seedWorkspace(isolated.db, 'a2a-tenant-a');
    const tenantB = await seedWorkspace(isolated.db, 'a2a-tenant-b');

    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'composition-a2a-test-secret-at-least-32-characters';
    delete process.env['NEXT_RUNTIME'];
    for (const key of CONTROLLED_ENV) {
      if (key !== 'DATABASE_URL' && key !== 'SESSION_SECRET') delete process.env[key];
    }
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    // An OIDC-only deployment: the workspace slug is set, BOOTSTRAP_ADMIN* are not.
    process.env['WORKSPACE_SLUG'] = 'a2a-tenant-a';
    process.env['AW_PUBLIC_URL'] = 'https://aw.example.com';
    composition = await register();

    await publish(
      tenantA.key,
      await createNamedAgent(tenantA.key, 'published-bot'),
      'published-bot',
    );
    await publish(tenantB.key, await createNamedAgent(tenantB.key, 'tenant-b-bot'), 'tenant-b-bot');

    const publicCard = (name: string) =>
      agentCard(
        new NextRequest(
          `https://aw.example.com/api/a2a/agents/${name}/.well-known/agent-card.json`,
        ),
        { params: Promise.resolve({ agentName: name }) },
      );
    const card = await publicCard('published-bot');
    expect(card.status).toBe(200);
    expect(A2aAgentCardSchema.parse(await card.json())).toMatchObject({
      name: 'published-bot',
      url: 'https://aw.example.com/api/a2a/agents/published-bot',
    });
    expect((await publicCard('tenant-b-bot')).status).toBe(404);
  }, 180_000);
});
