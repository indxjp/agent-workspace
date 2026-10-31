/**
 * An archive that commits between a pointer move's handler read and its locked transaction
 * (issue #1987, ledger SEC-07) on PostgreSQL. The handler refuses an archived agent from the row it
 * read before `applyAndPoint` took the pointer lock; this file archives the agent in that window
 * and proves the move is refused `409 agent_archived` inside the transaction, with the pointer, the
 * agent row and the audit log untouched, whichever door asked: set, promote or rollback.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agentVersionPointers,
  agents,
  auditEvents,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseAuditEventRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { AgentVersionResourceSchema } from '@indx-workspace/contracts/agent-versions';

import { PUT as setPointer } from './route';
import { POST as promote } from '../promote/route';
import { POST as rollback } from '../rollback/route';
import { POST as saveVersion } from '../versions/route';
import { createRepositoryAgentResourceStoreProvider } from '../../../../../server/agents/resource-store';
import { createRepositoryAgentStoreProvider } from '../../../../../server/agents/store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import { versionRequest } from '../../../../../server/agent-versions/fixtures';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
} from '../../../../../server/agent-versions/store';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe.skipIf(!hasDatabase)('a pointer move racing an archive on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();
  /** Runs once, inside the next `applyAndPoint`, before the repository opens its transaction. */
  let beforeApply: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_pointer_archive_race');
    await isolated.db
      .insert(workspaces)
      .values([{ id: workspaceId, slug: 'race', name: 'Archive race' }]);
    await isolated.db
      .insert(users)
      .values([{ id: ownerUserId, email: `${ownerUserId}@example.test`, name: 'Owner' }]);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values([{ id: membershipId, workspaceId, userId: ownerUserId, role: 'owner' }]);
      await tx.insert(workspacePrincipals).values({
        id: ownerPrincipalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const real = createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes,
    });
    const racing: AgentVersionStoreProvider = {
      async forWorkspace(id) {
        const store = await real.forWorkspace(id);
        if (store === null) return null;
        return {
          ...store,
          applyAndPoint: async (agentId, input) => {
            const hook = beforeApply;
            beforeApply = null;
            await hook?.();
            return store.applyAndPoint(agentId, input);
          },
        };
      },
    };
    installTestDomains({
      agents: {
        agents: createRepositoryAgentStoreProvider({
          repositories: createDatabaseAgentRepositoryProvider(isolated.db),
          scopes,
        }),
        agentResources: createRepositoryAgentResourceStoreProvider({
          repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
          scopes,
        }),
        resolveWorkspace: (): Promise<WorkspaceResolution> =>
          Promise.resolve({ kind: 'workspace', workspaceId }),
      },
    });
    installTestDomains({ agentVersions: { versions: racing } });
    installTestDomains({
      audit: { scopes, repositories: createDatabaseAuditEventRepositoryProvider(isolated.db) },
    });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({ users: [] }),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: ownerPrincipalId,
              apiKeyId: crypto.randomUUID(),
              workspaceId,
              role: 'owner',
              label: 'race owner key',
            }),
          ),
      },
    });
  }, 180_000);

  beforeEach(() => {
    beforeApply = null;
  });

  afterAll(async () => {
    clearApplicationContext();
    await isolated.close();
  });

  function context(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  function post(path: string, body: unknown): Request {
    return new Request(`https://example.invalid/api/agents/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function newAgent(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id,
      workspaceId,
      name,
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: PERMISSIONS,
      createdBy: ownerUserId,
      ownerPrincipalId,
    });
    return id;
  }

  async function save(id: string, name: string, instructions: string): Promise<number> {
    const response = await saveVersion(
      post(`${id}/versions`, versionRequest({ name, instructions })),
      context(id),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return AgentVersionResourceSchema.parse(await response.json()).number;
  }

  async function put(id: string, body: unknown): Promise<Response> {
    const response = await setPointer(
      new Request(`https://example.invalid/api/agents/${id}/pointers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      context(id),
    );
    return response;
  }

  function archiveBeforeNextMove(id: string): void {
    beforeApply = async () => {
      await isolated.db.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, id));
    };
  }

  async function snapshot(id: string) {
    const [row] = await isolated.db.select().from(agents).where(eq(agents.id, id));
    return {
      row,
      pointers: await isolated.db
        .select({
          environment: agentVersionPointers.environment,
          versionId: agentVersionPointers.versionId,
        })
        .from(agentVersionPointers)
        .where(eq(agentVersionPointers.agentId, id)),
      audits: await isolated.db.$count(
        auditEvents,
        and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, id)),
      ),
    };
  }

  async function expectFrozen(response: Response): Promise<void> {
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'agent_archived' } });
  }

  it('refuses a set that an archive overtook, and moves nothing', async () => {
    const id = await newAgent('Race set');
    const first = await save(id, 'Race set', 'Version one.');
    await save(id, 'Race set', 'Version two.');
    expect((await put(id, { environment: 'local', version: first })).status).toBe(200);
    const before = await snapshot(id);

    archiveBeforeNextMove(id);
    await expectFrozen(await put(id, { environment: 'local', version: 2 }));

    const after = await snapshot(id);
    expect(after.pointers).toEqual(before.pointers);
    expect(after.audits).toBe(before.audits);
    expect(after.row).toMatchObject({
      instructions: 'Version one.',
      materialisedVersionId: before.row?.materialisedVersionId,
    });
  });

  it('refuses a promote that an archive overtook, and leaves production unpointed', async () => {
    const id = await newAgent('Race promote');
    const first = await save(id, 'Race promote', 'Version one.');
    expect((await put(id, { environment: 'local', version: first })).status).toBe(200);
    const before = await snapshot(id);

    archiveBeforeNextMove(id);
    await expectFrozen(await promote(post(`${id}/promote`, {}), context(id)));

    const after = await snapshot(id);
    expect(after.pointers).toEqual(before.pointers);
    expect(after.pointers.map((pointer) => pointer.environment)).toEqual(['local']);
    expect(after.audits).toBe(before.audits);
  });

  it('refuses a rollback that an archive overtook, and keeps the pointer where it was', async () => {
    const id = await newAgent('Race rollback');
    const first = await save(id, 'Race rollback', 'Version one.');
    const second = await save(id, 'Race rollback', 'Version two.');
    expect((await put(id, { environment: 'local', version: first })).status).toBe(200);
    expect((await put(id, { environment: 'local', version: second })).status).toBe(200);
    const before = await snapshot(id);

    archiveBeforeNextMove(id);
    await expectFrozen(
      await rollback(post(`${id}/rollback`, { environment: 'local' }), context(id)),
    );

    const after = await snapshot(id);
    expect(after.pointers).toEqual(before.pointers);
    expect(after.audits).toBe(before.audits);
    expect(after.row).toMatchObject({ instructions: 'Version two.' });
  });

  it('still moves the pointer of an agent that is not archived', async () => {
    const id = await newAgent('Race control');
    const first = await save(id, 'Race control', 'Version one.');
    archiveBeforeNextMove(await newAgent('Race bystander'));
    expect((await put(id, { environment: 'local', version: first })).status).toBe(200);
  });
});
