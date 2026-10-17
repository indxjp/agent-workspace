/**
 * `POST /api/agents/:id/versions` (S1-05, issue #443) on PostgreSQL: the real route, real RBAC
 * decision, and the real core repository (`createDatabaseAgentVersionRepositoryProvider`, S1-04)
 * through the adapter `register.ts` wires. The memory store restates C7 and the missing/ambiguous
 * rules; this file proves the real ones answer the same.
 */
import crypto from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  agentVersions,
  agents,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  mcpServers,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { POST } from './route';
import { createRepositoryAgentStoreProvider } from '../../../../../server/agents/store';
import {
  clearAgentsRuntime,
  configureAgentsRuntime,
  type WorkspaceResolution,
} from '../../../../../server/agents/runtime';
import { FIXTURE_POLICY, versionRequest } from '../../../../../server/agent-versions/fixtures';
import {
  clearAgentVersionsRuntime,
  configureAgentVersionsRuntime,
} from '../../../../../server/agent-versions/runtime';
import { createRepositoryAgentVersionStoreProvider } from '../../../../../server/agent-versions/store';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
} from '../../../../../server/engines/registry';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../../../server/rbac/runtime';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[versions.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the version routes ' +
      'were NOT exercised against the real core repository.',
  );
}

describe.skipIf(!hasDatabase)('POST /api/agents/:id/versions on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  /** Who the next request authenticates as; RBAC's `decide()` runs on it for real. */
  let caller: { principalId: string; role: 'owner' | 'builder' | 'viewer' } = {
    principalId: ownerPrincipalId,
    role: 'owner',
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_dj_s1_05_versions');
    await isolated.db
      .insert(workspaces)
      .values([{ id: workspaceId, slug: 'versions', name: 'Versions' }]);
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
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Support triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      createdBy: ownerUserId,
      ownerPrincipalId,
    });
    await isolated.db.insert(mcpServers).values({
      workspaceId,
      name: 'crm',
      transport: 'http',
      url: 'https://crm.example.test/mcp',
      createdBy: ownerUserId,
      ownerPrincipalId,
    });

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    configureAgentsRuntime({
      agents: createRepositoryAgentStoreProvider({
        repositories: createDatabaseAgentRepositoryProvider(isolated.db),
        scopes,
      }),
      resolveWorkspace: (): Promise<WorkspaceResolution> =>
        Promise.resolve({ kind: 'workspace', workspaceId }),
    });
    configureAgentVersionsRuntime({
      versions: createRepositoryAgentVersionStoreProvider({
        repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
        evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
        scopes,
      }),
    });
    configureRbacRuntime({
      directory: createMemoryDirectory({ users: [] }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: caller.principalId,
            apiKeyId: crypto.randomUUID(),
            workspaceId,
            role: caller.role,
            label: `versions ${caller.role} key`,
          }),
        ),
    });
  }, 180_000);

  afterEach(() => {
    clearEnginesRegisteredForTests();
    caller = { principalId: ownerPrincipalId, role: 'owner' };
  });

  afterAll(async () => {
    clearAgentsRuntime();
    clearAgentVersionsRuntime();
    clearRbacRuntime();
    await isolated.close();
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new Request(`https://example.invalid/api/agents/${agentId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: agentId }) },
    );
  }

  async function versionRows(): Promise<number> {
    return (await isolated.db.select({ id: agentVersions.id }).from(agentVersions)).length;
  }

  it('refuses a Viewer dry run with 403 forbidden and writes nothing', async () => {
    caller = { principalId: crypto.randomUUID(), role: 'viewer' };
    const before = await versionRows();
    const response = await post({ ...versionRequest(), dryRun: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await versionRows()).toBe(before);
  });

  it("refuses a Builder on another principal's agent with 403 forbidden and writes nothing", async () => {
    caller = { principalId: crypto.randomUUID(), role: 'builder' };
    const before = await versionRows();
    const response = await post(versionRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await versionRows()).toBe(before);
  });

  it('refuses U+0000 with the same 400 in a dry run and a save, before PostgreSQL sees it', async () => {
    const before = await versionRows();
    const stored = versionRequest();
    const inInstructions = {
      ...stored,
      body: {
        ...stored.body,
        definition: {
          ...stored.body.definition,
          agent: { ...stored.body.definition.agent, instructions: 'before\u0000after' },
        },
      },
    };
    const inResolvedName = versionRequest({ modelConnectionName: 'a\u0000b' });
    for (const [body, path] of [
      [inInstructions, 'body.definition.agent.instructions'],
      [inResolvedName, 'body.definition.agent.modelConnectionName'],
    ] as const) {
      const dryRun = await post({ ...body, dryRun: true });
      const save = await post(body);
      expect(dryRun.status).toBe(400);
      expect(save.status).toBe(400);
      const dryRunBody: unknown = await dryRun.json();
      expect(dryRunBody).toMatchObject({ error: { code: 'invalid_agent_version' } });
      expect(JSON.stringify(dryRunBody)).toContain(`"${path}: must not contain U+0000`);
      expect(await save.json()).toEqual(dryRunBody);
    }
    expect(await versionRows()).toBe(before);
  });

  it('refuses a connector on an engine without mcp with 422 engine_capability_unsupported', async () => {
    registerEngineForTests({
      id: 'claude-agent-sdk',
      displayName: 'Claude Agent SDK (test: no MCP)',
      version: 'test',
      capabilities: {
        mcp: false,
        skills: true,
        subagents: false,
        resume: true,
        fork: false,
        interrupt: true,
        streamingText: false,
        reasoning: true,
        maxTurns: 'native',
        maxBudget: 'native',
        wireProtocols: ['anthropic-messages'],
      },
    });
    const response = await post(versionRequest({ resources: { connectors: ['crm'] } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['mcp'] },
    });
  });

  it('refuses a missing skill with 422 agent_definition_references_missing', async () => {
    const response = await post(versionRequest({ resources: { skills: ['triage'] } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'agent_definition_references_missing', details: ['skill:triage'] },
    });
  });

  it('writes nothing for a dry run, then saves version 1', async () => {
    const before = await versionRows();
    const dryRun = await post({ ...versionRequest(), dryRun: true });
    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toEqual({ ok: true, number: 1 });
    expect(await versionRows()).toBe(before);

    const saved = await post(versionRequest({ resources: { connectors: ['crm'] } }));
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({
      number: 1,
      agentId,
      workspaceId,
      createdByPrincipalId: ownerPrincipalId,
      body: { definition: { policy: FIXTURE_POLICY } },
    });
    expect(await versionRows()).toBe(before + 1);
  });

  it("saves a 'default' model connection the workspace does not have (C7)", async () => {
    const response = await post(versionRequest({ modelConnectionName: 'default' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ number: 2 });
  });
});
