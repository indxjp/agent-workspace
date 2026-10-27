import crypto from 'node:crypto';

import {
  auditEvents,
  apiKeys,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseRuntimeProfileRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  runtimeProfiles,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PATCH } from '../../app/api/agents/[id]/route';
import { applicationContext, clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createRepositoryAgentVersionStoreProvider } from '../agent-versions/store';
import { createRepositoryRuntimeProfileStoreProvider } from '../runtimes/store';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createRepositoryAgentResourceStoreProvider } from './resource-store';
import { createRuntimeSwitchAudit } from './runtime-switch-audit';
import { createRepositoryAgentStoreProvider } from './store';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

describe.skipIf(!hasDatabase)('runtime switch audit through PATCH /api/agents/:id', () => {
  let isolated: IsolatedTestDatabase;
  const workspace = { id: crypto.randomUUID(), slug: 'runtime-audit', name: 'Runtime Audit' };
  const user = {
    id: crypto.randomUUID(),
    email: 'runtime-audit@example.test',
    name: 'Runtime Admin',
  };
  const localProfile = { id: crypto.randomUUID(), name: 'Local', driver: 'local' as const };
  const dockerProfile = { id: crypto.randomUUID(), name: 'Docker', driver: 'docker' as const };
  const membershipId = crypto.randomUUID();
  const membershipPrincipalId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  const apiKeyPrincipalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w3_runtime_switch_audit');
    await isolated.db.insert(workspaces).values(workspace);
    await isolated.db.insert(users).values(user);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: membershipId,
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
      });
      await tx.insert(apiKeys).values({
        id: apiKeyId,
        workspaceId: workspace.id,
        name: 'Runtime switch audit key',
        role: 'owner',
        keyPrefix: 'ak_runtime_audit',
        keyHash: 'a'.repeat(64),
      });
      await tx.insert(workspacePrincipals).values([
        {
          id: membershipPrincipalId,
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId,
        },
        {
          id: apiKeyPrincipalId,
          workspaceId: workspace.id,
          kind: 'api_key',
          apiKeyId,
        },
      ]);
    });
    await isolated.db.insert(runtimeProfiles).values(
      [localProfile, dockerProfile].map((profile) => ({
        ...profile,
        workspaceId: workspace.id,
        networkPolicy: 'none' as const,
        filesystem: 'read-write' as const,
      })),
    );

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const agents = createRepositoryAgentStoreProvider({
      repositories: createDatabaseAgentRepositoryProvider(isolated.db),
      scopes,
    });
    const profiles = createRepositoryRuntimeProfileStoreProvider({
      repositories: createDatabaseRuntimeProfileRepositoryProvider(isolated.db),
      scopes,
    });
    installTestDomains({
      agents: {
        agents,
        agentResources: createRepositoryAgentResourceStoreProvider({
          repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
          scopes,
        }),
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: workspace.id }),
        runtimeSwitchAudit: createRuntimeSwitchAudit({
          profiles,
          identifyActor: () =>
            Promise.resolve({
              principalId: apiKeyPrincipalId,
              userId: null,
              userLabel: 'Runtime switch audit key',
              workspaceId: workspace.id,
            }),
          recordAuditEvent: async (event) => {
            await isolated.db.insert(auditEvents).values(event);
          },
        }),
      },
    });
    // Issue #616: the PATCH saves a version, so the version store is part of the runtime.
    installTestDomains({
      agentVersions: {
        versions: createRepositoryAgentVersionStoreProvider({
          repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
          evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
          scopes,
        }),
      },
    });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory(),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: apiKeyPrincipalId,
              apiKeyId,
              workspaceId: workspace.id,
              role: 'owner',
              label: 'Runtime switch audit key',
            }),
          ),
      },
    });
  }, 180_000);

  afterAll(async () => {
    clearApplicationContext();
    await isolated.close();
  });

  it('writes exactly one §36 row naming both driver ids', async () => {
    const runtime = applicationContext()?.agents ?? null;
    if (runtime === null) throw new Error('test runtime was not configured');
    const created = await runtime.agents.forWorkspace(workspace.id).create(
      {
        name: 'Switcher',
        instructions: '',
        modelConnectionId: null,
        model: null,
        runtimeProfileId: localProfile.id,
        permissions: {
          readFiles: true,
          writeFiles: true,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
      { principalId: membershipPrincipalId, userId: user.id },
    );
    if (created.kind !== 'created') throw new Error(`agent create failed: ${created.kind}`);

    const response = await PATCH(
      new Request(`http://test/api/agents/${created.agent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeProfileId: dockerProfile.id }),
      }),
      { params: Promise.resolve({ id: created.agent.id }) },
    );
    expect(response.status).toBe(200);

    // The edit is also a `local` pointer move, which writes its own `agent-changed` row (#616).
    const rows = (await isolated.db.select().from(auditEvents)).filter(
      (row) => !row.subjectLabel.includes('-> version'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: workspace.id,
      actorPrincipalId: apiKeyPrincipalId,
      actorUserId: null,
      actorLabel: 'Runtime switch audit key',
      action: 'agent-changed',
      subjectId: created.agent.id,
    });
    expect(rows[0]?.subjectLabel).toContain('local -> docker');
  });
});
