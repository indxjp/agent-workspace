import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents as agentRows } from '../schema/agents.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentRepositoryProvider } from './agents.js';
import { createDatabaseAuditEventRepositoryProvider } from './audit-events.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
import { createDatabaseProjectRepositoryProvider } from './projects.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseSessionRepositoryProvider } from './runs.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = (process.env['TEST_DATABASE_URL'] ?? '').trim() !== '';

function postgresViolation(
  error: unknown,
): { code: string; constraint: string | undefined } | null {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return null;
}

describe.skipIf(!hasDatabase)('principal-owned repository writes', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const humanUserId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_rf101_owned_repository');
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: `rf101-owned-${workspaceId.slice(0, 8)}`,
      name: 'RF-101 owned resources',
    });
    await isolated.db.insert(users).values({
      id: humanUserId,
      email: 'owner@example.test',
      name: 'Owner',
    });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('writes and reads an API-key principal without fabricating a legacy human owner', async () => {
    const directoryRoot = createDatabaseDirectoryRoot(isolated.db);
    const directory = directoryRoot.forWorkspace(workspaceId);
    const membership = await directory.createMembership({
      email: 'owner@example.test',
      role: 'owner',
    });
    if (membership.kind !== 'created') throw new Error(membership.kind);
    const key = await directory.createApiKey({
      name: 'resource-writer',
      role: 'builder',
      keyPrefix: 'ak_live_resource_writer',
      keyHash: crypto.createHash('sha256').update('resource-writer').digest('hex'),
      expiresAt: null,
    });
    if (key.kind !== 'created') throw new Error(key.kind);
    const principalId = key.key.principalId;

    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace scope was not created');

    const agents = createDatabaseAgentRepositoryProvider(isolated.db).forScope(scope);
    const createdAgent = await agents.create({
      name: 'Machine owned',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: principalId,
    });
    expect(createdAgent.kind).toBe('created');
    if (createdAgent.kind !== 'created') throw new Error(createdAgent.kind);
    expect(createdAgent.agent).toMatchObject({ ownerPrincipalId: principalId, createdBy: null });

    const catalog = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scope);
    const file = await catalog.putFile({
      path: 'machine.txt',
      kind: 'file',
      storageKey: 'machine.txt',
      sizeBytes: 7,
      contentType: 'text/plain',
      ownerPrincipalId: principalId,
    });
    const skill = await catalog.putSkill({
      name: 'machine-skill',
      skillMd: '---\nname: machine-skill\n---\n',
      enabled: true,
      ownerPrincipalId: principalId,
    });
    expect(file).toMatchObject({ ownerPrincipalId: principalId, createdBy: null });
    expect(skill).toMatchObject({ ownerPrincipalId: principalId, createdBy: null });

    const connectors = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scope);
    const connector = await connectors.create({
      name: 'machine-connector',
      transport: 'stdio',
      command: 'node',
      args: [],
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalId,
    });
    expect(connector.kind).toBe('created');
    if (connector.kind !== 'created') throw new Error(connector.kind);
    expect(connector.server).toMatchObject({ ownerPrincipalId: principalId, createdBy: null });

    const projects = createDatabaseProjectRepositoryProvider(isolated.db).forScope(scope);
    const project = await projects.create({
      name: 'Machine project',
      instructions: null,
      defaultAgentId: createdAgent.agent.id,
      visibility: 'private',
      ownerPrincipalId: principalId,
    });
    expect(project).toMatchObject({ ownerPrincipalId: principalId, createdBy: null });

    const sessions = createDatabaseSessionRepositoryProvider(isolated.db).forScope(scope);
    const session = await sessions.ensure({
      id: crypto.randomUUID(),
      agentId: createdAgent.agent.id,
      projectId: project.id,
      ownerPrincipalId: principalId,
    });
    expect(session.kind).toBe('created');
    if (session.kind !== 'created') throw new Error(session.kind);
    expect(session.session).toMatchObject({ ownerPrincipalId: principalId, userId: null });

    const shares = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    const share = await shares.create({
      token: `rf101_${crypto.randomUUID()}`,
      subjectType: 'agent',
      subjectId: createdAgent.agent.id,
      subjectLabel: createdAgent.agent.name,
      visibility: 'private',
      mode: 'definition',
      snapshot: {},
      include: {},
      budgetCapUsd: null,
      expiresAt: null,
      passphraseHash: null,
      publisherPrincipalId: principalId,
    });
    expect(share).toMatchObject({ publisherPrincipalId: principalId, createdBy: null });

    const audit = createDatabaseAuditEventRepositoryProvider(isolated.db).forScope(scope);
    await audit.write({
      actorPrincipalId: principalId,
      actorLabel: 'API key: resource-writer',
      action: 'agent-changed',
      subjectId: createdAgent.agent.id,
      subjectLabel: createdAgent.agent.name,
    });
    await expect(audit.list()).resolves.toEqual({
      items: [
        expect.objectContaining({
          actorPrincipalId: principalId,
          actorUserId: null,
          actorLabel: 'API key: resource-writer',
        }),
      ],
      nextCursor: null,
    });
  });

  it('rejects an owned row paired with a principal from another workspace', async () => {
    const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(workspaceId);
    const key = await directory.createApiKey({
      name: 'cross-tenant-probe',
      role: 'builder',
      keyPrefix: `ak_cross_${crypto.randomUUID().slice(0, 8)}`,
      keyHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      expiresAt: null,
    });
    if (key.kind !== 'created') throw new Error(key.kind);

    const otherWorkspaceId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: otherWorkspaceId,
      slug: `rf101-other-${otherWorkspaceId.slice(0, 8)}`,
      name: 'RF-101 other tenant',
    });

    let violation: unknown;
    try {
      await isolated.db.insert(agentRows).values({
        id: crypto.randomUUID(),
        workspaceId: otherWorkspaceId,
        name: 'Cross-tenant owner probe',
        instructions: '',
        ownerPrincipalId: key.key.principalId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
    } catch (error) {
      violation = error;
    }

    expect(postgresViolation(violation)).toEqual({
      code: '23503',
      constraint: 'agents_owner_principal_workspace_fk',
    });
  });
});
