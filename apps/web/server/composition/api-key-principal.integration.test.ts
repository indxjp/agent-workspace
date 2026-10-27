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
import { mintApiKey } from '../rbac/api-key';
import { InMemoryRunStore } from '../runs/memory-store';

import { register, type RegisteredComposition } from './register';
import { applicationContext, clearApplicationContext } from '../application-context';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/api-key-principal.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, ' +
      'so the production composition was not exercised with an API-key principal.',
  );
}

const CONTROLLED_ENV = [
  'AW_DEPLOYMENT_POLICY',
  'AW_STORAGE_URL',
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

  // W3-6: the agents and version runtimes carry one ceiling, `enforced` whenever
  // `AW_DEPLOYMENT_POLICY` is set and `disabled` only when it is unset.
  it.each([
    ['set', '{"models":["claude-opus-4-1"]}', 'enforced'],
    ['unset', undefined, 'disabled'],
  ] as const)(
    'installs the agents ceiling with AW_DEPLOYMENT_POLICY %s',
    async (_, policy, kind) => {
      for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
      isolated = await createIsolatedTestDatabase('aw_composition_agents_ceiling');
      for (const key of CONTROLLED_ENV) delete process.env[key];
      process.env['DATABASE_URL'] = isolated.url;
      process.env['SESSION_SECRET'] = 'composition-api-key-test-secret-at-least-32-characters';
      if (policy !== undefined) process.env['AW_DEPLOYMENT_POLICY'] = policy;
      composition = await register();

      const context = applicationContext();
      expect(context?.agents.ceiling.kind).toBe(kind);
      expect(context?.agents.ceiling).toBe(context?.agentVersions.ceiling);
    },
  );

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
    const sharesRuntime = applicationContext()?.shares ?? null;
    if (sharesRuntime === null) throw new Error('the production shares runtime was not installed');
    installTestRunApi({
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
