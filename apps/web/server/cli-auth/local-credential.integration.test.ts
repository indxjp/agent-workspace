/**
 * S1-21 (issue #500): a key from `issueLocalApiKey` reaches every control-plane route `aw dev`
 * calls, through the real `register()` composition, the real `app/api` route handlers and the real
 * edge decision in `apps/web/proxy.ts`, and `revoke()` withdraws it. The S1-19 exit test found the
 * CLI user token the runtime used to issue refused off ADR-0083 §4's routes; this file is the
 * regression test for that.
 *
 * S1-24 (issue #509): what the local key writes is owned by the admin's membership principal it
 * acts for, while the version and the audit trail keep the acting key; a hosted admin key still
 * owns what it writes; and the next run's repair moves a row an earlier key still owns (data from
 * before the fix) to the admin before its sweep.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_KEY_PATTERN } from '@indx-workspace/contracts/api-keys';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  agents,
  agentVersions,
  apiKeys,
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { DELETE as revokeApiKeyRoute } from '../../app/api/api-keys/[id]/route';
import { POST as postApiKey } from '../../app/api/api-keys/route';
import {
  DELETE as deleteMembershipRoute,
  PATCH as patchMembership,
} from '../../app/api/memberships/[id]/route';
import { POST as postMembership } from '../../app/api/memberships/route';
import { POST as postUser } from '../../app/api/users/route';
import { GET as getAgentPolicy } from '../../app/api/agents/[id]/policy/route';
import { PUT as putPointer } from '../../app/api/agents/[id]/pointers/route';
import { GET as getAgent } from '../../app/api/agents/[id]/route';
import { GET as listVersions, POST as postVersion } from '../../app/api/agents/[id]/versions/route';
import { GET as listAgents, POST as postAgent } from '../../app/api/agents/route';
import { GET as meRoute } from '../../app/api/me/route';
import {
  GET as listModelConnections,
  POST as postModelConnection,
} from '../../app/api/model-connections/route';
import { proxy } from '../../proxy';
import { fromVersionRequest, versionRequest } from '../agent-versions/fixtures';
import type { RegisteredComposition } from '../composition/register';
import { mintApiKey } from '../rbac/api-key';
import { createPostgresDirectory } from '../rbac/postgres-directory';
import {
  issueLocalApiKey,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  LocalCredentialError,
} from './local-credential';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[cli-auth/local-credential.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ' +
      'the local credential was NOT exercised against a real database.',
  );
}

const CONTROLLED_ENV = ['DATABASE_URL', 'MASTER_ENCRYPTION_KEY', 'SESSION_SECRET', 'RUNNER_URL'];
const ORIGIN = 'http://127.0.0.1:3000';

type IdContext = { params: Promise<{ id: string }> };

function idContext(id: string): IdContext {
  return { params: Promise.resolve({ id }) };
}

describe.skipIf(!hasDatabase)(
  'issueLocalApiKey through register() and the routes aw dev calls',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let composition: RegisteredComposition;
    const previousEnv = new Map<string, string | undefined>();
    const workspaceId = crypto.randomUUID();
    const adminUserId = crypto.randomUUID();
    const builderUserId = crypto.randomUUID();

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_local_credential');
      await isolated.db
        .insert(workspaces)
        .values({ id: workspaceId, slug: 'local', name: 'Local' });
      await isolated.db.insert(users).values([
        { id: adminUserId, email: 'admin@local.test', name: 'Admin' },
        { id: builderUserId, email: 'builder@local.test', name: 'Builder' },
      ]);
      await isolated.db.transaction(async (tx) => {
        for (const [userId, role] of [
          [adminUserId, 'admin'],
          [builderUserId, 'builder'],
        ] as const) {
          const membershipId = crypto.randomUUID();
          await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role });
          await tx
            .insert(workspacePrincipals)
            .values({ workspaceId, kind: 'membership', membershipId });
        }
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });

      for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
      process.env['DATABASE_URL'] = isolated.url;
      process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
      process.env['SESSION_SECRET'] = 'local-credential-integration-secret-32-chars';
      process.env['RUNNER_URL'] = 'http://127.0.0.1:9';

      const { register } = await import('../composition/register');
      const registered = await register();
      if (registered === undefined) throw new Error('composition registration was skipped');
      composition = registered;
    }, 180_000);

    afterAll(async () => {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeIsolatedTestResources(isolated, composition, root);
    });

    function request(token: string, method: string, path: string, body?: unknown): Request {
      return new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    /** The edge decision `apps/web/proxy.ts` makes for this request: passed through, or refused. */
    async function edgeAdmits(token: string, method: string, path: string): Promise<boolean> {
      const response = await proxy(
        new NextRequest(new URL(path, ORIGIN), {
          method,
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      return response.headers.get('x-middleware-next') === '1';
    }

    async function expectStatus(response: Response, status: number): Promise<unknown> {
      const text = await response.text();
      expect(response.status, text).toBe(status);
      return text === '' ? null : (JSON.parse(text) as unknown);
    }

    function field(value: unknown, ...path: readonly string[]): unknown {
      let current = value;
      for (const key of path) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = (current as Record<string, unknown>)[key];
      }
      return current;
    }

    it('admits the key at the edge and on every route aw dev calls, then refuses it after revoke', async () => {
      const credential = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const { token } = credential;
      expect(token).toMatch(API_KEY_PATTERN);

      const calls: (readonly [string, string])[] = [];
      const call = async (method: string, path: string): Promise<void> => {
        calls.push([method, path]);
        expect(await edgeAdmits(token, method, path), `${method} ${path} at the edge`).toBe(true);
      };

      await call('GET', '/api/me');
      const me = await expectStatus(await meRoute(request(token, 'GET', '/api/me')), 200);
      expect(field(me, 'workspaceId')).toBe(workspaceId);

      await call('GET', '/api/model-connections');
      await expectStatus(
        await listModelConnections(request(token, 'GET', '/api/model-connections')),
        200,
      );

      await call('POST', '/api/model-connections');
      const connection = await expectStatus(
        await postModelConnection(
          request(token, 'POST', '/api/model-connections', {
            name: 'default',
            provider: 'anthropic',
            apiKey: 'sk-ant-local-credential-integration',
          }),
        ),
        201,
      );
      expect(field(connection, 'name')).toBe('default');

      await call('GET', '/api/agents');
      await expectStatus(await listAgents(request(token, 'GET', '/api/agents')), 200);

      await call('POST', '/api/agents');
      const created = await expectStatus(
        await postAgent(request(token, 'POST', '/api/agents', fromVersionRequest())),
        201,
      );
      const agentId = field(created, 'agent', 'id');
      if (typeof agentId !== 'string') throw new Error('POST /api/agents answered no agent id');

      const versionsPath = `/api/agents/${agentId}/versions`;
      await call('GET', versionsPath);
      await expectStatus(
        await listVersions(request(token, 'GET', versionsPath), idContext(agentId)),
        200,
      );

      await call('POST', versionsPath);
      const version = await expectStatus(
        await postVersion(
          request(
            token,
            'POST',
            versionsPath,
            versionRequest({ instructions: 'Answer support mail politely.' }),
          ),
          idContext(agentId),
        ),
        201,
      );
      const number = field(version, 'number');
      expect(number).toBe(2);

      const pointersPath = `/api/agents/${agentId}/pointers`;
      await call('PUT', pointersPath);
      const pointer = await expectStatus(
        await putPointer(
          request(token, 'PUT', pointersPath, { environment: 'local', version: number }),
          idContext(agentId),
        ),
        200,
      );
      expect(field(pointer, 'pointer', 'number')).toBe(2);

      // `aw agents export` reads the agent and its policy.
      await call('GET', `/api/agents/${agentId}`);
      await expectStatus(
        await getAgent(request(token, 'GET', `/api/agents/${agentId}`), idContext(agentId)),
        200,
      );
      await call('GET', `/api/agents/${agentId}/policy`);
      await expectStatus(
        await getAgentPolicy(
          request(token, 'GET', `/api/agents/${agentId}/policy`),
          idContext(agentId),
        ),
        200,
      );
      expect(calls.length).toBeGreaterThanOrEqual(10);

      await expect(credential.revoke()).resolves.toBe('revoked');
      await expectStatus(
        await listModelConnections(request(token, 'GET', '/api/model-connections')),
        401,
      );
      await expect(
        createPostgresDirectory(root.directory).authenticateApiKey(token, new Date()),
      ).resolves.toBeNull();
      const rows = await isolated.db
        .select({ revokedAt: apiKeys.revokedAt, name: apiKeys.name, keyHash: apiKeys.keyHash })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, workspaceId));
      const local = rows.filter((row) => row.name.startsWith(LOCAL_RUNTIME_API_KEY_NAME_PREFIX));
      expect(local).toHaveLength(1);
      expect(local[0]?.revokedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(rows)).not.toContain(token);
      await expect(credential.revoke()).resolves.toBe('already-revoked');
    }, 120_000);

    it('revokes a key a crashed run left behind when the next run issues its own', async () => {
      const crashed = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const next = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      await expectStatus(
        await listModelConnections(request(crashed.token, 'GET', '/api/model-connections')),
        401,
      );
      await expectStatus(
        await listModelConnections(request(next.token, 'GET', '/api/model-connections')),
        200,
      );
      await expect(next.revoke()).resolves.toBe('revoked');
    }, 60_000);

    it('owns what the local key writes as the admin it acts for, keeping the key as the actor (S1-24)', async () => {
      const directory = createPostgresDirectory(root.directory);
      const admin = (await root.directory.forWorkspace(workspaceId).listMemberships()).find(
        (member) => member.userId === adminUserId,
      );
      if (admin === undefined) throw new Error('the admin has no membership principal');

      const local = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const localIdentity = await directory.authenticateApiKey(local.token, new Date());
      if (localIdentity === null) throw new Error('the local key does not authenticate');
      expect(localIdentity.actsForPrincipalId).toBe(admin.principalId);

      const created = await expectStatus(
        await postAgent(
          request(
            local.token,
            'POST',
            '/api/agents',
            fromVersionRequest({ name: 'Owned locally' }),
          ),
        ),
        201,
      );
      const agentId = field(created, 'agent', 'id');
      if (typeof agentId !== 'string') throw new Error('POST /api/agents answered no agent id');
      expect(field(created, 'agent', 'ownerPrincipalId')).toBe(admin.principalId);

      // The pointer write is audited under the acting key, not the admin it acts for.
      await expectStatus(
        await postVersion(
          request(
            local.token,
            'POST',
            `/api/agents/${agentId}/versions`,
            versionRequest({ name: 'Owned locally', instructions: 'Answer politely.' }),
          ),
          idContext(agentId),
        ),
        201,
      );
      await expectStatus(
        await putPointer(
          request(local.token, 'PUT', `/api/agents/${agentId}/pointers`, {
            environment: 'local',
            version: 2,
          }),
          idContext(agentId),
        ),
        200,
      );
      const audited = await isolated.db
        .select({ actor: auditEvents.actorPrincipalId })
        .from(auditEvents)
        .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.subjectId, agentId)));
      expect(audited.length).toBeGreaterThan(0);
      expect(audited.every((row) => row.actor === localIdentity.principalId)).toBe(true);
      const versions = await isolated.db
        .select({ createdBy: agentVersions.createdByPrincipalId })
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agentId));
      expect(versions.map((row) => row.createdBy)).toEqual([
        localIdentity.principalId,
        localIdentity.principalId,
      ]);

      // Regression: a hosted admin key still owns what it writes.
      const minted = await mintApiKey();
      const hosted = await root.directory.forWorkspace(workspaceId).createApiKey({
        name: 'hosted admin key',
        role: 'admin',
        keyPrefix: minted.keyPrefix,
        keyHash: minted.keyHash,
        expiresAt: null,
      });
      if (hosted.kind !== 'created') throw new Error(hosted.kind);
      expect(hosted.key.actsForPrincipalId).toBeNull();
      const hostedAgent = await expectStatus(
        await postAgent(
          request(minted.presented, 'POST', '/api/agents', fromVersionRequest({ name: 'Hosted' })),
        ),
        201,
      );
      expect(field(hostedAgent, 'agent', 'ownerPrincipalId')).toBe(hosted.key.principalId);

      // After the run stops, the agent is still the admin's, and still readable by the next run.
      await expect(local.revoke()).resolves.toBe('revoked');
      const next = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const read = await expectStatus(
        await getAgent(request(next.token, 'GET', `/api/agents/${agentId}`), idContext(agentId)),
        200,
      );
      expect(field(read, 'ownerPrincipalId')).toBe(admin.principalId);
      await expect(next.revoke()).resolves.toBe('revoked');
    }, 120_000);

    it('repairs a row an earlier local key still owns before the next run sweeps it (S1-24)', async () => {
      const admin = (await root.directory.forWorkspace(workspaceId).listMemberships()).find(
        (member) => member.userId === adminUserId,
      );
      if (admin === undefined) throw new Error('the admin has no membership principal');
      const earlier = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const earlierIdentity = await createPostgresDirectory(root.directory).authenticateApiKey(
        earlier.token,
        new Date(),
      );
      if (earlierIdentity === null) throw new Error('the earlier key does not authenticate');
      const created = await expectStatus(
        await postAgent(
          request(earlier.token, 'POST', '/api/agents', fromVersionRequest({ name: 'Legacy' })),
        ),
        201,
      );
      const agentId = field(created, 'agent', 'id');
      if (typeof agentId !== 'string') throw new Error('POST /api/agents answered no agent id');
      await expect(earlier.revoke()).resolves.toBe('revoked');
      // Data written before the fix: the agent is owned by the (now revoked) key principal itself.
      await isolated.db
        .update(agents)
        .set({ ownerPrincipalId: earlierIdentity.principalId })
        .where(eq(agents.id, agentId));

      const next = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const [row] = await isolated.db
        .select({ owner: agents.ownerPrincipalId })
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(row?.owner).toBe(admin.principalId);
      await expectStatus(
        await getAgent(request(next.token, 'GET', `/api/agents/${agentId}`), idContext(agentId)),
        200,
      );
      await expect(next.revoke()).resolves.toBe('revoked');
    }, 120_000);

    it('reads the role from the stored membership: a builder, or a non-member, gets nothing', async () => {
      const before = await isolated.db.select({ id: apiKeys.id }).from(apiKeys);
      for (const userId of [builderUserId, crypto.randomUUID()]) {
        const failure = issueLocalApiKey({ workspaceId, userId }, { directory: root.directory });
        await expect(failure).rejects.toBeInstanceOf(LocalCredentialError);
        await expect(failure).rejects.toMatchObject({ code: 'not_issued' });
      }
      // A role the caller claims is not an input at all, so it cannot lift a builder to admin.
      const claimed = issueLocalApiKey(
        { workspaceId, userId: builderUserId, role: 'admin' },
        { directory: root.directory },
      );
      await expect(claimed).rejects.toMatchObject({ code: 'invalid_input' });
      const after = await isolated.db.select({ id: apiKeys.id }).from(apiKeys);
      expect(after).toHaveLength(before.length);
    }, 60_000);

    it('refuses the local key every write that would outlive the run, and the reserved name to everyone', async () => {
      const credential = await issueLocalApiKey(
        { workspaceId, userId: adminUserId },
        { directory: root.directory },
      );
      const { token } = credential;
      const before = await isolated.db.select({ id: apiKeys.id }).from(apiKeys);
      const [builderMembership] = await isolated.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, builderUserId));
      if (builderMembership === undefined) throw new Error('the builder has no membership');
      const membershipPath = `/api/memberships/${builderMembership.id}`;
      const [someKey] = before;
      if (someKey === undefined) throw new Error('no api_keys row to name');
      const keyPath = `/api/api-keys/${someKey.id}`;

      const refusals: readonly (readonly [string, Promise<Response>])[] = [
        [
          'POST /api/api-keys',
          postApiKey(request(token, 'POST', '/api/api-keys', { name: 'persisted', role: 'admin' })),
        ],
        [
          `DELETE ${keyPath}`,
          revokeApiKeyRoute(request(token, 'DELETE', keyPath), idContext(someKey.id)),
        ],
        [
          'POST /api/users',
          postUser(
            request(token, 'POST', '/api/users', {
              email: 'new@local.test',
              name: 'New',
              role: 'admin',
            }),
          ),
        ],
        [
          'POST /api/memberships',
          postMembership(
            request(token, 'POST', '/api/memberships', {
              email: 'admin@local.test',
              role: 'admin',
            }),
          ),
        ],
        [
          `PATCH ${membershipPath}`,
          patchMembership(
            request(token, 'PATCH', membershipPath, { role: 'admin' }),
            idContext(builderMembership.id),
          ),
        ],
        [
          `DELETE ${membershipPath}`,
          deleteMembershipRoute(
            request(token, 'DELETE', membershipPath),
            idContext(builderMembership.id),
          ),
        ],
      ];
      for (const [label, pending] of refusals) {
        const body = await expectStatus(await pending, 403);
        expect(field(body, 'error', 'code'), label).toBe('local_runtime_key_not_permitted');
      }
      const after = await isolated.db.select({ id: apiKeys.id }).from(apiKeys);
      expect(after).toHaveLength(before.length);
      const [builderAfter] = await isolated.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, builderUserId));
      expect(builderAfter?.role).toBe('builder');
      const newUsers = await isolated.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, 'new@local.test'));
      expect(newUsers).toHaveLength(0);

      // A person's own admin key is not the local key: it still mints, but not a reserved name.
      const minted = await mintApiKey();
      const personal = await root.directory.forWorkspace(workspaceId).createApiKey({
        name: 'person admin key',
        role: 'admin',
        keyPrefix: minted.keyPrefix,
        keyHash: minted.keyHash,
        expiresAt: null,
      });
      expect(personal.kind).toBe('created');
      const reserved = await expectStatus(
        await postApiKey(
          request(minted.presented, 'POST', '/api/api-keys', {
            name: `  ${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}mine`,
            role: 'viewer',
          }),
        ),
        400,
      );
      expect(field(reserved, 'error', 'code')).toBe('reserved_name');
      await expectStatus(
        await postApiKey(
          request(minted.presented, 'POST', '/api/api-keys', { name: 'ci key', role: 'viewer' }),
        ),
        201,
      );
      await expect(credential.revoke()).resolves.toBe('revoked');
    }, 120_000);
  },
);
