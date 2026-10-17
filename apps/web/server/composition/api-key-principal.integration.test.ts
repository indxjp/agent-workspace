import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { POST as createAgent } from '../../app/api/agents/route';
import { POST as createProject } from '../../app/api/projects/route';
import {
  apiKeys,
  agents,
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  projects,
  sessions,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { clearAgentsRuntime } from '../agents/runtime';
import { clearProjectsRuntime } from '../projects/runtime';
import { mintApiKey } from '../rbac/api-key';
import { clearRbacRuntime } from '../rbac/runtime';
import { installRunApi, resetRunApi } from '../runs/environment';
import { InMemoryRunStore } from '../runs/store';
import { clearSharesRuntime, currentSharesRuntime } from '../shares/core/runtime';
import { clearWorkspacesRuntime } from '../workspaces/runtime';

import { register, type RegisteredComposition } from './register';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/api-key-principal.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, ' +
      'so the production composition was not exercised with an API-key principal.',
  );
}

const CONTROLLED_ENV = [
  'AW_FILE_STORAGE_ROOT',
  'AW_RUNTIME_VERIFICATION_FILE',
  'AW_SKILL_STORAGE_ROOT',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'OBJECT_STORAGE_BUCKET',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

describe.skipIf(!hasDatabase)('production composition API-key principal', () => {
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
    clearAgentsRuntime();
    clearProjectsRuntime();
    clearRbacRuntime();
    resetRunApi();
    clearSharesRuntime();
    clearWorkspacesRuntime();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
    isolated = undefined;
    composition = undefined;
  });

  it('uses the persisted machine principal and refuses machine runnable shares without session writes', async () => {
    for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
    isolated = await createIsolatedTestDatabase('aw_composition_api_key_principal');
    const workspaceId = crypto.randomUUID();
    const apiKeyId = crypto.randomUUID();
    const minted = await mintApiKey();
    const label = 'Composition integration key';

    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: 'composition-api-key',
      name: 'Composition API key',
    });
    await isolated.db.insert(apiKeys).values({
      id: apiKeyId,
      workspaceId,
      name: label,
      role: 'owner',
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
    });
    const principal = (await isolated.db.select().from(workspacePrincipals)).find(
      (candidate) => candidate.apiKeyId === apiKeyId,
    );
    if (principal === undefined) throw new Error('API-key principal trigger created no identity');
    const principalId = principal.id;

    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'composition-api-key-test-secret-at-least-32-characters';
    delete process.env['NEXT_RUNTIME'];
    for (const key of CONTROLLED_ENV) {
      if (key !== 'DATABASE_URL' && key !== 'SESSION_SECRET' && key !== 'NEXT_RUNTIME') {
        delete process.env[key];
      }
    }
    composition = await register();
    expect(composition).toBeDefined();

    const headers = {
      authorization: `Bearer ${minted.presented}`,
      'content-type': 'application/json',
    };
    const agentResponse = await createAgent(
      new Request('https://example.invalid/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Machine-owned agent',
          instructions: 'Created by an API key.',
          modelConnectionId: null,
          model: 'claude-sonnet-4-5',
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        }),
      }),
    );
    expect(agentResponse.status, await agentResponse.clone().text()).toBe(201);

    const projectResponse = await createProject(
      new Request('https://example.invalid/api/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Machine-owned project',
          instructions: null,
          defaultAgentId: null,
          visibility: 'private',
          fileIds: [],
          mcpServerIds: [],
        }),
      }),
    );
    expect(projectResponse.status, await projectResponse.clone().text()).toBe(201);

    await expect(isolated.db.select().from(agents)).resolves.toEqual([
      expect.objectContaining({ ownerPrincipalId: principalId, createdBy: null }),
    ]);
    await expect(isolated.db.select().from(projects)).resolves.toEqual([
      expect.objectContaining({ ownerPrincipalId: principalId, createdBy: null }),
    ]);
    await expect(isolated.db.select().from(auditEvents)).resolves.toEqual([
      expect.objectContaining({
        actorPrincipalId: principalId,
        actorUserId: null,
        actorLabel: label,
        action: 'project-created',
      }),
    ]);

    const [machineAgent] = await isolated.db.select().from(agents);
    if (machineAgent === undefined) throw new Error('the machine-owned agent was not persisted');
    const sharesRuntime = currentSharesRuntime();
    if (sharesRuntime === null) throw new Error('the production shares runtime was not installed');
    installRunApi({
      authenticate: () => Promise.resolve(null),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(false),
      store: new InMemoryRunStore(),
      launch: () => undefined,
    });
    const visitorSessionId = crypto.randomUUID();
    await expect(
      sharesRuntime.runPublic({
        workspaceId,
        share: {
          id: crypto.randomUUID(),
          workspaceId,
          token: 'pub_machine_composition',
          subjectType: 'agent',
          subjectId: machineAgent.id,
          subjectLabel: machineAgent.name,
          visibility: 'public',
          mode: 'runnable',
          snapshot: null,
          include: {},
          budgetCapUsd: null,
          spentUsd: '0',
          stopped: false,
          expiresAt: null,
          passphraseHash: null,
          createdBy: null,
          publisherPrincipalId: principalId,
          revokedAt: null,
          suspendedAt: null,
          createdAt: new Date(),
        },
        prompt: 'This must not create a session.',
        sessionId: visitorSessionId,
      }),
    ).rejects.toThrow('Machine-published runnable shares are not enabled in this release.');
    expect(
      (await isolated.db.select().from(sessions)).find(
        (session) => session.id === visitorSessionId,
      ),
    ).toBeUndefined();
  }, 180_000);
});
